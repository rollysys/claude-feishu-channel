#!/usr/bin/env npx tsx
/**
 * Feishu Channel MCP Server for Claude Code
 *
 * Self-contained MCP server: receives Feishu messages via node SDK WebSocket,
 * sends replies via node SDK API. No hub, no bridge, no lark-cli dependency.
 *
 * .mcp.json:
 *   {
 *     "mcpServers": {
 *       "feishu": {
 *         "command": "npx",
 *         "args": ["tsx", "/Users/x/claude-feishu-channel/feishu-mcp.ts"],
 *         "env": {
 *           "FEISHU_APP_ID": "cli_xxx",
 *           "FEISHU_APP_SECRET": "yyy"
 *         }
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as lark from '@larksuiteoapi/node-sdk';
import { mkdirSync, writeFileSync, createWriteStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseMarkdownSegments, hasMarkdownTable, buildCardJson, normalizeTaskList } from './markdown-utils.js';

// ─── Config ──────────────────────────────────────────────────────────────────

// Load .env from current working directory (MCP server inherits cwd from Claude Code).
// Node's loadEnvFile does not override already-set vars, so .mcp.json env wins if provided.
const envFile = join(process.cwd(), '.env');
if (existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch (e) {
    console.error(`[feishu-mcp] Failed to load ${envFile}:`, e instanceof Error ? e.message : e);
  }
}

const APP_ID = process.env.FEISHU_APP_ID ?? '';
const APP_SECRET = process.env.FEISHU_APP_SECRET ?? '';
const LOG_FILE = process.env.FEISHU_MCP_LOG ?? '';

if (!APP_ID || !APP_SECRET) {
  console.error(`[feishu-mcp] Missing FEISHU_APP_ID / FEISHU_APP_SECRET.
Expected in ${envFile} with format:
  FEISHU_APP_ID=cli_xxx
  FEISHU_APP_SECRET=xxx`);
  process.exit(1);
}

// ─── Logger ──────────────────────────────────────────────────────────────────

import { appendFileSync } from 'node:fs';

function log(...args: unknown[]) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `[${ts}] [feishu-mcp] ` + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.error(line);
  if (LOG_FILE) try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ─── Lark SDK Client ─────────────────────────────────────────────────────────

const client = new lark.Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  disableTokenCache: false,
});

let botOpenId = '';
let botName = '';

async function probeBotInfo() {
  try {
    const res = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }) as {
      bot?: { open_id?: string; app_name?: string };
    };
    botOpenId = res?.bot?.open_id ?? '';
    botName = res?.bot?.app_name ?? '';
    if (!botOpenId) {
      log('Bot probe returned no open_id — refusing to start (self-loop guard needs botOpenId to filter bot-authored messages).');
      process.exit(1);
    }
    log(`Bot: ${botName} (${botOpenId})`);
  } catch (e) {
    log('Bot probe failed:', e instanceof Error ? e.message : String(e));
    log('Refusing to start — cannot guarantee self-loop protection without botOpenId.');
    process.exit(1);
  }
}

// ─── Message Converters (inbound) ────────────────────────────────────────────

interface ConvertResult {
  content: string;
  resources: Array<{ type: string; fileKey: string; fileName?: string }>;
}

type MentionMap = Map<string, { key: string; name: string }>;

function buildMentionMap(mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>): MentionMap {
  const map: MentionMap = new Map();
  for (const m of mentions ?? []) {
    const openId = m.id?.open_id;
    if (openId && m.key) {
      map.set(openId, { key: m.key, name: m.name ?? openId });
    }
  }
  return map;
}

function resolveMentions(text: string, mentions?: Array<{ key?: string; name?: string }>): string {
  let result = text;
  for (const m of mentions ?? []) {
    if (m.key) result = result.replace(m.key, m.name ? `@${m.name}` : '');
  }
  return result;
}

function safeParse(raw: string): Record<string, unknown> | undefined {
  try { return JSON.parse(raw); } catch { return undefined; }
}

function convertText(raw: string, mentions?: Array<{ key?: string; name?: string }>): ConvertResult {
  const parsed = safeParse(raw) as { text?: string } | undefined;
  const text = parsed?.text ?? raw;
  return { content: resolveMentions(text, mentions), resources: [] };
}

interface PostElement {
  tag: string;
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  image_key?: string;
  file_key?: string;
  language?: string;
  style?: string[];
}

function convertPost(raw: string, mentions?: Array<{ key?: string; name?: string }>, mentionsByOpenId?: MentionMap): ConvertResult {
  const rawParsed = safeParse(raw);
  if (!rawParsed) return { content: '[rich text]', resources: [] };

  // Unwrap locale
  let post: { title?: string; content?: PostElement[][] } | undefined;
  if ('title' in rawParsed || 'content' in rawParsed) {
    post = rawParsed as any;
  } else {
    for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
      if (rawParsed[locale] && typeof rawParsed[locale] === 'object') {
        post = rawParsed[locale] as any;
        break;
      }
    }
    if (!post) {
      const first = Object.values(rawParsed)[0];
      if (first && typeof first === 'object') post = first as any;
    }
  }
  if (!post) return { content: '[rich text]', resources: [] };

  const resources: ConvertResult['resources'] = [];
  const lines: string[] = [];

  if (post.title) lines.push(`**${post.title}**`, '');

  for (const paragraph of post.content ?? []) {
    if (!Array.isArray(paragraph)) continue;
    let line = '';
    for (const el of paragraph) {
      switch (el.tag) {
        case 'text': {
          let text = el.text ?? '';
          if (el.style?.includes('bold')) text = `**${text}**`;
          if (el.style?.includes('italic')) text = `*${text}*`;
          if (el.style?.includes('codeInline')) text = `\`${text}\``;
          line += text;
          break;
        }
        case 'a':
          line += el.href ? `[${el.text ?? el.href}](${el.href})` : (el.text ?? '');
          break;
        case 'at': {
          const userId = el.user_id ?? '';
          if (userId === 'all') { line += '@all'; break; }
          const info = mentionsByOpenId?.get(userId);
          line += info ? info.key : `@${el.user_name ?? userId}`;
          break;
        }
        case 'img':
          if (el.image_key) {
            resources.push({ type: 'image', fileKey: el.image_key });
            line += `![image](${el.image_key})`;
          }
          break;
        case 'media':
          if (el.file_key) {
            resources.push({ type: 'file', fileKey: el.file_key });
            line += `[file:${el.file_key}]`;
          }
          break;
        case 'code_block':
          line += `\n\`\`\`${el.language ?? ''}\n${el.text ?? ''}\n\`\`\`\n`;
          break;
        case 'hr':
          line += '\n---\n';
          break;
        default:
          line += el.text ?? '';
      }
    }
    lines.push(line);
  }

  let content = lines.join('\n').trim() || '[rich text]';
  content = resolveMentions(content, mentions);
  return { content, resources };
}

function convertImage(raw: string): ConvertResult {
  const parsed = safeParse(raw) as { image_key?: string } | undefined;
  const imageKey = parsed?.image_key;
  if (!imageKey) return { content: '[image]', resources: [] };
  return {
    content: `![image](${imageKey})`,
    resources: [{ type: 'image', fileKey: imageKey }],
  };
}

function convertFile(raw: string): ConvertResult {
  const parsed = safeParse(raw) as { file_key?: string; file_name?: string } | undefined;
  const fileKey = parsed?.file_key;
  if (!fileKey) return { content: '[file]', resources: [] };
  const fileName = parsed?.file_name ?? '';
  return {
    content: `[文件] ${fileName || fileKey}`,
    resources: [{ type: 'file', fileKey, fileName: fileName || undefined }],
  };
}

function convertAudio(raw: string): ConvertResult {
  const parsed = safeParse(raw) as { file_key?: string; duration?: number } | undefined;
  const fileKey = parsed?.file_key;
  if (!fileKey) return { content: '[audio]', resources: [] };
  const dur = parsed?.duration ? ` (${Math.ceil(parsed.duration / 1000)}s)` : '';
  return {
    content: `[语音${dur}] ${fileKey}`,
    resources: [{ type: 'audio', fileKey }],
  };
}

function convertVideo(raw: string): ConvertResult {
  const parsed = safeParse(raw) as { file_key?: string; image_key?: string } | undefined;
  const fileKey = parsed?.file_key;
  if (!fileKey) return { content: '[video]', resources: [] };
  return {
    content: `[视频] ${fileKey}`,
    resources: [{ type: 'video', fileKey }],
  };
}

function convertSticker(raw: string): ConvertResult {
  const parsed = safeParse(raw) as { file_key?: string } | undefined;
  return { content: `[表情] ${parsed?.file_key ?? ''}`.trim(), resources: [] };
}

function convertMessage(messageType: string, content: string, mentions?: Array<{ key?: string; id?: { open_id?: string }; name?: string }>): ConvertResult {
  const mentionsByOpenId = buildMentionMap(mentions);
  const simpleMentions = mentions?.map(m => ({ key: m.key, name: m.name }));

  switch (messageType) {
    case 'text': return convertText(content, simpleMentions);
    case 'post': return convertPost(content, simpleMentions, mentionsByOpenId);
    case 'image': return convertImage(content);
    case 'file': return convertFile(content);
    case 'audio': return convertAudio(content);
    case 'video': return convertVideo(content);
    case 'sticker': return convertSticker(content);
    default: {
      const parsed = safeParse(content);
      const text = (parsed as any)?.text ?? (parsed as any)?.content ?? `[${messageType}]`;
      return { content: String(text), resources: [] };
    }
  }
}

// ─── Resource Download ───────────────────────────────────────────────────────

const DOWNLOAD_DIR = join(homedir(), '.claude', 'channels', 'feishu', 'downloads');

async function downloadResource(messageId: string, res: { type: string; fileKey: string; fileName?: string }): Promise<string> {
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const fileName = res.fileName ?? res.fileKey;
  const localPath = join(DOWNLOAD_DIR, fileName);

  try {
    const resp = await client.request({
      method: 'GET',
      url: `/open-apis/im/v1/messages/${messageId}/resources/${res.fileKey}`,
      params: { type: res.type === 'image' ? 'image' : 'file' },
      dataType: 'blob',
    }) as unknown;

    // Handle Blob/ArrayBuffer/Buffer responses
    let buffer: Buffer;
    if (resp instanceof Buffer) {
      buffer = resp;
    } else if (resp instanceof ArrayBuffer) {
      buffer = Buffer.from(resp);
    } else if (typeof Blob !== 'undefined' && resp instanceof Blob) {
      buffer = Buffer.from(await resp.arrayBuffer());
    } else if (resp && typeof resp === 'object' && 'data' in resp) {
      // Some SDK versions wrap in { data: Buffer }
      const data = (resp as any).data;
      if (data instanceof Buffer) buffer = data;
      else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
      else buffer = Buffer.from(String(data));
    } else {
      buffer = Buffer.from(String(resp));
    }

    writeFileSync(localPath, buffer);
    log(`Downloaded ${res.type}: ${localPath} (${buffer.length} bytes)`);
    return localPath;
  } catch (e) {
    log(`Download failed for ${res.fileKey}:`, e instanceof Error ? e.message : String(e));
    return '';
  }
}

// ─── Outbound: Send/Reply via SDK ────────────────────────────────────────────

async function sendReply(chatId: string, inboundMessageId: string | undefined, text: string): Promise<string> {
  // α flow: all replies are interactive cards so they can be patched. If a
  // thinking-card is already live for this inbound message, we patch that card
  // into the final response. Otherwise fall back to a fresh reply/send.
  const cardJson = buildCardJson(parseMarkdownSegments(normalizeTaskList(text)));

  const entry = inboundMessageId ? pendingAcks.get(inboundMessageId) : undefined;
  if (entry) {
    clearTimeout(entry.timer);
    pendingAcks.delete(inboundMessageId!);
    try {
      await patchCard(entry.cardMessageId, cardJson);
      log(`Patched ACK card ${entry.cardMessageId} for inbound ${inboundMessageId}`);
      return entry.cardMessageId;
    } catch (e) {
      log('patch failed, falling back to new reply:', e instanceof Error ? e.message : String(e));
    }
  }

  return inboundMessageId
    ? await replyMessage(inboundMessageId, 'interactive', cardJson)
    : await sendMessage(chatId, 'interactive', cardJson);
}

async function sendMessage(chatId: string, msgType: string, content: string): Promise<string> {
  try {
    const res = await client.request({
      method: 'POST',
      url: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content,
      },
    }) as any;
    const msgId = res?.data?.message_id ?? '';
    log(`Sent message to ${chatId}: ${msgId}`);
    return msgId;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('Send failed:', msg);
    throw new Error(`Send failed: ${msg}`);
  }
}

async function replyMessage(messageId: string, msgType: string, content: string): Promise<string> {
  try {
    const res = await client.request({
      method: 'POST',
      url: `/open-apis/im/v1/messages/${messageId}/reply`,
      data: {
        msg_type: msgType,
        content,
      },
    }) as any;
    const msgId = res?.data?.message_id ?? '';
    log(`Replied to ${messageId}: ${msgId}`);
    return msgId;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log('Reply failed:', msg);
    throw new Error(`Reply failed: ${msg}`);
  }
}

async function patchCard(cardMessageId: string, content: string): Promise<void> {
  await client.request({
    method: 'PATCH',
    url: `/open-apis/im/v1/messages/${cardMessageId}`,
    data: { content },
  });
}

// ─── ACK card lifecycle ──────────────────────────────────────────────────────
// Every inbound message triggers an immediate "thinking" card. The card's
// message_id is stored so that when Claude calls feishu_reply, we PATCH the
// same card into the final response (instead of sending a separate message).
// If Claude never replies within the timeout, the card is patched into a
// timeout state so the user is not left staring at a spinner.

interface PendingAck {
  cardMessageId: string;
  timer: NodeJS.Timeout;
}
const pendingAcks = new Map<string, PendingAck>();
const ACK_TIMEOUT_MS = 5 * 60 * 1000;

const THINKING_CARD = JSON.stringify({
  config: { wide_screen_mode: true, update_multi: true },
  elements: [{ tag: 'markdown', content: '🤔 Claude 正在思考...' }],
});
const TIMEOUT_CARD = JSON.stringify({
  config: { wide_screen_mode: true, update_multi: true },
  elements: [{ tag: 'markdown', content: '⏱️ Claude 5 分钟内未回复，请重试' }],
});

// ─── MCP Server ──────────────────────────────────────────────────────────────

const latestMessageIds = new Map<string, string>();

const server = new Server(
  { name: 'feishu', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: `You have a Feishu (飞书) channel connected. When you see a <channel source="feishu"> tag, it contains a message from a Feishu user.

To reply to the user, call the feishu_reply tool. Parameters:
  - chat_id (required): from the <channel> tag
  - text (required): reply content, supports markdown
  - message_id (optional): om_xxx, to reply in thread

⚠️ MUST use "text" parameter — NOT "message" or "content".

Always reply in the same language the user used.

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
    log('reply preview:', text.slice(0, 200).replace(/\n/g, '\\n'));
    try {
      const sentId = await sendReply(chat_id, msgId, text);
      return { content: [{ type: 'text', text: `Reply sent to ${chat_id} (${sentId})` }] };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log('reply error:', msg);
      return { content: [{ type: 'text', text: `Failed to send reply: ${msg}` }] };
    }
  }
  throw new Error(`Unknown tool: ${req.params.name}`);
});

// ─── Feishu WebSocket Listener ───────────────────────────────────────────────

async function startFeishuWebSocket() {
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
      sender: { sender_id?: { open_id?: string }; sender_type: string };
    }) => {
      const msg = data.message;
      const senderId = data.sender?.sender_id?.open_id ?? '';

      // Ignore bot's own messages
      if (senderId === botOpenId) return;

      // Convert message
      const { content, resources } = convertMessage(msg.message_type, msg.content, msg.mentions);
      if (!content.trim()) return;

      // Download resources (files/images)
      const downloadedPaths: string[] = [];
      for (const res of resources) {
        const path = await downloadResource(msg.message_id, res);
        if (path) downloadedPaths.push(path);
      }

      // Build final content with download paths
      let finalContent = content;
      if (downloadedPaths.length > 0) {
        finalContent += '\n' + downloadedPaths.map(p => `📎 ${p}`).join('\n');
      }

      // Track latest message ID
      latestMessageIds.set(msg.chat_id, msg.message_id);

      // Send "thinking" ACK card and arm a timeout. The card's message_id is
      // stored in pendingAcks so sendReply can PATCH it in place when Claude
      // responds, producing the impression of a single evolving message.
      try {
        const ackCardId = await sendMessage(msg.chat_id, 'interactive', THINKING_CARD);
        const timer = setTimeout(() => {
          // sendReply clears the timer + deletes the entry when Claude actually
          // replies. If the timer callback fires after that (clearTimeout races
          // a fired callback), skip so we don't overwrite Claude's real reply.
          if (!pendingAcks.has(msg.message_id)) return;
          pendingAcks.delete(msg.message_id);
          patchCard(ackCardId, TIMEOUT_CARD)
            .then(() => log(`[timeout] patched ACK card ${ackCardId} for inbound ${msg.message_id}`))
            .catch(e => log('timeout patch failed:', e instanceof Error ? e.message : String(e)));
        }, ACK_TIMEOUT_MS);
        timer.unref(); // don't hold the event loop open on shutdown
        pendingAcks.set(msg.message_id, { cardMessageId: ackCardId, timer });
      } catch (e) {
        log('ACK card send failed:', e instanceof Error ? e.message : String(e));
        // Continue to notify Claude even without an ACK card — sendReply will
        // fall back to a fresh reply in that case.
      }

      log(`[msg] ${msg.chat_type} ${msg.chat_id} from=${senderId} type=${msg.message_type}: ${finalContent.slice(0, 80)}`);

      // Push to Claude via MCP notification
      try {
        await server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: finalContent,
            meta: {
              chat_id: msg.chat_id,
              chat_type: msg.chat_type === 'p2p' ? 'dm' : 'group',
              sender_id: senderId,
              message_id: msg.message_id,
            },
          },
        });
        log('notification sent ok');
      } catch (e) {
        log('notification error:', e instanceof Error ? e.message : String(e));
      }
    },
  });

  const ws = new lark.WSClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    loggerLevel: lark.LoggerLevel.WARN,
  });

  log('Starting WebSocket connection...');
  await ws.start({ eventDispatcher: dispatcher });
  log('WebSocket connected');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server started, app:', APP_ID);

  // Exit when parent disconnects (stdin closes) — prevents zombie processes
  process.stdin.on('end', () => { log('stdin closed, exiting'); process.exit(0); });
  process.stdin.on('error', () => { process.exit(0); });

  // Probe bot info
  await probeBotInfo();

  // Start WebSocket listener
  try {
    await startFeishuWebSocket();
  } catch (e) {
    log('WebSocket start failed:', e instanceof Error ? e.message : String(e));
    // Don't exit — MCP server still works for outbound operations
  }
}

main().catch(e => {
  console.error('[fatal]', e);
  process.exit(1);
});
