# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Discord bot that bridges Claude Code (via the Agent SDK) to Discord channels. Each Discord channel maps to a local project directory. Messages in a channel become Claude Code queries scoped to that project's working directory, with full tool access (file editing, bash, MCP servers, etc.).

## Commands

```bash
npm run start        # Run with tsx
npm run dev          # Run with tsx watch (auto-reload)
make start           # Run in background (uses setsid, writes PID to .pid)
make stop            # Stop background process
make restart         # Stop then start
make logs            # tail -f bot.logs
make kill-claude     # Kill orphaned Claude Code subprocesses
make add-project CHANNEL_ID=123  # Interactive: creates ~/projects/<name>/discord.json
```

No test suite or linter is configured.

## Architecture

**Entry flow:** `index.ts` → validates env vars, discovers projects, initializes SQLite session store, registers Discord slash commands, creates Discord client.

**Core loop** (`discord.ts`): On every `messageCreate`, looks up the channel in `ProjectRegistry`. If matched, downloads any attachments to `<project>/.discord-uploads/`, then calls `runQuery()` with the prompt. Only one query runs per channel at a time (`activeQueries` map). Responses are chunked to fit Discord's 2000-char limit with code block continuity handling (`formatter.ts`).

**Claude integration** (`claude.ts`): Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` function. Streams messages, collecting text from `assistant` events and metadata from the `result` event. Calls `q.close()` after receiving the result to avoid exit code issues when Discord.js WebSocket is active. The SDK reads `ANTHROPIC_API_KEY` from env directly.

**Project registry** (`projects.ts`): Scans `PROJECTS_DIR` (defaults to `~/projects`) for directories (or symlinks to directories) containing a `discord.json` file. Maps `channelId → ProjectConfig`. Each project can override model, permission mode, budget, and tool restrictions.

**Session persistence** (`sessions.ts`): SQLite database at `./data/sessions.db` with two tables: `sessions` (active session per channel) and `saved_sessions` (named snapshots). Sessions are Claude Agent SDK session IDs that enable conversation continuity. Corrupted/expired sessions are auto-cleared.

**Permission handling** (`permissions.ts`): Implements `CanUseTool` callback from the Agent SDK. Sends Discord embeds with Approve/Deny buttons (10-min timeout). Special handling for `AskUserQuestion` tool — renders options as clickable buttons and returns the selected answer.

**Slash commands** (`commands.ts`): Model and permission-mode overrides are stored in-memory maps (not persisted across restarts). Commands are registered globally via Discord REST API on every startup.

## Key Patterns

- TypeScript ESM (`"type": "module"` in package.json) — all local imports use `.js` extensions
- No build step in dev — runs directly via `tsx`
- Project data lives in `~/projects/`, outside this repo
- Runtime state (`data/`, `.pid`, `*.logs`) is gitignored
- Environment: `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `ANTHROPIC_API_KEY` (all required), `PROJECTS_DIR` (optional, defaults to `~/projects`)
