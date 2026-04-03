# claude-feishu-channel

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) channel plugin that bridges Feishu/Lark messages into your Claude Code session via MCP.

Chat with Claude directly from Feishu — messages are relayed in real-time over WebSocket.

## Modes

### Standalone (simple, single session)

Each Claude Code session runs its own MCP server with a dedicated Feishu WebSocket connection.

```
Feishu ──WebSocket──▶ server.ts (stdio MCP) ──▶ Claude Code
                           ◀──feishu_reply──
```

### Hub + Bridge (recommended, multi-session)

A single hub process holds all Feishu WebSocket connections and broadcasts messages to lightweight bridge processes — one per Claude Code session. Updating hub logic only requires restarting the hub, not any Claude session.

```
Feishu ──WebSocket──▶ hub.ts (HTTP, one per machine)
                           │ SSE broadcast
                    ┌──────┴──────┐
               bridge.ts      bridge.ts   …
            (stdio MCP)    (stdio MCP)
                 │               │
           Claude Code     Claude Code
```

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- [lark-cli](https://github.com/nicepkg/larksuite-cli) installed and configured
- A Feishu bot app with **WebSocket** mode enabled on [Feishu Open Platform](https://open.feishu.cn)

## Installation

```bash
git clone https://github.com/rollysys/claude-feishu-channel.git
cd claude-feishu-channel
npm install
```

## Feishu Bot Setup

1. Go to [Feishu Open Platform](https://open.feishu.cn) → create an enterprise self-built app.
2. Enable the **Bot** capability.
3. Under **Event Subscriptions** → select **WebSocket** mode (长连接).
4. Subscribe to `im.message.receive_v1`.
5. Grant scopes: `im:message`, `im:message.group_at_msg`, `im:message.p2p_msg`.

## Usage — Standalone Mode

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "feishu": {
      "command": "npx",
      "args": ["tsx", "/path/to/claude-feishu-channel/server.ts"],
      "env": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "your_secret"
      }
    }
  }
}
```

Start Claude Code with channel support:

```bash
claude --dangerously-load-development-channels server:feishu
```

## Usage — Hub + Bridge Mode

### 1. Start the hub (once per machine)

```bash
npm run hub
# or: npx tsx hub.ts
```

The hub listens on `http://127.0.0.1:3001` by default. Set `PORT` to change it.

For persistent operation, install as a launchd service (macOS):

```xml
<!-- ~/Library/LaunchAgents/com.claude.feishu-hub.plist -->
<key>ProgramArguments</key>
<array>
  <string>/opt/homebrew/bin/node</string>
  <string>/path/to/claude-feishu-channel/node_modules/.bin/tsx</string>
  <string>/path/to/claude-feishu-channel/hub.ts</string>
</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
```

### 2. Configure each project's `.mcp.json`

```json
{
  "mcpServers": {
    "feishu": {
      "command": "npx",
      "args": ["tsx", "/path/to/claude-feishu-channel/bridge.ts"],
      "env": {
        "FEISHU_APP_ID": "cli_xxx",
        "FEISHU_APP_SECRET": "your_secret",
        "FEISHU_HUB_URL": "http://localhost:3001"
      }
    }
  }
}
```

Each project can use a different bot (different `FEISHU_APP_ID`). The hub starts a new Feishu WebSocket connection automatically on first bridge connection for that app.

### 3. Start Claude Code

```bash
claude --dangerously-load-development-channels server:feishu
```

## Environment Variables

| Variable | Applies to | Default | Description |
|----------|-----------|---------|-------------|
| `FEISHU_APP_ID` | server, bridge | — | Feishu app ID |
| `FEISHU_APP_SECRET` | server, bridge | — | Feishu app secret |
| `FEISHU_HUB_URL` | bridge | `http://localhost:3001` | Hub base URL |
| `PORT` | hub | `3001` | Hub listen port |
| `LARK_CLI_PATH` | server, bridge | `lark-cli` | Path to lark-cli binary |

## How it works

When a Feishu user sends a message to the bot, the server (or hub) receives it via WebSocket, parses the content, replaces `@mention` placeholders with display names, and pushes it into Claude Code as a `<channel source="feishu">` event. Claude then replies using the `feishu_reply` MCP tool, which calls `lark-cli` to send the response back to Feishu.

In hub mode, messages are broadcast to all Claude sessions connected to the same bot simultaneously.

## License

MIT
