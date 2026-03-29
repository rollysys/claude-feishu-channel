# claude-feishu-channel

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) channel plugin that bridges Feishu/Lark messages into your Claude Code session via MCP.

Chat with Claude directly from Feishu — messages are relayed in real-time over WebSocket.

## How it works

```
Feishu User ──WebSocket──▶ MCP Server ──stdio──▶ Claude Code
                                ◀──feishu_reply──
```

1. The plugin connects to Feishu via WebSocket (long polling) and listens for messages sent to your bot.
2. Incoming messages are pushed into the Claude Code session as `<channel source="feishu">` events.
3. Claude replies by calling the `feishu_reply` tool, which sends the response back via `lark-cli`.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- [lark-cli](https://github.com/nicepkg/larksuite-cli) installed and configured (`lark-cli config init && lark-cli auth login`)
- A Feishu bot app with **WebSocket** mode enabled in [Feishu Open Platform Console](https://open.feishu.cn)

## Setup

1. Clone the repo:

```bash
git clone https://github.com/rollysys/claude-feishu-channel.git
cd claude-feishu-channel
npm install
```

2. Copy `.env.example` to `.env` and fill in your Feishu app credentials:

```bash
cp .env.example .env
```

3. Copy `.mcp.json` to your project directory (or `~/.claude/`) and fill in the env values:

```bash
cp .mcp.json /path/to/your/project/.mcp.json
# Edit the FEISHU_APP_ID and FEISHU_APP_SECRET values
```

4. Start Claude Code — the plugin will connect automatically.

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `FEISHU_APP_ID` | Yes | Feishu app ID from open.feishu.cn |
| `FEISHU_APP_SECRET` | Yes | Feishu app secret |
| `LARK_CLI_PATH` | No | Path to lark-cli binary (default: `lark-cli`) |

## Feishu Bot Setup

1. Go to [Feishu Open Platform](https://open.feishu.cn) and create an app (or use an existing one).
2. Enable the **Bot** capability.
3. Under **Event Subscriptions**, enable **WebSocket** mode (长连接模式).
4. Subscribe to the `im.message.receive_v1` event.
5. Grant the required scopes: `im:message`, `im:message.group_at_msg`, `im:message.p2p_msg`.

## License

MIT
