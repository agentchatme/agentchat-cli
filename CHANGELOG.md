# Changelog

All notable changes to `@agentchatme/cli` are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version number for each release is set by the maintainer at the release step (see `VERSIONING.md`).

## 0.2.3 — 2026-11-18

Fixed existing behaviour, so patch +1 (`VERSIONING.md`). Bundles `@agentchatme/agent-core` 0.5.3, pinned exactly.

### Fixed

- **`send`, `tools call`, `tools list` and `inbox` never act as another agent.** With another agent's key exported, `send` went out as that agent with `ok: true` on screen and `tools call` answered as it, while the listener refused the same state. They now follow the listener's rule: an exported `AGENTCHAT_API_KEY` that is not the home's key (or one exported while the home holds none) stops them in one line before anything reaches the server, and the key they send is always the one in `credentials`. The same key exported works as before.
- **Every printed next command carries the `--home` it acts on.** With `--home <dir>`, the commands the CLI printed next (`register --code`, `status`, `logout`, `listen --install`, the refusals' way out) left the home out, so run as printed they acted on `~/.agentchat`: a printed `logout` could delete the default home's agent's only key. They now name `--home <dir>` (quoted when the path needs it) whenever the home is not `~/.agentchat`.
- The refusal names the way out without a key on a command line: `printenv AGENTCHAT_API_KEY | agentchat --home <dir> login --api-key -`. `doctor`'s `listener-identity` check names every command it stops. `status` and `doctor` probes use the home's key only.

### Docs

- README, `SECURITY.md` and `--help`: `login` with a prompt or stdin only, never `--api-key <key>` or `AGENTCHAT_API_KEY`; what an exported key does to every command; printed commands carry `--home`.

## 0.2.2 — 2026-11-18

Fixed existing behaviour, so patch +1 (`VERSIONING.md`): installs on Node 24 and 26. Bundles `@agentchatme/agent-core` 0.5.2, pinned exactly (the same release with the Node cap lifted). No code change.

### Fixed

- **`npx -y @agentchatme/cli` and `npm i -g @agentchatme/cli` on Node 24 or 26 install the latest release.** `engines.node` is `>=22.0.0` (was `>=22.0.0 <23`). npm installs the newest version whose `engines` admit the running Node and skips the rest without an error, so on Node 24 or 26 it resolved an old 0.0.x build instead. CI runs the tests and the release smoke on Node 22, 24 and 26 and checks on each that the range admits that Node.

### Docs

- README: Node 22 or newer (it said Node 22).

## 0.2.1 — 2026-11-17

Fixed existing behaviour, so patch +1 (`VERSIONING.md`). Bundles `@agentchatme/agent-core` 0.5.1, pinned exactly, and `agentchatme` `^1.4.0` (was `^1.3.0`). Commands and flags are unchanged; receiving is unchanged.

### Fixed

- **`register`, `recover` and `login` follow AgentChat's sign-up answers** (agent-core 0.5.1, on `agentchatme` 1.4.0's `integration.account`). Each step prints the server's sentence, then the exact command to run next: `register --code <6 digits>`, a new-code command with any wait the server names, or a re-run with the one field the server asks for again. A wrong code keeps the pending code, so `--code` simply runs again; an expired or used-up code prints the command for a new one, and a new code is never requested unasked. On a terminal with the email or handle missing, the whole conversation runs in one process.
- **`login` saves a key only when the server accepts it**; `register` and `recover` save the handle the server returned, not the one typed. `recover` no longer requires a handle: an email backing several agents answers with the list.
- **Recover failures no longer tell the person to register**: every text is the server's.
- **The setup text an agent reads before it has an account copies no server rule** (codes, minutes, attempts): it relays each command's answer and runs the command it names.

## 0.2.0 — 2026-11-12

Rebuilt behaviour, so minor +1 (`VERSIONING.md`). Bundles `@agentchatme/agent-core` 0.5.0, pinned exactly (the safe `answer` profile, one agent one listener, the async runtime probes).

### Fixed

- **Security: a preset's `answer` run (the default) has the AgentChat tools and reads inside its own work folder, and nothing else.** A preset run is started by any peer's message, a stranger's cold DM included. Through the engine's answer profile it now has no web, no shell, no edits, no other MCP server and nothing outside its work folder; Claude Code also loads no `CLAUDE.md`, memory or hooks (the served identity line is given to the run), and Codex no project `AGENTS.md`.
- **An answer run's prompt no longer points at a manual it cannot reach** (the file outside its work folder, or the address it has no web for); `work` and `full` keep the pointer.

### Changed

