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
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Config ──────────────────────────────────────────────────────────────────

const log = (...args: unknown[]) => console.error('[feishu]', ...args);

const LARK_CLI = process.env.LARK_CLI_PATH ?? 'lark-cli';

/**
 * Per-app lark-cli config isolation via LARKSUITE_CLI_CONFIG_DIR.
 * Each channel server gets its own config directory so lark-cli uses the
 * correct app credentials, even when multiple bots run on the same machine.
 */
function setupCliEnv(): Record<string, string> {
  const appId = process.env.FEISHU_APP_ID ?? '';
  const appSecret = process.env.FEISHU_APP_SECRET ?? '';
  if (!appId || !appSecret) return { ...process.env, NO_COLOR: '1' } as Record<string, string>;

  const configDir = join(homedir(), '.claude', 'channels', 'feishu', appId);
  const configFile = join(configDir, 'config.json');

  if (!existsSync(configFile)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(configFile, JSON.stringify({
      apps: [{
        appId,
        appSecret,
        brand: 'feishu',
      }],
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

/** Track latest message_id per chat for reply fallback */
const latestMessageIds = new Map<string, string>();

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
    // Resolve message_id: explicit > latest tracked > fallback to send
    const msgId = message_id || latestMessageIds.get(chat_id);
    // Encode content as base64 to avoid shell escaping issues
    const encodedText = Buffer.from(text).toString('base64');
    try {
      let args: string[];
      if (msgId) {
        args = ['im', '+messages-reply', '--as', 'bot', '--message-id', msgId, '--markdown-base64', encodedText];
      } else {
        args = ['im', '+messages-send', '--as', 'bot', '--chat-id', chat_id, '--markdown-base64', encodedText];
      }
      execFileSync(LARK_CLI, args, {
        encoding: 'utf-8',
        timeout: 15000,
        env: cliEnv,
      });
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

      // Parse content based on message_type
      let content = '';
      try {
        const parsed = JSON.parse(msg.content);
        if (msg.message_type === 'text') {
          content = parsed.text ?? '';
        } else if (msg.message_type === 'post') {
          // Rich text / post: extract text from nested structure
          // Format: { "zh_cn": { "title": "...", "content": [[{ "tag": "text", "text": "..." }, ...]] } }
          const post = parsed.zh_cn ?? parsed.en_us ?? parsed.ja_jp ?? Object.values(parsed)[0] as any;
          if (post && post.content) {
            const parts: string[] = [];
            if (post.title) parts.push(post.title);
            for (const line of post.content) {
              if (Array.isArray(line)) {
                for (const node of line) {
                  if (node.tag === 'text') parts.push(node.text ?? '');
                  else if (node.tag === 'a') parts.push(node.text ?? node.href ?? '');
                  else if (node.tag === 'at') { /* handled by mentions */ }
                }
              }
            }
            content = parts.join('').trim();
          }
        } else {
          // Other types: try generic extraction
          content = parsed.text ?? parsed.content ?? '';
        }
      } catch {
        content = msg.content;
      }

      // If content is empty/truncated, try fetching full message via API
      if (!content && msg.message_id && client) {
        try {
          const res = await client.request({
            method: 'GET',
            url: `/open-apis/im/v1/messages/${msg.message_id}`,
            params: { user_id_type: 'open_id' },
          }) as any;
          const items = res?.data?.items;
          if (items && items[0]?.body?.content) {
            try {
              const body = JSON.parse(items[0].body.content);
              content = body.text ?? '';
              if (!content && items[0].msg_type === 'post') {
                const post = body.zh_cn ?? body.en_us ?? Object.values(body)[0] as any;
                if (post?.content) {
                  const parts: string[] = [];
                  if (post.title) parts.push(post.title);
                  for (const line of post.content) {
                    if (Array.isArray(line)) {
                      for (const node of line) {
                        if (node.tag === 'text') parts.push(node.text ?? '');
                        else if (node.tag === 'a') parts.push(node.text ?? node.href ?? '');
                      }
                    }
                  }
                  content = parts.join('').trim();
                }
              }
            } catch { content = items[0].body.content; }
          }
          log('Fetched full message via API for', msg.message_id);
        } catch (e) {
          log('Failed to fetch full message:', e);
        }
      }

      // Replace @mention placeholders with display names
      for (const m of msg.mentions ?? []) {
        if (m.key) content = content.replace(m.key, m.name ? `@${m.name}` : '');
      }
      content = content.trim();

      if (!content) return;

      // Track latest message_id per chat for reply
      latestMessageIds.set(msg.chat_id, msg.message_id);

      // ACK: add "OnIt" reaction so the user knows the message was received
      try {
        execFileSync(LARK_CLI, [
          'im', 'reactions', 'create', '--as', 'bot',
          '--params', JSON.stringify({ message_id: msg.message_id }),
          '--data', JSON.stringify({ reaction_type: { emoji_type: 'OnIt' } }),
        ], { encoding: 'utf-8', timeout: 5000, env: cliEnv });
      } catch { /* best-effort, don't block on failure */ }

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
