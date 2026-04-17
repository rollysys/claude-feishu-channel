# claude-feishu-channel

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) channel plugin that bridges Feishu/Lark messages into your Claude Code session via MCP.

Chat with Claude directly from Feishu — messages are relayed in real-time over WebSocket using the official `@larksuiteoapi/node-sdk`.

```
Feishu ──WebSocket──▶ feishu-mcp.ts (stdio MCP) ──▶ Claude Code
                           ◀──feishu_reply──
```

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
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
5. Grant scopes: `im:message`, `im:message.group_at_msg`, `im:message.p2p_msg`, `im:resource` (for file/image download), `im:message.reaction` (for ACK reaction).

## Usage

Copy the example config and fill in your app credentials:

```bash
cp .mcp.json.example .mcp.json
```

`.mcp.json` (gitignored — keep your secrets local):

```json
{
  "mcpServers": {
    "feishu": {
      "command": "npx",
      "args": ["tsx", "/path/to/claude-feishu-channel/feishu-mcp.ts"],
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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FEISHU_APP_ID` | yes | Feishu app ID (`cli_xxx`) |
| `FEISHU_APP_SECRET` | yes | Feishu app secret |
| `FEISHU_MCP_LOG` | no | Path to write logs to (default: stderr only) |

## How it works

When a Feishu user sends a message to the bot, `feishu-mcp.ts` receives it via WebSocket, converts the content (text / rich post / image / file / audio / video / sticker) to markdown, downloads attached resources to `~/.claude/channels/feishu/downloads/`, and pushes it into Claude Code as a `<channel source="feishu">` event. Claude then replies using the `feishu_reply` MCP tool — markdown tables are rendered as Feishu interactive cards, other replies as rich-text posts.

All Feishu API calls go through the official `@larksuiteoapi/node-sdk` — no external CLI dependency.

## Testing

```bash
npm test   # runs unit tests for markdown-utils.ts
```

## License

MIT