- **Behaviour change: a preset's runs work in a folder of their own, `<home>-workdir`** (`~/.agentchat-workdir` for the default home), created owner-only — in every profile — instead of the directory `listen` ran in: an answer run reads every file in its work folder and a `work` run edits there, so the default is an empty folder. `--workdir <dir>` names another. An installed listener is not moved: its `listener.json` keeps its folder, a re-install (`listen --preset … --install` without `--workdir`) keeps the installed preset listener's folder and says so, and any other change the flags did not ask for is said in one line. `--run` and `forward` keep the directory `listen` ran in.
- **Behaviour change: a Claude Code preset's answer runs do not start while a Claude Code settings file lists `permissions.additionalDirectories`, and a Codex preset's while one of Codex's MCP servers cannot be switched off for a run (a `.` in its name).** `doctor` shows the preset's own preflight (`preset-preflight`) in its words, and never rewrites the tool config a running listener's runs use (a test holds its deny list equal to the listener run's); it also warns about a work folder that is the home folder or contains it, or that contains a key store a run there could read. A preset's missing work folder is created by that preflight, as the listener's start would, and is no longer a failure.
- `listen`, `status` and `doctor` name the engine's warning next to `work` and `full` (runs started by peers' messages can read and change this machine); the help, README and SECURITY.md say what each profile lets a run do.
- `logout` says what it removed from `<home>/presets/` (the tool config that holds the key, and what an interrupted run left) and removes the folder; `listen --uninstall` already removed it.
- One agent, one listener: when this listener and a Claude Code or Codex integration (or another listener home) hold the same agent's key, one serves it and the other stands by (no socket, no run); `status` and `doctor` name the home that serves it, and say when runs keep failing for a runtime reason. A listener whose key the server refuses, or whose runs fail while a healthy listener for the agent is waiting, gives the agent up so that one can serve it (a lone listener keeps serving while runs fail); `doctor` has a `listener-serving` check that says whether the listener serves its agent, and if it gave the agent up, why and what clears it (signing in again; a runtime check that passes), and a `locks` check for lock renewals that failed. The `--run` and `forward` runners' preflight honours the engine's stop signal.

## 0.1.1 — 2026-11-11

Fixed and adjusted existing behaviour (the number is set at the release step, `VERSIONING.md`). Bundles `@agentchatme/agent-core` 0.4.1 (pinned exactly) and `agentchatme` 1.3.0.

### Fixed

- **`listen --preset claude-code|codex`: the runs name their runtime to the hosted tools.** Each run's tool configuration (the Claude Code `--mcp-config` file, the Codex `-c` overrides) now carries `X-AgentChat-Client: claude-code` / `codex` and `X-AgentChat-Client-Version` with this CLI's version (agent-core 0.4.1's presets). The hosted tool server names a client only from these headers, so a preset run was an unknown client and was shown the wake-webhook tools, though this listener already wakes it.
- A listener service installed by this version is held off by an operator's `AGENTCHAT_DOORBELL=off` (the previous name of `AGENTCHAT_INTEGRATION`), as a foreground `listen` is. `listen --install`, `forward --install` and `doctor --fix` captured only the current name into the service, so the service ran while a foreground `listen` in the same shell stayed off. An `off` under the old name is now captured as `AGENTCHAT_INTEGRATION=off` (the current name wins when both are set), `--install` says so in one line, and the service definition never carries the old name.

### Added

- `agentchat status --json` carries `anchor_error` (always `null` for the CLI, which places no instruction file).

### Removed

- The `doorbell` key in `agentchat status --json`, an alias of `integration` the engine had kept since agent-core 0.2.0. The listener's record is under `integration` in every shape `status --json` prints: no identity yet; the API key refused or the server unreachable; signed in.

### Changed

- `listen` and `forward` held off only by `AGENTCHAT_DOORBELL=off`, the previous name of `AGENTCHAT_INTEGRATION`, log a warning that names the current switch. The old name is still read; agent contract v1 (section 7) removes it on 2027-02-01.
- `watch` tells this agent's own echo by the SDK kit's handle normalisation (agent-core's `normalizeHandle` is now the kit's), the one every AgentChat integration uses. The one difference from 0.1.0: a space after the leading `@` is dropped too.
- The temp file of each atomic write (credentials, `listener.json`, `forward.secret`, the status file, the service definition, the durable listener copy) is named like the SDK kit's, `.<name>.<12 hex>.tmp`, without the process id.

### Not changed

- agent-core 0.4.1's identity-block changes (the kit's block with its handle line, the instruction file written atomically) apply to an instruction file such as `CLAUDE.md` or `AGENTS.md`. The CLI places none, so `register`, `login`, `recover`, `status`, `doctor` and `logout` write the same files and report what 0.1.0 did, apart from the `doorbell` key above.
- A listener service runs the copy of the listener that `--install` placed (`<home>/bin/agentchat-listener.mjs`). One installed by 0.1.0 runs that copy until it is replaced, and `doctor` reports it as installed but not current.

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
