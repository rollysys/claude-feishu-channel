#!/usr/bin/env npx tsx
/**
 * Feishu Channel Hub
 *
 * Manages Feishu WebSocket connections (one per bot) and distributes
 * incoming messages to connected bridge processes via SSE.
 *
 * Endpoints:
 *   GET  /events/:appId[?secret=APP_SECRET]   SSE stream of Feishu messages
 *   GET  /health                               Health check
 *
 * Usage: npx tsx hub.ts [--port 3001]
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3001);
const LARK_CLI = process.env.LARK_CLI_PATH ?? 'lark-cli';
const log = (...args: unknown[]) => console.error('[hub]', ...args);

// ─── Per-app state ────────────────────────────────────────────────────────────

interface BridgeClient {
  res: ServerResponse;
  id: string;
}

interface AppState {
  appId: string;
  appSecret: string;
  cliEnv: Record<string, string>;
  latestMessageIds: Map<string, string>;
  clients: Set<BridgeClient>;
  wsStarted: boolean;
}

const apps = new Map<string, AppState>();

// ─── lark-cli env isolation ───────────────────────────────────────────────────

function setupCliEnv(appId: string, appSecret: string): Record<string, string> {
  const configDir = join(homedir(), '.claude', 'channels', 'feishu', appId);
  const configFile = join(configDir, 'config.json');

  if (!existsSync(configFile)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(configFile, JSON.stringify({
      apps: [{ appId, appSecret, brand: 'feishu' }],
    }), { mode: 0o600 });
    log(`Created per-app lark-cli config: ${configDir}`);
  }

  return {
    ...process.env,
    LARKSUITE_CLI_CONFIG_DIR: configDir,
    NO_COLOR: '1',
  } as Record<string, string>;
}

function readStoredSecret(appId: string): string {
  const configFile = join(homedir(), '.claude', 'channels', 'feishu', appId, 'config.json');
  try {
    const cfg = JSON.parse(readFileSync(configFile, 'utf-8'));
    return cfg?.apps?.[0]?.appSecret ?? '';
  } catch {
    return '';
  }
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function sseWrite(res: ServerResponse, event: string, data: unknown) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* client disconnected */ }
}

// ─── Broadcast to bridge clients ──────────────────────────────────────────────

function broadcast(appState: AppState, event: string, data: unknown) {
  const dead: BridgeClient[] = [];
  for (const client of appState.clients) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      dead.push(client);
    }
  }
  for (const c of dead) appState.clients.delete(c);
}

// ─── Feishu WebSocket listener ────────────────────────────────────────────────

async function startFeishuListener(appState: AppState) {
  const { appId, appSecret } = appState;
  log('Starting Feishu WS for app:', appId);

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

      if (senderId === botOpenId) return;

      // Parse content
      let content = '';
      try {
        const parsed = JSON.parse(msg.content);
        if (msg.message_type === 'text') {
          content = parsed.text ?? '';
        } else if (msg.message_type === 'post') {
          const post = parsed.zh_cn ?? parsed.en_us ?? parsed.ja_jp ?? Object.values(parsed)[0] as any;
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
        } else {
          content = parsed.text ?? parsed.content ?? '';
        }
      } catch {
        content = msg.content;
      }

      // Fetch full message if empty
      if (!content && msg.message_id) {
        try {
          const res = await client.request({
            method: 'GET',
            url: `/open-apis/im/v1/messages/${msg.message_id}`,
            params: { user_id_type: 'open_id' },
          }) as any;
          const items = res?.data?.items;
          if (items?.[0]?.body?.content) {
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

      appState.latestMessageIds.set(msg.chat_id, msg.message_id);

      // ACK reaction
      try {
        execFileSync(LARK_CLI, [
          'im', 'reactions', 'create', '--as', 'bot',
          '--params', JSON.stringify({ message_id: msg.message_id }),
          '--data', JSON.stringify({ reaction_type: { emoji_type: 'OnIt' } }),
        ], { encoding: 'utf-8', timeout: 5000, env: appState.cliEnv });
      } catch { /* best-effort */ }

      log(`[${appId}] ${msg.chat_type} ${msg.chat_id} from=${senderId}: ${content.slice(0, 80)}`);

      broadcast(appState, 'feishu_message', {
        chat_id: msg.chat_id,
        chat_type: msg.chat_type === 'p2p' ? 'dm' : 'group',
        sender_id: senderId,
        message_id: msg.message_id,
        content_b64: Buffer.from(content).toString('base64'),
      });

      log(`Broadcast to ${appState.clients.size} bridge(s)`);
    },
  });

  const ws = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.WARN });
  await ws.start({ eventDispatcher: dispatcher });
  log('WebSocket connected for app:', appId);
  appState.wsStarted = true;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

let clientSeq = 0;

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // Health check
  if (parts[0] === 'health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, apps: Array.from(apps.keys()) }));
    return;
  }

  // GET /events/:appId[?secret=xxx]
  if (req.method === 'GET' && parts[0] === 'events' && parts[1]) {
    const appId = parts[1];
    const querySecret = url.searchParams.get('secret') ?? '';

    // Resolve or bootstrap app state
    let appState = apps.get(appId);
    if (!appState) {
      const appSecret = readStoredSecret(appId) || querySecret;
      if (!appSecret) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown app ${appId}. Pass ?secret=APP_SECRET on first connection.` }));
        return;
      }
      appState = {
        appId,
        appSecret,
        cliEnv: setupCliEnv(appId, appSecret),
        latestMessageIds: new Map(),
        clients: new Set(),
        wsStarted: false,
      };
      apps.set(appId, appState);
    }

    if (!appState.wsStarted) {
      appState.wsStarted = true; // prevent double-start
      startFeishuListener(appState).catch(e => {
        log('WS listener error:', e);
        appState!.wsStarted = false;
      });
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const clientId = `c${++clientSeq}`;
    const client: BridgeClient = { res, id: clientId };
    appState.clients.add(client);
    log(`Bridge ${clientId} connected for app ${appId}, total: ${appState.clients.size}`);

    // Send connected event with latest message IDs
    sseWrite(res, 'connected', {
      appId,
      latestMessageIds: Object.fromEntries(appState.latestMessageIds),
    });

    // Keep-alive ping every 30s
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(ping); }
    }, 30000);

    req.on('close', () => {
      clearInterval(ping);
      appState!.clients.delete(client);
      log(`Bridge ${clientId} disconnected for app ${appId}, remaining: ${appState!.clients.size}`);
    });

    return;
  }

  res.writeHead(404).end('Not found');
});

httpServer.listen(PORT, '127.0.0.1', () => {
  log(`Hub listening on http://127.0.0.1:${PORT}`);
  log('Bridge connects with: GET /events/APP_ID?secret=APP_SECRET');
});
