import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── Fake coding-agent binaries for the preset tests ────────────────────────
//
// Deterministic `claude` / `codex` stand-ins that model only what a preset
// touches — the version probe, the sign-in probe, and one headless run that
// records its argv, stdin, cwd and the AgentChat/runtime variables of its
// environment — so no test reaches a developer's real runtime or sign-in.
//
//   FAKE_RUNTIME_RECORD=<file>     where runs append their record (JSON lines)
//   FAKE_RUNTIME_LOGGED_OUT=1      the sign-in probe says no
//   FAKE_MCP_LIST=<json>           what `mcp list --json` prints (default: agentchat only).
//                                  A Codex answer run lists the servers first and switches
//                                  off each one but agentchat.
//   FAKE_MCP_LIST_MODE=fail|garbage   `mcp list` exits 1 / prints something not JSON
//   FAKE_MCP_LIST_RECORD=<file>    where `mcp list` appends its argv and cwd
//   FAKE_RUNTIME_FAIL_ON=<text>    a headless run whose prompt (stdin) contains
//                                  it fails the way a provider refusal does:
//                                  some output, `API Error: …`, exit 1. Any
//                                  other run (a runtime check's fixed prompt
//                                  included) answers.
//
// With `--output-format json` (Claude Code's runtime check) a run answers one
// result object shaped as Claude Code's: a finished turn (`num_turns` 1,
// `usage.output_tokens` ≥ 1), `is_error: true` when it fails. With `--json`
// (`codex exec`, its runtime check included) it prints Codex's events:
// thread.started, turn.started, then an agent_message item and turn.completed,
// or turn.failed when it fails.
//
// A run's record also says what its `--mcp-config` file held when it started
// (server names and the file mode, never its contents: it carries a key) and
// the text of its `--append-system-prompt-file`.

export interface FakeRuntime {
  readonly binDir: string
  readonly recordPath: string
}

export interface FakeRun {
  argv: string[]
  stdin: string
  cwd: string
  env: Record<string, string>
  /** What the run's `--mcp-config` file held when it started (names and mode only), `'unreadable'`, or null without one. */
  mcpConfig: { servers: string[]; mode: number } | 'unreadable' | null
  /** The text of the run's `--append-system-prompt-file` when it started, `'unreadable'`, or null without one. */
  appendedSystemPrompt: string | null
}

export interface FakeMcpList {
  argv: string[]
  cwd: string
}

export function readFakeMcpLists(file: string): FakeMcpList[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeMcpList)
}

function install(root: string, name: string, version: string, authArgs: [string, string], runArg: string): FakeRuntime {
  const binDir = path.join(root, 'fake-bin')
  const recordPath = path.join(root, `fake-${name}-runs.jsonl`)
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(
    path.join(binDir, name),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      'const args = process.argv.slice(2)',
      `if (args[0] === '--version') { console.log(${JSON.stringify(version)}); process.exit(0) }`,
      `if (args[0] === ${JSON.stringify(authArgs[0])} && args[1] === ${JSON.stringify(authArgs[1])}) {`,
      "  if (process.env.FAKE_RUNTIME_LOGGED_OUT === '1') { console.log('{\"loggedIn\":false}'); process.exit(1) }",
      "  console.log('{\"loggedIn\":true}'); process.exit(0)",
      '}',
      "if (args[0] === 'mcp' && args[1] === 'list') {",
      "  if (process.env.FAKE_MCP_LIST_RECORD) fs.appendFileSync(process.env.FAKE_MCP_LIST_RECORD, JSON.stringify({ argv: args, cwd: process.cwd() }) + '\\n')",
      "  if (process.env.FAKE_MCP_LIST_MODE === 'fail') { console.error('config error'); process.exit(1) }",
      "  if (process.env.FAKE_MCP_LIST_MODE === 'garbage') { console.log('not json'); process.exit(0) }",
      "  console.log(process.env.FAKE_MCP_LIST || JSON.stringify([{ name: 'agentchat', enabled: true }]))",
      '  process.exit(0)',
      '}',
      `if (args[0] === ${JSON.stringify(runArg)}) {`,
      "  const stdin = fs.readFileSync(0, 'utf8')",
      '  const env = {}',
      "  for (const [k, v] of Object.entries(process.env)) if (/^(AGENTCHAT_|CLAUDE|CODEX_)/.test(k)) env[k] = v",
      "  const at = args.indexOf('--mcp-config')",
      '  let mcpConfig = null',
      "  if (at >= 0) { try { const file = args[at + 1]; mcpConfig = { servers: Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}), mode: fs.statSync(file).mode & 0o777 } } catch { mcpConfig = 'unreadable' } }",
      "  const sp = args.indexOf('--append-system-prompt-file')",
      '  let appendedSystemPrompt = null',
      "  if (sp >= 0) { try { appendedSystemPrompt = fs.readFileSync(args[sp + 1], 'utf8') } catch { appendedSystemPrompt = 'unreadable' } }",
      '  const record = { argv: args, stdin, cwd: process.cwd(), env, mcpConfig, appendedSystemPrompt }',
      "  if (process.env.FAKE_RUNTIME_RECORD) fs.appendFileSync(process.env.FAKE_RUNTIME_RECORD, JSON.stringify(record) + '\\n')",
      "  const fails = Boolean(process.env.FAKE_RUNTIME_FAIL_ON) && stdin.includes(process.env.FAKE_RUNTIME_FAIL_ON)",
      "  const json = args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'json'",
      "  const events = args.includes('--json')",
      "  const ev = (o) => JSON.stringify(o) + '\\n'",
      "  if (json) process.stdout.write(ev({ type: 'result', subtype: 'success', is_error: fails, duration_ms: 1200, num_turns: 1, result: 'model output that must be discarded', session_id: 'fake-session', total_cost_usd: 0, usage: { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: fails ? 0 : 2 } }))",
      "  else if (events) process.stdout.write(ev({ type: 'thread.started', thread_id: 't1' }) + ev({ type: 'turn.started' }) + (fails ? ev({ type: 'turn.failed', error: { message: 'the provider refused this request' } }) : ev({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'model output that must be discarded' } }) + ev({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 0, output_tokens: 2 } })))",
      "  else process.stdout.write('model output that must be discarded\\n')",
      "  if (fails) { console.error('API Error: the provider refused this request'); process.exit(1) }",
      '  process.exit(0)',
      '}',
      `console.error('unsupported fake ${name} command: ' + args.join(' '))`,
      'process.exit(2)',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  // Windows resolves bare commands through PATHEXT rather than shebangs.
  fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\nnode "%~dp0${name}" %*\r\n`)
  return { binDir, recordPath }
}

export const installFakeClaude = (root: string): FakeRuntime => install(root, 'claude', '2.1.316 (Claude Code)', ['auth', 'status'], '-p')
export const installFakeCodex = (root: string): FakeRuntime => install(root, 'codex', 'codex-cli 0.154.0', ['login', 'status'], 'exec')

export function readFakeRuns(fake: FakeRuntime): FakeRun[] {
  if (!fs.existsSync(fake.recordPath)) return []
  return fs
    .readFileSync(fake.recordPath, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeRun)
}
