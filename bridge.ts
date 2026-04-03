#!/usr/bin/env npx tsx
/**
 * Feishu Channel Bridge — stdio MCP server for Claude Code
 *
 * Subscribes to hub.ts SSE event stream and forwards Feishu messages
 * into Claude Code sessions as <channel source="feishu"> events.
 * Replies via lark-cli directly (no round-trip through hub).
 *
 * .mcp.json:
 *   {
 *     "command": "npx",
 *     "args": ["tsx", "/Users/x/claude-feishu-channel/bridge.ts"],
 *     "env": {
 *       "FEISHU_APP_ID": "cli_xxx",
 *       "FEISHU_APP_SECRET": "yyy",
 *       "FEISHU_HUB_URL": "http://localhost:3001"   (optional, default shown)
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Config ──────────────────────────────────────────────────────────────────

import { appendFileSync } from 'node:fs';
const LOG_FILE = process.env.BRIDGE_LOG ?? '';
const log = (...args: unknown[]) => {
  const line = '[bridge] ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.error(line);
  if (LOG_FILE) try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
};
const LARK_CLI = process.env.LARK_CLI_PATH ?? 'lark-cli';
const HUB_URL = process.env.FEISHU_HUB_URL ?? 'http://localhost:3001';
const APP_ID = process.env.FEISHU_APP_ID ?? '';
const APP_SECRET = process.env.FEISHU_APP_SECRET ?? '';

if (!APP_ID || !APP_SECRET) {
  console.error('[bridge] Missing FEISHU_APP_ID or FEISHU_APP_SECRET');
  process.exit(1);
}

// ─── lark-cli env isolation ───────────────────────────────────────────────────

function setupCliEnv(): Record<string, string> {
  const configDir = join(homedir(), '.claude', 'channels', 'feishu', APP_ID);
  const configFile = join(configDir, 'config.json');

  if (!existsSync(configFile)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(configFile, JSON.stringify({
      apps: [{ appId: APP_ID, appSecret: APP_SECRET, brand: 'feishu' }],
    }), { mode: 0o600 });
    log(`Created per-app lark-cli config: ${configDir}`);
  }

  return {
    ...process.env,
    LARKSUITE_CLI_CONFIG_DIR: configDir,
    NO_COLOR: '1',
  } as Record<string, string>;
}

const cliEnv = setupCliEnv();
const latestMessageIds = new Map<string, string>();

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'feishu', version: '0.3.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `You have a Feishu (飞书) channel connected. When you see a <channel source="feishu"> tag, it contains a message from a Feishu user.

To reply to the user, call the feishu_reply tool with the chat_id and your message text. Always reply in the same language the user used.

If the user asks you to perform Feishu operations (send messages to others, check calendar, create docs, manage tasks, etc.), you can use lark-cli commands via the Bash tool — lark-cli is already configured.`,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'feishu_reply',
      description: 'Reply to a Feishu message. Use this to respond to messages from the feishu channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'The chat_id from the inbound message' },
          message_id: { type: 'string', description: 'The message_id to reply to (om_xxx)' },
          text: { type: 'string', description: 'Reply text (supports markdown)' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'feishu_reply') {
    const { chat_id, message_id, text } = req.params.arguments as {
      chat_id: string; message_id?: string; text: string;
    };
    const msgId = message_id || latestMessageIds.get(chat_id);
    const encodedText = Buffer.from(text).toString('base64');
    try {
      const args = msgId
        ? ['im', '+messages-reply', '--as', 'bot', '--message-id', msgId, '--markdown-base64', encodedText]
        : ['im', '+messages-send', '--as', 'bot', '--chat-id', chat_id, '--markdown-base64', encodedText];
      execFileSync(LARK_CLI, args, { encoding: 'utf-8', timeout: 15000, env: cliEnv });
      log('reply sent to', chat_id, msgId ? `(reply to ${msgId})` : '(new message)');
      return { content: [{ type: 'text', text: `Reply sent to ${chat_id}` }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log('reply error:', msg);
      return { content: [{ type: 'text', text: `Failed to send reply: ${msg}` }] };
    }
  }
  throw new Error(`Unknown tool: ${req.params.name}`);
});

// ─── Hub SSE client ───────────────────────────────────────────────────────────

const RECONNECT_DELAY = 3000;

async function connectToHub(): Promise<void> {
  const url = `${HUB_URL}/events/${APP_ID}?secret=${encodeURIComponent(APP_SECRET)}`;
  log('Connecting to hub:', `${HUB_URL}/events/${APP_ID}`);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
    });
  } catch (e) {
    log('Hub connection failed:', e instanceof Error ? e.message : e);
    throw e;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Hub returned ${res.status}: ${body}`);
  }

  log('Connected to hub');

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  // SSE parser state
  let eventType = '';
  let dataLines: string[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { log('Hub SSE stream ended'); break; }

      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n');

      for (const raw of lines) {
        const line = raw.trimEnd();

        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        } else if (line === '') {
          // Dispatch event
          if (eventType && dataLines.length) {
            const rawData = dataLines.join('\n');
            try {
              await handleHubEvent(eventType, JSON.parse(rawData));
            } catch (e) {
              log('Event handler error:', e);
            }
          }
          eventType = '';
          dataLines = [];
        }
        // Lines starting with ':' are comments/pings — ignore
      }
    }
  } finally {
    reader.cancel();
  }
}

async function handleHubEvent(event: string, data: Record<string, unknown>) {
  if (event === 'connected') {
    log('Hub acknowledged connection for app:', data.appId);
    // Restore latestMessageIds from hub state
    const ids = data.latestMessageIds as Record<string, string> | undefined;
    if (ids) {
      for (const [chatId, msgId] of Object.entries(ids)) {
        latestMessageIds.set(chatId, msgId);
      }
    }
    return;
  }

  if (event === 'feishu_message') {
    const { chat_id, chat_type, sender_id, message_id, content_b64 } = data as {
      chat_id: string;
      chat_type: string;
      sender_id: string;
      message_id: string;
      content_b64: string;
    };
    const content = Buffer.from(content_b64, 'base64').toString('utf-8');

    latestMessageIds.set(chat_id, message_id);

    log(`[msg] ${chat_type} ${chat_id} from=${sender_id}: ${content.slice(0, 80)}`);

    try {
      await server.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: { chat_id, chat_type, sender_id, message_id },
        },
      });
      log('notification sent ok');
    } catch (e) {
      log('notification error:', e instanceof Error ? e.message : String(e));
    }
  }
}

async function connectWithRetry(): Promise<never> {
  while (true) {
    try {
      await connectToHub();
    } catch (e) {
      log('Disconnected from hub, retrying in', RECONNECT_DELAY / 1000, 's...');
    }
    await new Promise(r => setTimeout(r, RECONNECT_DELAY));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP bridge started, app:', APP_ID);

  connectWithRetry().catch(e => log('Fatal hub error:', e));
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
