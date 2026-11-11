import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { main, normalizeArgv } from '../src/main.js'
import { configFromFlags, runListen } from '../src/listen.js'
import { bindPositionals, renderResult } from '../src/tools.js'
import { terminalSafe } from '../src/terminal.js'
import { durableListenerPath, invocation, manualPathFor, resolveHome, serviceEnvFrom, serviceLabelForHome } from '../src/home.js'
import { homeLabel, listenerChecks, removeKeyFiles } from '../src/identity.js'
import { envKeyConflict, listenerFilesProblem, ownerOnlyProblem, tightenListenerFiles } from '../src/guards.js'
import { listenerConfigPath, writeListenerConfig } from '../src/listener/config.js'
import { readListenerConfig } from '../src/listener/config.js'
import { alwaysOnWanted, writeIntegrationStatus, type IntegrationStatus } from '@agentchatme/agent-core'
import { claudeMcpConfigPath } from '@agentchatme/agent-core/presets'
import { INBOX_TOOL, SEND_TOOL, startMcpDouble, type McpDouble } from './helpers/mcp-double.js'

// ─── The `agentchat` CLI: its arguments, the tools through it, install ──────

const KEY = 'ac_live_' + 'c'.repeat(40)
let tmp: string
let home: string
let saved: Record<string, string | undefined>
let out: string[]
let err: string[]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-cli-'))
  home = path.join(tmp, 'agentchat-home')
  fs.mkdirSync(home, { recursive: true })
  saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'], DRY: process.env['AGENTCHAT_SERVICE_DRY_RUN'], KEY: process.env['AGENTCHAT_API_KEY'], AH: process.env['AGENTCHAT_HOME'] }
  // A sandbox HOME and a dry-run service manager: no real launchd/systemd job is ever touched.
  process.env['HOME'] = path.join(tmp, 'user')
  process.env['USERPROFILE'] = path.join(tmp, 'user')
  process.env['AGENTCHAT_SERVICE_DRY_RUN'] = '1'
  delete process.env['AGENTCHAT_API_KEY']
  delete process.env['AGENTCHAT_HOME']
  fs.mkdirSync(path.join(tmp, 'user'), { recursive: true })
  out = []
  err = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')))
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const [k, v] of [['HOME', saved['HOME']], ['USERPROFILE', saved['USERPROFILE']], ['AGENTCHAT_SERVICE_DRY_RUN', saved['DRY']], ['AGENTCHAT_API_KEY', saved['KEY']], ['AGENTCHAT_HOME', saved['AH']]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const signIn = (apiBase: string): void => fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe', api_base: apiBase }))

describe('arguments', () => {
  it('the home: --home, else AGENTCHAT_HOME, else ~/.agentchat', () => {
    expect(resolveHome('/x/y', {})).toBe(path.resolve('/x/y'))
    expect(resolveHome(undefined, { AGENTCHAT_HOME: '/z' })).toBe(path.resolve('/z'))
    expect(resolveHome(undefined, {})).toBe(path.join(os.homedir(), '.agentchat'))
    expect(homeLabel(path.join(os.homedir(), '.agentchat'))).toBe(`~${path.sep}.agentchat`)
  })

  it('the invocation follows how it was started', () => {
    expect(invocation({})).toBe('agentchat')
    expect(invocation({ npm_command: 'exec' })).toBe('npx -y @agentchatme/cli')
    expect(invocation({ AGENTCHAT_CLI_NAME: 'ac' })).toBe('ac')
  })

  it('`tools call --json <args>` reads the value as the arguments; elsewhere --json is a switch', () => {
    expect(normalizeArgv(['--home', '/h', 'tools', 'call', 'x', '--json', '{}'])).toEqual(['--home', '/h', 'tools', 'call', 'x', '--args', '{}'])
    expect(normalizeArgv(['tools', 'call', 'x', '--json={"a":1}'])).toEqual(['tools', 'call', 'x', '--args={"a":1}'])
    expect(normalizeArgv(['status', '--json'])).toEqual(['status', '--json'])
  })

  it('listen/forward flags become one config, or one clear refusal', () => {
    const io = { env: {}, cwd: tmp }
    const run = configFromFlags('listen', { run: 'my-agent --once', budget: '30' }, io)
    expect(run).toMatchObject({ ok: true, config: { mode: 'run', command: 'my-agent --once', workdir: tmp, budget_ms: 30_000, with_key: false } })
    expect(configFromFlags('listen', { preset: 'codex', profile: 'work', workdir: 'sub' }, io)).toMatchObject({ ok: true, config: { mode: 'preset', preset: 'codex', profile: 'work', workdir: path.join(tmp, 'sub') } })
    expect(configFromFlags('listen', { preset: 'claude-code' }, { env: { AGENTCHAT_RUN_PROFILE: 'full' }, cwd: tmp })).toMatchObject({ ok: true, config: { profile: 'full' } })
    expect(configFromFlags('forward', { to: 'http://localhost:9/w' }, io)).toMatchObject({ ok: true, config: { mode: 'forward', url: 'http://localhost:9/w' } })

    const refused = (built: ReturnType<typeof configFromFlags>): string => (built.ok ? 'accepted' : built.error)
    expect(refused(configFromFlags('listen', {}, io))).toMatch(/Missing what to run/)
    expect(refused(configFromFlags('listen', { run: 'a', preset: 'codex' }, io))).toMatch(/not both/)
    expect(refused(configFromFlags('listen', { preset: 'nope' }, io))).toMatch(/unknown preset "nope" \(presets: claude-code, codex\)/)
    expect(refused(configFromFlags('listen', { run: 'a', profile: 'work' }, io))).toMatch(/belongs to a preset/)
    expect(refused(configFromFlags('listen', { preset: 'codex', withKey: true }, io))).toMatch(/belongs to --run/)
    expect(refused(configFromFlags('listen', { run: 'a', budget: '0' }, io))).toMatch(/seconds/)
    expect(refused(configFromFlags('forward', { to: 'http://example.com/x' }, io))).toMatch(/only to this machine/)
    expect(refused(configFromFlags('forward', {}, io))).toMatch(/Missing --to/)
  })

  it('--help and --version answer without a home; an unknown command says so', async () => {
    expect(await main(['--version'])).toBe(0)
    expect(await main(['--help'])).toBe(0)
    expect(out.join('\n')).toContain('listen --run "<command>"')
    expect(await main(['frobnicate'])).toBe(1)
    expect(err.join('\n')).toMatch(/Unknown command: frobnicate/)
    expect(await main(['listen', 'my-agent'])).toBe(1)
    expect(err.join('\n')).toMatch(/quote the command/)
  })
})

describe('the hosted tools from a shell', () => {
  let mcp: McpDouble
  beforeEach(async () => {
    mcp = await startMcpDouble({ tools: [SEND_TOOL, INBOX_TOOL] })
    signIn(mcp.apiBase)
  })
  afterEach(async () => mcp.close())

  it('tools list prints names and first lines; --json prints the server\'s definitions as given', async () => {
    expect(await main(['--home', home, 'tools', 'list'])).toBe(0)
    expect(out.join('\n')).toMatch(/agentchat_send_message\s+Send a text message on AgentChat\./)
    out.length = 0
    expect(await main(['--home', home, 'tools', 'list', '--json'])).toBe(0)
    expect(JSON.parse(out.join('\n'))).toEqual([SEND_TOOL, INBOX_TOOL])
  })

  it('tools call passes --json through untouched', async () => {
    expect(await main(['--home', home, 'tools', 'call', 'agentchat_inbox', '--json', '{"limit":3,"timeout_seconds":0}'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toEqual({ name: 'agentchat_inbox', arguments: { limit: 3, timeout_seconds: 0 } })
    expect(await main(['--home', home, 'tools', 'call', 'agentchat_inbox', '--json', '[1]'])).toBe(1)
    expect(err.join('\n')).toMatch(/JSON object/)
  })

  it('send binds its words to the required parameters in the schema\'s order; inbox looks once', async () => {
    expect(await main(['--home', home, 'send', '@peer', 'hello', 'there'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toEqual({ name: 'agentchat_send_message', arguments: { to: '@peer', text: 'hello there' } })
    expect(await main(['--home', home, 'send', '@peer', 'again', '--reply-to', 'msg_1'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toMatchObject({ arguments: { to: '@peer', text: 'again', reply_to: 'msg_1' } })
    expect(await main(['--home', home, 'send', '@peer'])).toBe(1)
    expect(await main(['--home', home, 'inbox'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toEqual({ name: 'agentchat_inbox', arguments: { timeout_seconds: 0 } })
    expect(await main(['--home', home, 'inbox', '--wait', '20', '--limit', '5'])).toBe(0)
    expect(mcp.seen[mcp.seen.length - 1]?.params).toEqual({ name: 'agentchat_inbox', arguments: { timeout_seconds: 20, limit: 5 } })
  })

  it('a tool error exits 1; what a peer wrote is printed terminal-safe', async () => {
    mcp.set({ call: () => ({ content: [{ type: 'text', text: 'peer says \u001B]0;pwned\u0007hi\u001B[2J there' }] }) })
    expect(await main(['--home', home, 'inbox'])).toBe(0)
    expect(out[out.length - 1]).toBe('peer says hi there')
    mcp.set({ call: () => ({ content: [{ type: 'text', text: 'AWAITING_REPLY' }], isError: true }) })
    expect(await main(['--home', home, 'send', '@peer', 'x'])).toBe(1)
  })

  it('the key never reaches the output', async () => {
    await main(['--home', home, 'tools', 'list', '--json'])
    await main(['--home', home, 'inbox', '--raw'])
    expect([...out, ...err].join('\n')).not.toContain(KEY)
  })
})

describe('pure helpers', () => {
  it('bindPositionals: the last required parameter takes the rest; none required is refused', () => {
    expect(bindPositionals({ name: 't', inputSchema: { required: ['a', 'b'] } }, ['1', '2', '3'])).toEqual({ a: '1', b: '2 3' })
    expect(bindPositionals({ name: 't', inputSchema: { required: ['a', 'b'] } }, ['1'])).toBeInstanceOf(Error)
    expect(bindPositionals({ name: 't', inputSchema: {} }, ['1'])).toBeInstanceOf(Error)
  })

  it('renderResult: text items, else the structured part, else a placeholder', () => {
    expect(renderResult({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(renderResult({ content: [], structuredContent: { ok: true } })).toBe('{\n  "ok": true\n}')
    expect(renderResult({ content: [{ type: 'image' }] })).toBe('[image content]')
  })

  it('terminalSafe keeps newlines and tabs, drops escapes and controls', () => {
    expect(terminalSafe('a\tb\nc\u001B[31mred\u001B[0m\u0007\u009B2J\r')).toBe('a\tb\ncred')
  })
})

describe('listen --install / --uninstall (dry run, sandbox HOME)', () => {
  const io = (extra: Record<string, unknown> = {}) => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: tmp, ...extra })

  it('writes listener.json, a durable copy and the service definition; uninstall removes the service and the copy, keeps the config', async () => {
    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '// the shipped listener bundle\n')
    expect(await runListen(home, 'listen', { run: 'my-agent --once', install: true }, io({ shipped }))).toBe(0)
    expect(readListenerConfig(home)).toMatchObject({ ok: true, config: { mode: 'run', command: 'my-agent --once', workdir: tmp } })
    expect(fs.readFileSync(durableListenerPath(home), 'utf-8')).toContain('shipped listener bundle')
    expect(alwaysOnWanted(home)).toBe(true)
    expect(out.join('\n')).toMatch(new RegExp(`Listener installed \\(${serviceLabelForHome(home)}\\)`))
    expect(out.join('\n')).toMatch(/idles until this home has an identity/)
    if (process.platform === 'darwin') {
      const plist = fs.readFileSync(path.join(tmp, 'user', 'Library', 'LaunchAgents', `me.agentchat.${serviceLabelForHome(home)}.plist`), 'utf-8')
      expect(plist).toContain(durableListenerPath(home))
      expect(plist).toContain(home)
      // The command lives in listener.json, never in the service definition.
      expect(plist).not.toContain('my-agent')
    }

    // `listen --install` alone re-installs what is saved.
    out.length = 0
    expect(await runListen(home, 'listen', { install: true }, io({ shipped }))).toBe(0)
    expect(out.join('\n')).toContain('runs `my-agent --once`')

    expect(await runListen(home, 'listen', { uninstall: true }, io())).toBe(0)
    expect(fs.existsSync(durableListenerPath(home))).toBe(false)
    expect(alwaysOnWanted(home)).toBe(false)
    expect(readListenerConfig(home).ok).toBe(true)
  })

  it('an off under the switch\'s previous name is captured under the current one, never dropped; the unit never carries the old name', async () => {
    expect(serviceEnvFrom({ AGENTCHAT_DOORBELL: 'off' })).toEqual({ AGENTCHAT_INTEGRATION: 'off' })
    expect(serviceEnvFrom({ AGENTCHAT_DOORBELL: 'off', AGENTCHAT_INTEGRATION: 'on' })).toEqual({ AGENTCHAT_INTEGRATION: 'on' })
    expect(serviceEnvFrom({ AGENTCHAT_DOORBELL: 'off', AGENTCHAT_INTEGRATION: 'off' })).toEqual({ AGENTCHAT_INTEGRATION: 'off' })
    expect(serviceEnvFrom({ AGENTCHAT_DOORBELL: 'on' })).toEqual({})
    expect(serviceEnvFrom({})).toEqual({})

    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '//\n')
    expect(await runListen(home, 'listen', { run: 'my-agent --once', install: true }, io({ shipped, env: { AGENTCHAT_DOORBELL: 'off' } }))).toBe(0)
    expect(out.join('\n')).toMatch(/Held off: AGENTCHAT_DOORBELL=off, the old name of AGENTCHAT_INTEGRATION, is captured as AGENTCHAT_INTEGRATION=off .*; set AGENTCHAT_INTEGRATION=off instead/)
    // The definition the dry run wrote under the sandbox HOME, on every OS: a
    // launchd plist, a systemd user unit, or the Windows Startup launcher.
    const written = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? written(path.join(dir, e.name)) : [fs.readFileSync(path.join(dir, e.name), 'utf-8')]))
    const definition = written(path.join(tmp, 'user')).filter((text) => text.includes(durableListenerPath(home)) || text.includes(serviceLabelForHome(home))).join('\n')
    expect(definition).toMatch(/AGENTCHAT_INTEGRATION(?:<\/key>\s*<string>|=|"\) = ")off/)
    expect(definition).not.toContain('AGENTCHAT_DOORBELL')

    // The value as the operator wrote it.
    out.length = 0
    expect(await runListen(home, 'listen', { install: true }, io({ shipped, env: { AGENTCHAT_DOORBELL: 'false' } }))).toBe(0)
    expect(out.join('\n')).toContain('Held off: AGENTCHAT_DOORBELL=false,')

    // The current name set: nothing to capture, no line.
    out.length = 0
    expect(await runListen(home, 'listen', { install: true }, io({ shipped, env: { AGENTCHAT_INTEGRATION: 'off' } }))).toBe(0)
    expect(out.join('\n')).not.toContain('Held off')
  })

  // Pinned on purpose, so that changing it is a decision and not an accident:
  // every `listen --install` (and `doctor --fix`) writes the definition again
  // from the shell that runs it. A switch captured earlier is not carried
  // forward — an `off` set at one install is gone after an install from a
  // shell without it.
  it('a later install from a shell without the switch writes the definition without it', async () => {
    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '//\n')
    const written = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? written(path.join(dir, e.name)) : [fs.readFileSync(path.join(dir, e.name), 'utf-8')]))
    const definition = (): string => written(path.join(tmp, 'user')).filter((text) => text.includes(durableListenerPath(home)) || text.includes(serviceLabelForHome(home))).join('\n')

    expect(await runListen(home, 'listen', { run: 'my-agent --once', install: true }, io({ shipped, env: { AGENTCHAT_INTEGRATION: 'off' } }))).toBe(0)
    expect(definition()).toMatch(/AGENTCHAT_INTEGRATION(?:<\/key>\s*<string>|=|"\) = ")off/)
    expect(await runListen(home, 'listen', { install: true }, io({ shipped, env: {} }))).toBe(0)
    expect(definition()).not.toContain('AGENTCHAT_INTEGRATION')
  })

  it('forward --install creates the bearer secret and says where it is', async () => {
    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '//\n')
    expect(await runListen(home, 'forward', { to: 'http://localhost:7777/wake', install: true }, io({ shipped }))).toBe(0)
    expect(fs.existsSync(path.join(home, 'forward.secret'))).toBe(true)
    expect(out.join('\n')).toContain(path.join(home, 'forward.secret'))
    expect(out.join('\n')).not.toMatch(/whfwd_/)
  })

  it('a foreground listen without an identity refuses with the next step', async () => {
    expect(await runListen(home, 'listen', { run: 'x' }, io())).toBe(1)
    expect(err.join('\n')).toMatch(/No AgentChat identity .* register/)
  })
})

describe('logout and doctor', () => {
  it('logout removes the key from a preset\'s tool config too', () => {
    const file = claudeMcpConfigPath(home)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ key: KEY }))
    expect(removeKeyFiles(home)).toHaveLength(1)
    expect(fs.existsSync(file)).toBe(false)
    expect(removeKeyFiles(home)).toEqual([])
  })

  it('doctor checks a missing workdir, an unknown preset, a bad forward address', () => {
    const base = { version: 1 as const, updated_at: 'x' }
    expect(listenerChecks(home, { ...base, mode: 'run', command: 'a', with_key: false, workdir: path.join(tmp, 'gone') }).find((c) => c.name === 'workdir')?.verdict).toBe('FAIL')
    expect(listenerChecks(home, { ...base, mode: 'preset', preset: 'nope', profile: 'answer', workdir: tmp }).find((c) => c.name === 'preset')?.verdict).toBe('FAIL')
    expect(listenerChecks(home, { ...base, mode: 'forward', url: 'http://example.com/', workdir: tmp }).find((c) => c.name === 'forward')?.verdict).toBe('FAIL')
  })

  it('the manual lives in a skills dir under the home', () => {
    expect(manualPathFor(home)).toBe(path.join(home, 'skills', 'agentchat', 'SKILL.md'))
  })
})

describe('status --json', () => {
  // The engine's `status`, as this CLI runs it: the listener's record is under
  // `integration` in every shape it prints, and nothing else carries it (the
  // `doorbell` alias is gone since agent-core 0.4.1). The CLI places no
  // instruction file, so `anchor` and `anchor_current` are null.
  const listenerRecord = (): IntegrationStatus => ({
    version: 2,
    updated_at: new Date().toISOString(),
    pid: 4242,
    runtime: 'generic',
    handle: 'probe',
    profile: 'answer',
    socket: 'ready',
    wakes: 1,
    wakes_absorbed: 0,
    invites: 0,
    runs_started: 1,
    runs_ok: 1,
    runs_failed: 0,
    runs_timed_out: 0,
    runs_not_started: 0,
    runs_skipped_empty: 0,
    last_run: null,
    retry_rung: 0,
    retry_due_at: null,
    last_error: null,
    texts: null,
  })

  it('no identity: `integration`, and no `doorbell` key', async () => {
    expect(await main(['--home', home, 'status', '--json'])).toBe(0)
    const parsed = JSON.parse(out.at(-1) ?? '{}') as Record<string, unknown>
    expect(parsed).toMatchObject({ configured: false, host: 'agentchat-cli', integration: null })
    expect(parsed).not.toHaveProperty('doorbell')
  })

  it('signed in, and with the key refused: the listener under `integration`, no `doorbell` key, no instruction file', async () => {
    // Only GET /v1/agents/me answers: the tray cannot be read (`tray: null`) and no texts are served.
    let refuse = false
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/agents/me') {
        if (refuse) {
          res.statusCode = 401
          res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Invalid API key' }))
        } else {
          res.end(JSON.stringify({ handle: 'probe', status: 'active' }))
        }
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ code: 'NOT_FOUND', message: 'not served here' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      signIn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      writeIntegrationStatus(home, listenerRecord())

      expect(await main(['--home', home, 'status', '--json'])).toBe(0)
      const signedIn = JSON.parse(out.at(-1) ?? '{}') as Record<string, unknown>
      expect(signedIn).toMatchObject({ configured: true, host: 'agentchat-cli', handle: 'probe', tray: null, anchor: null, anchor_current: null, anchor_error: null, integration: { socket: 'ready', handle: 'probe' } })
      expect(signedIn).not.toHaveProperty('doorbell')

      refuse = true
      expect(await main(['--home', home, 'status', '--json'])).toBe(1)
      const refused = JSON.parse(out.at(-1) ?? '{}') as Record<string, unknown>
      expect(refused).toMatchObject({ configured: true, host: 'agentchat-cli', error: { kind: 'key_refused', status: 401 }, anchor: null, anchor_error: null, integration: { socket: 'ready' } })
      expect(refused).not.toHaveProperty('doorbell')
      // The key is never printed, in either shape, on either stream.
      expect([...out, ...err].join('\n')).not.toContain(KEY)
    } finally {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('the listener serves only the home\'s agent', () => {
  const io = (env: NodeJS.ProcessEnv) => ({ out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: tmp, env, shipped: shippedStub() })
  function shippedStub(): string {
    const file = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(file, '//\n')
    return file
  }

  it('an exported AGENTCHAT_API_KEY that is not the home\'s key stops listen and forward with one line; the same key does not', async () => {
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe' }))
    const other = 'ac_live_' + 'o'.repeat(40)
    expect(envKeyConflict(home, { AGENTCHAT_API_KEY: other })).toMatch(/not the key .* holds/)
    expect(envKeyConflict(home, { AGENTCHAT_API_KEY: KEY })).toBeNull()
    expect(envKeyConflict(home, {})).toBeNull()

    expect(await runListen(home, 'listen', { run: 'x', install: true }, io({ AGENTCHAT_API_KEY: other }))).toBe(1)
    expect(await runListen(home, 'forward', { to: 'http://localhost:1/w' }, io({ AGENTCHAT_API_KEY: other }))).toBe(1)
    expect(err).toHaveLength(2)
    expect(err.every((line) => !line.includes('\n') && /AGENTCHAT_API_KEY/.test(line))).toBe(true)
    expect(err.join('')).not.toContain(other)
    expect(await runListen(home, 'listen', { run: 'x', install: true }, io({ AGENTCHAT_API_KEY: KEY }))).toBe(0)
  })

  it('no credentials in the home and a key exported: refused too (the listener never takes its key from the environment)', () => {
    expect(envKeyConflict(home, { AGENTCHAT_API_KEY: KEY })).toMatch(/there is none/)
  })
})

describe.skipIf(process.platform === 'win32')('POSIX only (permission bits; Windows ACLs are not checked): the boot service runs only a config that is yours alone', () => {
  const base = { version: 1 as const, workdir: '/tmp', updated_at: 'x', mode: 'run' as const, command: 'x' }

  it('refuses a group- or other-writable listener.json or home, and a link where the file belongs', () => {
    writeListenerConfig(home, base)
    fs.chmodSync(home, 0o700)
    expect(listenerFilesProblem(home)).toBeNull()
    fs.chmodSync(listenerConfigPath(home), 0o620)
    expect(listenerFilesProblem(home)).toMatch(/writable by its group/)
    fs.chmodSync(listenerConfigPath(home), 0o600)
    fs.chmodSync(home, 0o757)
    expect(listenerFilesProblem(home)).toMatch(/writable by others/)
    fs.chmodSync(home, 0o700)
    const real = path.join(tmp, 'elsewhere.json')
    fs.writeFileSync(real, '{}')
    fs.rmSync(listenerConfigPath(home))
    fs.symlinkSync(real, listenerConfigPath(home))
    expect(ownerOnlyProblem(listenerConfigPath(home), 'file')).toMatch(/not a regular file/)
  })

  it('listen --install tightens the home and the config it owns, then installs', async () => {
    fs.chmodSync(home, 0o775)
    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '//\n')
    expect(await runListen(home, 'listen', { run: 'my-agent', install: true }, { out: (l) => out.push(l), err: (l) => err.push(l), cwd: tmp, shipped })).toBe(0)
    expect(fs.statSync(home).mode & 0o777).toBe(0o700)
    expect(fs.statSync(listenerConfigPath(home)).mode & 0o777).toBe(0o600)
    expect(out.join('\n')).toMatch(/Tightened .* → mode 700/)
    expect(tightenListenerFiles(home)).toEqual([])
  })
})

describe('listen --uninstall removes what only the service used', () => {
  it('the durable copy, the status file, the forward secret and the preset tool config go; credentials and listener.json stay', async () => {
    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '//\n')
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe' }))
    const ioq = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd: tmp, shipped }
    expect(await runListen(home, 'forward', { to: 'http://localhost:7/w', install: true }, ioq)).toBe(0)
    fs.mkdirSync(path.join(home, 'presets'), { recursive: true })
    fs.writeFileSync(claudeMcpConfigPath(home), '{"key":"held"}')
    fs.writeFileSync(path.join(home, 'integration.status.json'), '{}')
    expect(fs.existsSync(path.join(home, 'forward.secret'))).toBe(true)
    expect(await runListen(home, 'listen', { uninstall: true }, ioq)).toBe(0)
    for (const gone of ['bin', 'presets', 'forward.secret', 'integration.status.json']) expect(fs.existsSync(path.join(home, gone)), gone).toBe(false)
    for (const kept of ['credentials', 'listener.json']) expect(fs.existsSync(path.join(home, kept)), kept).toBe(true)
  })
})
