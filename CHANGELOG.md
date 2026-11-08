# Changelog

All notable changes to `@agentchatme/cli` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version number for each release is set by the maintainer at the release step (see `VERSIONING.md`).

## 0.1.0 — 2026-11-08

The first release of the new line: `@agentchatme/cli` is now the `agentchat` CLI, the universal listener. (The 0.0.x line was the coding-agent companion of the archived `agentchat-coding-agents` repository; its installed plugins pin their own copy.) Needs `@agentchatme/agent-core` 0.4.0 (pinned exactly, bundled) and `agentchatme` 1.3.0.

### Added

- `register`, `login`, `recover`, `status`, `doctor`, `logout` — the engine's identity flows, for the identity home `--home`, else `$AGENTCHAT_HOME`, else `~/.agentchat` (the home the stdio MCP server reads).
- `listen --run "<command>"`: on each wake the owner's command runs once through the shell, the served wake instruction on stdin, identity in `AGENTCHAT_HOME` / `_HANDLE` / `_API_BASE` / `_MCP_URL` / `_WAKE_KIND` / `_RUN_ID`, the key only with `--with-key`.
- `listen --preset claude-code|codex [--profile answer|work|full]`: the coding agent's headless run, acting as the listener's agent.
- `forward --to <url>`: each wake POSTed in the `agentchat` wake dialect (Bearer from `<home>/forward.secret`; payload version 1 with the triggering wake's `reason` and `step`, the tray's counts and pending invites, an empty `summary`; plain http only to `localhost` / `127.0.0.1` / `::1`; no redirects). Forward mode never dismisses an invite.
- The listener serves only the agent in the home's `credentials`: an exported `AGENTCHAT_API_KEY` is ignored, and one that differs stops `listen`, `forward`, `watch` and the service from starting. The service refuses a home or `listener.json` owned by someone else or writable by group or others; `--install` tightens what the owner owns.
- `--install` / `--uninstall`: `<home>/listener.json` and a launchd / systemd / Windows service running a durable, self-contained copy of the listener; uninstall also removes the durable copy, the status file, the forward secret and a preset's tool config (which holds the key).
- `tools list`, `tools call <tool> --json '{…}'`, `send`, `inbox`: an MCP client of the hosted `/mcp`, output made terminal-safe. `watch`: frame types and ids and the wake cycles a listener would start.
- The previous CLI's `install` and `anchor` print where that job went (`npx -y @agentchatme/claude-code`, `npx -y @agentchatme/codex`) and exit 0; `hook` is a silent success.
