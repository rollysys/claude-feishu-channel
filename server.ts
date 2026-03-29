#!/usr/bin/env npx tsx
/**
 * Feishu Channel Plugin for Claude Code
 *
 * An MCP server that bridges Feishu/Lark messages into Claude Code sessions.
 * Feishu users send messages to the bot → pushed into Claude Code as <channel> events.
 * Claude replies via the feishu_reply tool → sent back to Feishu.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as lark from '@larksuiteoapi/node-sdk';
import { execFileSync } from 'node:child_process';

// ─── Config ──────────────────────────────────────────────────────────────────

const log = (...args: unknown[]) => console.error('[feishu]', ...args);

const LARK_CLI = process.env.LARK_CLI_PATH ?? 'lark-cli';

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'feishu', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
      },
      tools: {},
    },
    instructions: `You have a Feishu (飞书) channel connected. When you see a <channel source="feishu"> tag, it contains a message from a Feishu user.

To reply to the user, call the feishu_reply tool with the chat_id and your message text. Always reply in the same language the user used.

If the user asks you to perform Feishu operations (send messages to others, check calendar, create docs, manage tasks, etc.), you can use lark-cli commands via the Bash tool — lark-cli is already configured.`,
  },
);

// ─── Reply Tool ──────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'feishu_reply',
      description: 'Reply to a Feishu message. Use this to respond to messages from the feishu channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'The chat_id from the inbound message' },
          text: { type: 'string', description: 'Reply text (supports markdown)' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'feishu_reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string };
    try {
      const args = ['im', '+messages-send', '--as', 'bot', '--chat-id', chat_id, '--markdown', text];
      execFileSync(LARK_CLI, args, {
        encoding: 'utf-8',
        timeout: 15000,
        env: { ...process.env, NO_COLOR: '1' },
      });
      log('reply sent to', chat_id);
      return { content: [{ type: 'text', text: `Reply sent to ${chat_id}` }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log('reply error:', msg);
      return { content: [{ type: 'text', text: `Failed to send reply: ${msg}` }] };
    }
  }
  throw new Error(`Unknown tool: ${req.params.name}`);
});

// ─── Feishu WebSocket Inbound ────────────────────────────────────────────────

async function startFeishuListener() {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    log('Missing FEISHU_APP_ID or FEISHU_APP_SECRET environment variables.');
    log('See .env.example for configuration.');
    return;
  }

  log('Connecting as app:', appId);

  // Probe bot identity
  const client = new lark.Client({ appId, appSecret, disableTokenCache: false });
  let botOpenId = '';
  try {
    const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }) as {
      bot?: { open_id?: string; app_name?: string };
    };
    botOpenId = res?.bot?.open_id ?? '';
    log('Bot:', res?.bot?.app_name, `(${botOpenId})`);
  } catch (e) {
    log('Failed to probe bot info:', e);
  }

  // Set up event dispatcher
  const dispatcher = new lark.EventDispatcher({});

  dispatcher.register({
    'im.message.receive_v1': async (data: {
      message: {
        message_id: string;
        chat_id: string;
        chat_type: string;
        message_type: string;
        content: string;
        mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>;
      };
      sender: {
        sender_id?: { open_id?: string };
        sender_type: string;
      };
    }) => {
      const msg = data.message;
      const senderId = data.sender?.sender_id?.open_id ?? '';

      // Skip messages from self
      if (senderId === botOpenId) return;

      // Parse content
      let content = '';
      try {
        const parsed = JSON.parse(msg.content);
        content = parsed.text ?? parsed.content ?? msg.content;
      } catch {
        content = msg.content;
      }

      // Strip @mention placeholders
      for (const m of msg.mentions ?? []) {
        if (m.key) content = content.replace(m.key, '').trim();
      }

      if (!content) return;

      log(`[msg] ${msg.chat_type} ${msg.chat_id} from=${senderId}: ${content.slice(0, 80)}`);

      // Push event into Claude Code session
      await server.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            chat_id: msg.chat_id,
            chat_type: msg.chat_type === 'p2p' ? 'dm' : 'group',
            sender_id: senderId,
            message_id: msg.message_id,
          },
        },
      });
    },
  });

  // Start WebSocket
  const ws = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.WARN,
  });
  await ws.start({ eventDispatcher: dispatcher });
  log('WebSocket connected, listening for messages...');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server started');

  startFeishuListener().catch((e) => log('Feishu listener error:', e));
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
