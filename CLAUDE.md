# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **channel plugin** (MCP server) that relays Feishu/Lark messages into a Claude Code session and sends replies back to Feishu. Single entry point: `feishu-mcp.ts`. Uses `@larksuiteoapi/node-sdk` for both inbound WebSocket and outbound REST — no external CLI dependency.

Node >= 22. TypeScript runs directly via `tsx` — no build step.

## Commands

```bash
npm install                          # install deps
npm run start                        # run feishu-mcp.ts standalone (reads FEISHU_APP_ID/SECRET from env)
npm test                             # unit tests for markdown-utils.ts
npx tsx test/markdown-utils.test.ts  # same as above
```

No lint/typecheck script. `tsconfig.json` is not used at runtime.

## Running as a channel

`feishu-mcp.ts` is a non-standard MCP server — it declares `capabilities.experimental['claude/channel'] = {}` and pushes inbound messages via the `notifications/claude/channel` MCP notification. Claude Code must be launched with:

```bash
claude --dangerously-load-development-channels server:feishu
```

Claude sees inbound messages as `<channel source="feishu">` tags and replies via the `feishu_reply` tool (`chat_id` required, `text` required, optional `message_id`).

`.mcp.json` is **gitignored**. `.mcp.json.example` is the template — copy it to `.mcp.json` and fill in `FEISHU_APP_ID` / `FEISHU_APP_SECRET` locally.

## Architecture

Single file does everything:

- **WebSocket inbound** — `lark.WSClient` + `lark.EventDispatcher` subscribe to `im.message.receive_v1`.
- **Message conversion** (`convertText` / `convertPost` / `convertImage` / `convertFile` / `convertAudio` / `convertVideo` / `convertSticker`) turns each Feishu `message_type` into markdown. Rich posts preserve bold/italic/code/links/mentions; media emits markdown placeholders plus a `resources[]` list for download.
- **Resource download** — files and images in `resources[]` are fetched via `GET /open-apis/im/v1/messages/:id/resources/:key` and saved to `~/.claude/channels/feishu/downloads/`. Paths are appended to the content as `📎 <path>` lines so Claude can reference them.
- **Outbound send/reply** — `sendReply` detects markdown tables via `markdown-utils.ts` and routes to interactive-card (`msg_type: "interactive"`) for tables, rich post (`msg_type: "post"` with `tag: "md"`) otherwise. Threading preference: explicit `message_id` arg → `latestMessageIds.get(chat_id)` → fall back to `messages-send` (new message).
- **ACK reaction** — best-effort `OnIt` emoji on every inbound, so users see the bot acknowledged their message. Failures are logged but not raised.
- **Self-loop guard** — messages with `sender_id === botOpenId` are dropped. `botOpenId` comes from `/open-apis/bot/v3/info` at startup.

## Important invariants

- **Threading** (`sendReply` → `replyMessage` vs `sendMessage`): if there's any known `message_id` for the chat, use `/messages/:id/reply` so replies land in the same thread. Only fall back to `/messages` when there's no history — typically only when the bot initiates an outbound message.
- **Markdown tables must go through cards.** Feishu's `post` format doesn't render tables; plain markdown tables inside a post become a blob of pipes. `hasMarkdownTable` in `markdown-utils.ts` gates the card path.
- **Mentions** — `convertPost` uses a two-layer fallback: `mentionsByOpenId` (built from `message.mentions[].id.open_id`) maps `<at user_id=...>` to the user's `@key`, and `resolveMentions` does a final string-replace to swap the `@_user_N` placeholder for `@DisplayName`. Both steps are needed because some message paths only populate one side.
- **Stdin close = exit.** `process.stdin.on('end')` triggers `process.exit(0)` — this is what prevents zombie MCP processes when Claude Code detaches.
- **WebSocket startup is non-fatal.** If WS fails, the MCP server stays up so outbound operations still work (per the comment at `main()`). Don't change this to hard-fail without a reason.

## When editing

- Pure logic (markdown parsing, card building) belongs in `markdown-utils.ts` and gets unit-tested. `feishu-mcp.ts` integration code is not unit-tested — changes there need manual verification against a real bot.
- Before adding a new message-type converter, check whether the Feishu payload shape is in the node SDK types; prefer using the SDK's typed request over raw `client.request`.
- The `instructions` string passed to `new Server(...)` is what Claude reads on connect — tool usage hints (e.g. "use `text` not `message`") go there.
