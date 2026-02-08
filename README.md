# Claude Discord Gateway

**Chat with Claude Code through Discord. One channel = one project. That's it.**

```
Discord #finance channel  →  local ~/projects/finance/
Discord #portfolio channel  →  local ~/projects/portfolio/
```

One command to add a project. One command to start the bot. That's it.

## Why This Exists

Claude Code is powerful but lives in your terminal. This gateway lets you talk to it from Discord — from your phone, your desktop, anywhere. Each channel is its own isolated workspace with persistent memory.

## What You Get

- Full Claude Code capabilities (file editing, bash, web search, MCP servers)
- Conversations persist across restarts
- Approve/deny tool usage with Discord buttons
- Upload files directly in chat
- Works with your existing `CLAUDE.md` and `.claude/settings.json`

## Use Cases

- **Investment Assistant** — market research with persistent memory
- **DevOps Bot** — deployments from your phone
- **Research Agent** — database access via MCP servers
- **Personal Assistant** — tasks and file management

## Prerequisites

- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)
- A Discord bot ([create one here](https://discord.com/developers/applications))

## Setup

### 1. Clone and install

```bash
git clone https://github.com/AntSan813/claude-discord-gateway.git
cd claude-discord-gateway
npm install
```

### 2. Configure Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application (or use existing)
3. Go to **Bot** → copy the **Token**
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permissions: Send Messages, Read Message History, Embed Links, Attach Files, Use Slash Commands
6. Open the generated URL to invite the bot to your server

### 3. Create environment file

```bash
cp .env.example .env
```

Edit `.env`:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_APPLICATION_ID=your_application_id
ANTHROPIC_API_KEY=your_anthropic_key
```

### 4. Add a project

Get your channel ID (right-click channel in Discord → Copy Channel ID), then:

```bash
make add-project CHANNEL_ID=1234567890
# Enter project name: finance
# Link to existing directory? (leave empty to create new): /path/to/my/finance-project
```

This creates `~/projects/finance/` (symlink or folder) with a `discord.json` file.

### 5. Run the bot

```bash
# Background mode (recommended)
make start

# View logs
make logs

# Stop
make stop
```

## Adding More Channels

```bash
make add-project CHANNEL_ID=your_channel_id
# Follow the prompts
make restart
```

### Optional: Customize Project Config

Edit `~/projects/your-project/discord.json`:

```json
{
  "channelId": "1234567890123456789",
  "model": "claude-sonnet-4-5-20250929",
  "permissionMode": "acceptEdits",
  "maxBudgetUsd": 5.0
}
```

| Field             | Default     | Description                                                                  |
| ----------------- | ----------- | ---------------------------------------------------------------------------- |
| `model`           | SDK default | `claude-sonnet-4-5-20250929`, `claude-opus-4-6`, `claude-haiku-4-5-20251001` |
| `permissionMode`  | `default`   | `default`, `acceptEdits`, `bypassPermissions`, `plan`                        |
| `maxBudgetUsd`    | unlimited   | Cost cap per query                                                           |
| `allowedTools`    | all         | Restrict to specific tools                                                   |
| `disallowedTools` | none        | Block specific tools                                                         |

## Project Configuration

Each project uses Claude Code's native configuration:

- **`CLAUDE.md`** — project memory, persona, instructions
- **`.claude/settings.json`** — MCP servers, permission rules, subagents

Example `.claude/settings.json` with MCP:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": [
        "-y",
        "@anthropic-ai/mcp-server-postgres",
        "postgresql://localhost:5432/mydb"
      ]
    }
  }
}
```

## Slash Commands

| Command                   | Description                                                |
| ------------------------- | ---------------------------------------------------------- |
| `/new [save_as]`          | Start fresh. Optionally save current session with a label. |
| `/resume [label]`         | List saved sessions, or resume one by label.               |
| `/status`                 | Show project and session info.                             |
| `/cost`                   | Show cost of last query.                                   |
| `/config`                 | Show full project config and active overrides.             |
| `/model <name>`           | Switch model (Sonnet/Opus/Haiku).                          |
| `/permission-mode <mode>` | Switch permission mode for this channel.                   |
| `/abort`                  | Cancel the running query.                                  |
| `//projects`              | List all registered /projects.                             |
| `/rescan`                 | Re-scan for new /projects.                                 |
| `/help`                   | List all commands.                                         |

### Named Sessions

Save and switch between conversations within the same channel:

```
/new save_as:auth-bug     → saves current session as "auth-bug", starts fresh
/resume                   → lists all saved sessions
/resume label:auth-bug    → switches back to "auth-bug" conversation
```

Each response includes context window usage in the footer (e.g., `42k/200k context`) so you can see how much of the model's context is being used.
