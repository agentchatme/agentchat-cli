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
import { durableListenerPath, invocation, manualPathFor, resolveHome, serviceEnvFrom, serviceLabelForHome, shellArg } from '../src/home.js'
import { claudePresetDenyPaths, homeLabel, listenerChecks, removeKeyFiles } from '../src/identity.js'
import { envKeyConflict, listenerFilesProblem, ownerOnlyProblem, tightenListenerFiles } from '../src/guards.js'
import { OWN_PROFILE_WARNING, defaultPresetWorkdir, describeListenerConfig, listenerConfigPath, ownProfileLine, presetProfileSummary, writeListenerConfig } from '../src/listener/config.js'
import { readListenerConfig } from '../src/listener/config.js'
import { presetPointer } from '../src/runners.js'
import { VERSION } from '../src/version.js'
import * as core from '@agentchatme/agent-core'
import { alwaysOnWanted, manualPointer, MANUAL_URL, PEER_RUN_WARNING, RUN_PROFILES, writeIntegrationStatus, type IntegrationStatus, type RunProfile } from '@agentchatme/agent-core'
import { claudeMcpConfigPath, claudeCodePreset, codexPreset } from '@agentchatme/agent-core/presets'
import { installFakeClaude, installFakeCodex } from './helpers/fake-runtimes.js'
import { INBOX_TOOL, SEND_TOOL, startMcpDouble, type McpDouble } from './helpers/mcp-double.js'

/**
 * Whether the engine this build runs on has the `own` profile. The pin moves to
 * that engine at the release step; until then the tests that need it skip,
 * and pass with the new engine linked in.
 */
const ENGINE_HAS_OWN = (RUN_PROFILES as readonly string[]).includes('own')
const OWN = 'own' as RunProfile

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
    const io = { env: {}, cwd: tmp, home }
    const run = configFromFlags('listen', { run: 'my-agent --once', budget: '30' }, io)
    expect(run).toMatchObject({ ok: true, config: { mode: 'run', command: 'my-agent --once', workdir: tmp, budget_ms: 30_000, with_key: false } })
    expect(configFromFlags('listen', { preset: 'codex', profile: 'work', workdir: 'sub' }, io)).toMatchObject({ ok: true, config: { mode: 'preset', preset: 'codex', profile: 'work', workdir: path.join(tmp, 'sub') } })
    expect(configFromFlags('listen', { preset: 'claude-code' }, { env: { AGENTCHAT_RUN_PROFILE: 'full' }, cwd: tmp, home })).toMatchObject({ ok: true, config: { profile: 'full' } })
    expect(configFromFlags('forward', { to: 'http://localhost:9/w' }, io)).toMatchObject({ ok: true, config: { mode: 'forward', url: 'http://localhost:9/w' } })

    const refused = (built: ReturnType<typeof configFromFlags>): string => (built.ok ? 'accepted' : built.error)
    expect(refused(configFromFlags('listen', {}, io))).toMatch(/Missing what to run/)
    expect(refused(configFromFlags('listen', { run: 'a', preset: 'codex' }, io))).toMatch(/not both/)
    expect(refused(configFromFlags('listen', { preset: 'nope' }, io))).toMatch(/unknown preset "nope" \(presets: claude-code, codex\)/)
    expect(refused(configFromFlags('listen', { run: 'a', profile: 'work' }, io))).toMatch(/belongs to a preset/)
    expect(refused(configFromFlags('listen', { preset: 'codex', withKey: true }, io))).toMatch(/belongs to --run/)
    expect(refused(configFromFlags('listen', { run: 'a', budget: '0' }, io))).toMatch(/seconds/)
    expect(refused(configFromFlags('forward', { to: 'http://example.com/x' }, io))).toMatch(/only to this machine/)
    expect(refused(configFromFlags('listen', { preset: 'codex', profile: 'all' }, io))).toBe(
      `--profile is own, answer, work or full (own, the default: reply runs use your own Claude Code or Codex permission settings, with anything that would ask refused; answer: the AgentChat tools and reads inside the run's work folder only; work and full: ${PEER_RUN_WARNING})`,
    )
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

describe('the hands act as the home\'s agent only', () => {
  // With another agent's key exported, `send` went out as THAT agent with
  // `ok: true` on screen, and `tools call` answered as it, while the listener
  // refused the same state. Every command that acts as the agent now follows
  // the listener's rule: refused in one line, nothing sent.
  let mcp: McpDouble
  const OTHER = 'ac_live_' + 'o'.repeat(40)
  beforeEach(async () => {
    mcp = await startMcpDouble({ tools: [SEND_TOOL, INBOX_TOOL] })
    signIn(mcp.apiBase)
  })
  afterEach(async () => mcp.close())

  it('send, tools call, tools list and inbox refuse an exported key that is not the home\'s; the server sees nothing', async () => {
    process.env['AGENTCHAT_API_KEY'] = OTHER
    for (const argv of [['send', '@peer', 'hi'], ['tools', 'call', 'agentchat_inbox', '--json', '{}'], ['tools', 'list'], ['inbox']]) {
      err.length = 0
      expect(await main(['--home', home, ...argv]), argv.join(' ')).toBe(1)
      expect(err.join('\n')).toMatch(/AGENTCHAT_API_KEY is exported and is not the key .* holds/)
      expect(err.join('\n')).toContain('printenv AGENTCHAT_API_KEY | ')
      expect(err.join('\n')).toContain(` --home ${shellArg(home)} login --api-key -`)
    }
    expect(mcp.seen).toEqual([])
    expect([...out, ...err].join('\n')).not.toContain(OTHER)
    expect([...out, ...err].join('\n')).not.toContain(KEY)
  })

  it('the same key exported is the same agent: it works, with the home\'s key on the wire', async () => {
    process.env['AGENTCHAT_API_KEY'] = KEY
    expect(await main(['--home', home, 'send', '@peer', 'hi'])).toBe(0)
    expect(mcp.seen.length).toBeGreaterThan(0)
    for (const call of mcp.seen) expect(call.headers['authorization']).toBe(`Bearer ${KEY}`)
  })

  it('a home with no key and one exported: refused too, as the listener refuses it', async () => {
    fs.rmSync(path.join(home, 'credentials'))
    process.env['AGENTCHAT_API_KEY'] = OTHER
    expect(await main(['--home', home, 'send', '@peer', 'hi'])).toBe(1)
    expect(err.join('\n')).toMatch(/there is none/)
    expect(mcp.seen).toEqual([])
  })
})

// `status`, `doctor` and `login` are the engine's: their refusals in words come
// with the agent-core release after 0.5.2, and this runs once the pin moves there.
describe.skipIf(!('envKeyConflict' in core))('the engine’s commands refuse another agent’s exported key', () => {
  it('login does not adopt it and status refuses, both naming no key', async () => {
    signIn('https://api.agentchat.test')
    const other = 'ac_live_' + 'o'.repeat(40)
    process.env['AGENTCHAT_API_KEY'] = other
    expect(await main(['--home', home, 'login'])).toBe(1)
    expect(await main(['--home', home, 'status'])).toBe(1)
    expect(err.join('\n')).toContain('AGENTCHAT_API_KEY is exported')
    expect([...out, ...err].join('\n')).not.toContain(other)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'credentials'), 'utf-8'))).toMatchObject({ api_key: KEY })
  })
})

describe('every printed next command reaches the home it was given', () => {
  it('a home that is not the default rides along as --home, quoted when it has to be; the default home adds nothing', async () => {
    const { invocationFor, shellArg, defaultHome } = await import('../src/home.js')
    expect(invocationFor(defaultHome(), {})).toBe('agentchat')
    expect(invocationFor(home, {})).toBe(`agentchat --home ${shellArg(home)}`)
    expect(invocationFor(home, { npm_command: 'exec' })).toBe(`npx -y @agentchatme/cli --home ${shellArg(home)}`)
    // AGENTCHAT_HOME pointing elsewhere: even the default home rides along, since a bare command would not reach it.
    expect(invocationFor(defaultHome(), { AGENTCHAT_HOME: home })).toBe(`agentchat --home ${shellArg(defaultHome())}`)
    expect(shellArg('/tmp/a b', 'linux')).toBe(`'/tmp/a b'`)
    expect(shellArg("/tmp/it's", 'linux')).toBe(`'/tmp/it'\\''s'`)
    expect(shellArg('C:\\Users\\a b', 'win32')).toBe('"C:\\Users\\a b"')
  })

  it('status and the register gate name this home, so neither sends the user to ~/.agentchat (where `logout` would delete another agent\'s key)', async () => {
    expect(await main(['--home', home, 'status'])).toBe(0)
    expect(out.join('\n')).toContain(`Set one up with: ${invocation()} --home ${shellArg(home)} register`)
    // The worst case of the finding: a home holding an identity says to log out first — of THIS home, never the default.
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe' }))
    err.length = 0
    expect(await main(['--home', home, 'register', '--email', 'a@example.com', '--handle', 'probe2'])).toBe(1)
    expect(err.join('\n')).toContain(`Run \`${invocation()} --home ${shellArg(home)} logout\` first`)
  })

  it('the listener\'s and the hands\' refusals name the home too', () => {
    expect(envKeyConflict(home, { AGENTCHAT_API_KEY: 'ac_live_' + 'z'.repeat(40) })).toContain(`agentchat --home ${shellArg(home)} login`)
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

describe('where a run works', () => {
  // A preset's run is started by any peer's message: by default it gets a
  // folder of its own beside the home, never the directory `listen` ran in.
  // `--run` keeps the directory it ran in (the owner's command, its relative
  // paths). An installed listener's folder is never changed without a line saying so.
  const flagsIo = () => ({ env: {}, cwd: tmp, home })

  it('a preset, every profile: a folder of its own beside the home (never inside it: a Claude Code run is denied the home); --workdir names another', () => {
    expect(defaultPresetWorkdir(home)).toBe(path.join(tmp, 'agentchat-home-workdir'))
    expect(defaultPresetWorkdir(home + path.sep)).toBe(path.join(tmp, 'agentchat-home-workdir'))
    for (const profile of ['answer', 'work', 'full']) {
      expect(configFromFlags('listen', { preset: 'claude-code', profile }, flagsIo())).toMatchObject({ ok: true, config: { workdir: defaultPresetWorkdir(home) } })
    }
    expect(configFromFlags('listen', { preset: 'codex', workdir: 'proj' }, flagsIo())).toMatchObject({ ok: true, config: { workdir: path.join(tmp, 'proj') } })
    expect(configFromFlags('listen', { run: 'my-agent' }, flagsIo())).toMatchObject({ ok: true, config: { workdir: tmp } })
    expect(configFromFlags('forward', { to: 'http://localhost:9/w' }, flagsIo())).toMatchObject({ ok: true, config: { workdir: tmp } })
  })

  it('a re-install keeps the installed preset listener’s folder, and says so; a change the flags did not ask for is said in one line', () => {
    const base = { version: 1 as const, updated_at: 'x' }
    const savedPreset = { ...base, mode: 'preset' as const, preset: 'codex', profile: 'answer' as const, workdir: path.join(tmp, 'old-cwd') }
    const kept = configFromFlags('listen', { preset: 'claude-code', profile: 'work' }, { ...flagsIo(), saved: savedPreset })
    expect(kept).toMatchObject({ ok: true, config: { workdir: path.join(tmp, 'old-cwd'), profile: 'work' }, workdirNote: `Work folder: ${path.join(tmp, 'old-cwd')}, kept from the installed listener (--workdir <dir> changes it).` })

    const savedRun = { ...base, mode: 'run' as const, command: 'x', with_key: false, workdir: path.join(tmp, 'project') }
    const moved = configFromFlags('listen', { preset: 'codex' }, { ...flagsIo(), saved: savedRun })
    expect(moved).toMatchObject({ ok: true, config: { workdir: defaultPresetWorkdir(home) } })
    expect(moved.ok && moved.workdirNote).toBe(`Work folder: ${defaultPresetWorkdir(home)}, a folder of its own for the preset's runs; the installed listener used ${path.join(tmp, 'project')} (--workdir ${path.join(tmp, 'project')} keeps that).`)

    // Named by the flags: no note.
    expect(configFromFlags('listen', { preset: 'codex', workdir: 'elsewhere' }, { ...flagsIo(), saved: savedPreset })).not.toHaveProperty('workdirNote')
    // A run listener's folder follows the shell, as before; a move off the installed listener's folder is said.
    expect(configFromFlags('listen', { run: 'x' }, { ...flagsIo(), saved: { ...savedRun, workdir: tmp } })).not.toHaveProperty('workdirNote')
    const toShell = configFromFlags('listen', { run: 'x' }, { ...flagsIo(), saved: savedPreset })
    expect(toShell).toMatchObject({ ok: true, config: { mode: 'run', workdir: tmp } })
    expect(toShell.ok && toShell.workdirNote).toBe(`Work folder: ${tmp}, the directory listen ran in; the installed listener used ${path.join(tmp, 'old-cwd')} (--workdir ${path.join(tmp, 'old-cwd')} keeps that).`)
    expect(configFromFlags('forward', { to: 'http://localhost:9/w' }, { ...flagsIo(), saved: savedPreset })).not.toHaveProperty('workdirNote')
  })

  it('listen --preset --install creates the preset’s own folder owner-only, and a re-install with other flags keeps it and says so', async () => {
    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '//\n')
    const lines: string[] = []
    const ioi = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), cwd: path.join(tmp, 'user'), shipped }
    expect(await runListen(home, 'listen', { preset: 'codex', install: true }, ioi)).toBe(0)
    const folder = defaultPresetWorkdir(home)
    expect(readListenerConfig(home)).toMatchObject({ ok: true, config: { mode: 'preset', workdir: folder } })
    expect(fs.statSync(folder).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect(fs.statSync(folder).mode & 0o777).toBe(0o700)

    // An installed preset listener whose folder was the old default (the directory listen ran in) keeps it.
    writeListenerConfig(home, { version: 1, mode: 'preset', preset: 'codex', profile: 'answer', workdir: path.join(tmp, 'user'), updated_at: 'x' })
    lines.length = 0
    expect(await runListen(home, 'listen', { preset: 'codex', profile: 'work', install: true }, ioi)).toBe(0)
    expect(readListenerConfig(home)).toMatchObject({ ok: true, config: { profile: 'work', workdir: path.join(tmp, 'user') } })
    expect(lines.join('\n')).toContain(`Work folder: ${path.join(tmp, 'user')}, kept from the installed listener`)
    expect(lines.join('\n')).toContain(`profile work — ${PEER_RUN_WARNING}`)
  })
})

describe('a preset run’s prompt and the profile words', () => {
  it('an answer run’s prompt carries no pointer to a manual it cannot reach; work and full get the file or the address, as the run can read it', () => {
    const file = manualPathFor(home)
    for (const preset of [claudeCodePreset, codexPreset]) expect(presetPointer(preset, 'answer', file)).toBe('')
    for (const profile of ['work', 'full'] as const) {
      expect(presetPointer(claudeCodePreset, profile, file)).toBe(`(The AgentChat manual is at ${MANUAL_URL}.)`) // the home is denied to it
      expect(presetPointer(codexPreset, profile, file)).toBe(manualPointer(`at ${file}`))
    }
  })

  it('a preset listener’s description says what its profile does: own in one line with the honest sentence, the engine’s warning next to work and full', () => {
    const base = { version: 1 as const, updated_at: 'x', mode: 'preset' as const, preset: 'codex', workdir: '/w' }
    expect(describeListenerConfig({ ...base, profile: 'answer' })).toBe("runs the codex preset (profile answer — the AgentChat tools and reads inside the run's work folder only) in /w")
    expect(describeListenerConfig({ ...base, profile: 'full' })).toBe(`runs the codex preset (profile full — ${PEER_RUN_WARNING}) in /w`)
    expect(describeListenerConfig({ ...base, preset: 'claude-code', profile: OWN })).toBe(
      "runs the claude-code preset (profile own — reply runs use your own Claude Code permission settings, with anything that would ask refused; runs started by peers' messages act with those permissions) in /w",
    )
    expect(presetProfileSummary('own', 'Codex')).toBe(`${ownProfileLine('Codex')}; ${OWN_PROFILE_WARNING}`)
  })

  it('an own run’s prompt ends with where the manual is, as the run can reach it (the address for Claude Code, denied the home; the file for Codex)', () => {
    const file = manualPathFor(home)
    expect(presetPointer(claudeCodePreset, OWN, file)).toBe(`(The AgentChat manual is at ${MANUAL_URL}.)`)
    expect(presetPointer(codexPreset, OWN, file)).toBe(manualPointer(`at ${file}`))
  })

  it.skipIf(!ENGINE_HAS_OWN)('the own words are the engine’s', () => {
    const words = core as unknown as { ownProfileLine: (label: string) => string; OWN_RUN_WARNING: string }
    for (const label of ['Claude Code', 'Codex']) expect(ownProfileLine(label)).toBe(words.ownProfileLine(label))
    expect(OWN_PROFILE_WARNING).toBe(words.OWN_RUN_WARNING)
  })
})

describe.skipIf(!ENGINE_HAS_OWN)('own: a preset listener acts as the agent itself, under the runtime’s own settings', () => {
  it('the default for --preset when neither --profile nor AGENTCHAT_RUN_PROFILE says otherwise; --profile own is accepted; an unknown value in the environment is answer', () => {
    const io = { env: {}, cwd: tmp, home }
    expect(configFromFlags('listen', { preset: 'claude-code' }, io)).toMatchObject({ ok: true, config: { profile: 'own' } })
    expect(configFromFlags('listen', { preset: 'codex', profile: 'own' }, io)).toMatchObject({ ok: true, config: { profile: 'own' } })
    expect(configFromFlags('listen', { preset: 'codex' }, { ...io, env: { AGENTCHAT_RUN_PROFILE: 'yolo' } })).toMatchObject({ ok: true, config: { profile: 'answer' } })
  })
})

// ─── listener.json versions: an earlier release's recorded `answer` ─────────
//
// Releases before `own` wrote version 1 and recorded `answer` at every preset
// install, passed or not. This release writes version 2; a version-1 `answer`
// reads as `own`, the rest as written, and the file is never rewritten by a read.
describe('listener.json versions', () => {
  const v1 = (profile: string) => ({ version: 1, mode: 'preset', preset: 'codex', profile, workdir: path.join(tmp, 'w'), updated_at: 'x' })
  const writeRaw = (config: object): string => {
    const text = `${JSON.stringify(config, null, 2)}\n`
    fs.writeFileSync(listenerConfigPath(home), text, { mode: 0o600 })
    return text
  }
  const onDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(listenerConfigPath(home), 'utf8')) as Record<string, unknown>
  const installIo = (env: NodeJS.ProcessEnv = { ...process.env, AGENTCHAT_RUN_PROFILE: '' }) => {
    const shipped = path.join(tmp, 'listener-daemon.js')
    fs.writeFileSync(shipped, '//\n')
    const lines: string[] = []
    return { lines, io: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), cwd: tmp, env, shipped } }
  }

  it.skipIf(!ENGINE_HAS_OWN)('a version-1 `answer` (what every earlier preset install recorded) is read as own; the file is left as it was', () => {
    const text = writeRaw(v1('answer'))
    expect(readListenerConfig(home)).toMatchObject({ ok: true, config: { version: 2, mode: 'preset', preset: 'codex', profile: 'own', workdir: path.join(tmp, 'w') } })
    expect(fs.readFileSync(listenerConfigPath(home), 'utf8')).toBe(text)
  })

  it('a version-1 `work` or `full` keeps its profile; a version-2 file is taken exactly as written, `answer` included', () => {
    for (const profile of ['work', 'full']) {
      writeRaw(v1(profile))
      expect(readListenerConfig(home)).toMatchObject({ ok: true, config: { version: 2, profile } })
    }
    for (const profile of ['answer', 'work', 'full', ...(ENGINE_HAS_OWN ? ['own'] : [])]) {
      writeRaw({ ...v1(profile), version: 2 })
      expect(readListenerConfig(home)).toMatchObject({ ok: true, config: { version: 2, profile } })
    }
    writeRaw({ ...v1('answer'), version: 3 })
    expect(readListenerConfig(home)).toMatchObject({ ok: false, error: expect.stringContaining('version: expected 1 or 2 (a newer release wrote it') })
  })

  it.skipIf(!ENGINE_HAS_OWN)('`status` says own for a version-1 `answer`; `listen --install` with nothing else re-installs it as own and leaves the file alone', { timeout: 30_000 }, async () => {
    signIn('http://127.0.0.1:9')
    const text = writeRaw(v1('answer'))
    await main(['--home', home, 'status'])
    expect(out.join('\n')).toContain(`✓ runs the codex preset (profile own — ${presetProfileSummary('own', 'Codex')}) in ${path.join(tmp, 'w')}`)
    const { lines, io } = installIo()
    expect(await runListen(home, 'listen', { install: true }, io)).toBe(0)
    expect(lines.join('\n')).toContain('runs the codex preset (profile own — ')
    expect(fs.readFileSync(listenerConfigPath(home), 'utf8')).toBe(text)
  })

  it.skipIf(!ENGINE_HAS_OWN)('a new install without --profile writes version 2 with own', async () => {
    const { io } = installIo()
    expect(await runListen(home, 'listen', { preset: 'claude-code', install: true }, io)).toBe(0)
    expect(onDisk()).toMatchObject({ version: 2, mode: 'preset', preset: 'claude-code', profile: 'own' })
  })

  it('--profile answer (or AGENTCHAT_RUN_PROFILE=answer) at install writes version 2 with answer, which stays the lock', async () => {
    writeRaw(v1('answer'))
    const { io } = installIo()
    expect(await runListen(home, 'listen', { preset: 'codex', profile: 'answer', install: true }, io)).toBe(0)
    expect(onDisk()).toMatchObject({ version: 2, profile: 'answer' })
    expect(readListenerConfig(home)).toMatchObject({ ok: true, config: { profile: 'answer' } })

    fs.rmSync(listenerConfigPath(home))
    const byEnv = installIo({ ...process.env, AGENTCHAT_RUN_PROFILE: 'answer' })
    expect(await runListen(home, 'listen', { preset: 'codex', install: true }, byEnv.io)).toBe(0)
    expect(onDisk()).toMatchObject({ version: 2, profile: 'answer' })
    expect(readListenerConfig(home)).toMatchObject({ ok: true, config: { profile: 'answer' } })
  })

  it('every write is version 2: a version-1 input is written as it reads', () => {
    writeListenerConfig(home, { version: 1, mode: 'preset', preset: 'codex', profile: 'work', workdir: path.join(tmp, 'w'), updated_at: 'x' })
    expect(onDisk()).toMatchObject({ version: 2, profile: 'work' })
    writeListenerConfig(home, { version: 1, mode: 'preset', preset: 'codex', profile: 'answer', workdir: path.join(tmp, 'w'), updated_at: 'x' })
    expect(onDisk()).toMatchObject({ version: 2, profile: ENGINE_HAS_OWN ? 'own' : 'answer' })
  })

  it('`status` says when the service still runs an earlier release\'s listener (it reads listener.json as that release did), and what replaces it', { timeout: 30_000 }, async () => {
    signIn('http://127.0.0.1:9')
    writeRaw(v1('work'))
    core.markAlwaysOnWanted(home)
    core.markAlwaysOnInstalledVersion(home, '0.1.1')
    await main(['--home', home, 'status'])
    expect(out.join('\n')).toContain(`✗ the service runs the listener from 0.1.1, not this release's (${VERSION}) — \`${invocation()} --home ${shellArg(home)} doctor --fix\` re-installs it`)
    core.markAlwaysOnInstalledVersion(home, VERSION)
    out.length = 0
    await main(['--home', home, 'status'])
    expect(out.join('\n')).not.toContain('the service runs the listener from')
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
  it('logout removes the key from a preset\'s tool config, what an interrupted run left beside it, and the folder', () => {
    const file = claudeMcpConfigPath(home)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ key: KEY }))
    fs.writeFileSync(path.join(path.dirname(file), 'claude-code.mcp.run-1.identity.md'), 'I am @probe on AgentChat.\n')
    expect(removeKeyFiles(home)).toEqual([`  removed 2 preset file(s) from ${path.dirname(file)}: the tool config that holds the key, and what an interrupted run left`])
    expect(fs.existsSync(path.dirname(file))).toBe(false)
    expect(removeKeyFiles(home)).toEqual([])
  })

  it('doctor checks a missing workdir, an unknown preset, a bad forward address', async () => {
    const base = { version: 1 as const, updated_at: 'x' }
    expect((await listenerChecks(home, { ...base, mode: 'run', command: 'a', with_key: false, workdir: path.join(tmp, 'gone') })).find((c) => c.name === 'workdir')?.verdict).toBe('FAIL')
    expect((await listenerChecks(home, { ...base, mode: 'preset', preset: 'nope', profile: 'answer', workdir: tmp })).find((c) => c.name === 'preset')?.verdict).toBe('FAIL')
    expect((await listenerChecks(home, { ...base, mode: 'forward', url: 'http://example.com/', workdir: tmp })).find((c) => c.name === 'forward')?.verdict).toBe('FAIL')
  })

  describe('the preset’s own preflight, in its words', () => {
    const base = { version: 1 as const, updated_at: 'x', mode: 'preset' as const }
    const originalPath = process.env['PATH']
    afterEach(() => {
      process.env['PATH'] = originalPath
    })
    const preflight = async (preset: string, profile: 'answer' | 'work', env: NodeJS.ProcessEnv, workdir = path.join(tmp, 'w')) =>
      (await listenerChecks(home, { ...base, preset, profile, workdir }, env)).find((c) => c.name === 'preset-preflight')

    it('Claude Code: an answer run refuses while the user’s settings list permissions.additionalDirectories; work does not; the listener’s own tool config is never written', async () => {
      signIn('https://api.agentchat.test')
      const fake = installFakeClaude(tmp)
      process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
      const configDir = path.join(tmp, 'user', '.claude')
      const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir }
      expect(await preflight('claude-code', 'answer', env)).toMatchObject({ verdict: 'PASS' })
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [path.join(tmp, 'shared')] } }))
      const refused = await preflight('claude-code', 'answer', env)
      expect(refused?.verdict).toBe('FAIL')
      expect(refused?.detail).toContain(`Claude Code: no run starts: answer runs do not start while ${path.join(configDir, 'settings.json')} lists permissions.additionalDirectories`)
      expect(await preflight('claude-code', 'work', env)).toMatchObject({ verdict: 'PASS' })
      expect(fs.existsSync(claudeMcpConfigPath(home))).toBe(false)
    })

    it('Codex: an MCP server no -c key can switch off stops answer runs; the listing ran as the listener’s would', async () => {
      signIn('https://api.agentchat.test')
      const fake = installFakeCodex(tmp)
      process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
      const env = { ...process.env, CODEX_HOME: path.join(tmp, 'user', '.codex') }
      expect(await preflight('codex', 'answer', env)).toMatchObject({ verdict: 'PASS' })
      const refused = await preflight('codex', 'answer', { ...env, FAKE_MCP_LIST: JSON.stringify([{ name: 'agentchat', enabled: true }, { name: 'team.notes', enabled: true }]) })
      expect(refused?.verdict).toBe('FAIL')
      expect(refused?.detail).toContain("Codex: no run starts: could not list Codex's MCP servers")
      expect(refused?.detail).toContain('"team.notes" cannot be switched off')
    })

    it('a work folder that holds a key store a run could read is said; a preset’s missing folder is created by its preflight, as the listener’s start would', async () => {
      const fake = installFakeCodex(tmp)
      process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
      const env = { ...process.env, CODEX_HOME: path.join(tmp, 'user', '.codex') }
      // A listener home inside the work folder: an answer run's apply_patch reads its working root.
      const boxed = path.join(tmp, 'box', 'agentchat-home')
      fs.mkdirSync(boxed, { recursive: true })
      fs.writeFileSync(path.join(boxed, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe', api_base: 'https://api.agentchat.test' }))
      const holding = await listenerChecks(boxed, { ...base, preset: 'codex', profile: 'answer', workdir: path.join(tmp, 'box') }, env)
      expect(holding.find((c) => c.name === 'workdir')).toMatchObject({ verdict: 'WARN', detail: expect.stringContaining(`${path.join(tmp, 'box')} contains ${boxed}, where a key is`) })

      signIn('https://api.agentchat.test')
      const missing = path.join(tmp, 'not-yet')
      const checks = await listenerChecks(home, { ...base, preset: 'codex', profile: 'answer', workdir: missing }, env)
      expect(checks.find((c) => c.name === 'preset-preflight')).toMatchObject({ verdict: 'PASS' })
      expect(checks.find((c) => c.name === 'workdir')).toMatchObject({ verdict: 'PASS', detail: missing })
      // Without a runtime that checks out, nothing creates it: said, not failed — the listener creates it when it starts.
      // No runtime at all: PATH is an empty folder, so no real codex can ever be reached from here.
      const emptyBin = path.join(tmp, 'empty-bin')
      fs.mkdirSync(emptyBin, { recursive: true })
      process.env['PATH'] = emptyBin
      const gone = await listenerChecks(home, { ...base, preset: 'codex', profile: 'answer', workdir: path.join(tmp, 'later') }, { ...env, PATH: emptyBin })
      process.env['PATH'] = originalPath
      expect(gone.find((c) => c.name === 'preset')).toMatchObject({ verdict: 'FAIL', detail: expect.stringContaining('codex CLI not found on PATH') })
      expect(gone.find((c) => c.name === 'workdir')).toMatchObject({ verdict: 'WARN', detail: expect.stringContaining('does not exist yet — the listener creates it') })
    })

    it.skipIf(!ENGINE_HAS_OWN)('a home-folder work folder: own runs work in the same folder of their own', async () => {
      const fake = installFakeCodex(tmp)
      process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
      const env = { ...process.env, CODEX_HOME: path.join(tmp, 'user', '.codex') }
      const checks = await listenerChecks(home, { ...base, preset: 'codex', profile: OWN, workdir: path.join(tmp, 'user') }, env)
      expect(checks.find((c) => c.name === 'workdir')).toMatchObject({
        verdict: 'WARN',
        detail: expect.stringContaining(`is your home folder or contains it — own runs work in ${path.join(tmp, 'user', '.codex', 'agentchat-answer-workdir')} instead`),
      })
    })

    it('no identity: not checked (the listener idles); a home-folder work folder is said, with the answer runs’ own folder', async () => {
      const fake = installFakeCodex(tmp)
      process.env['PATH'] = `${fake.binDir}${path.delimiter}${originalPath ?? ''}`
      const env = { ...process.env, CODEX_HOME: path.join(tmp, 'user', '.codex') }
      expect(await preflight('codex', 'answer', env)).toMatchObject({ verdict: 'WARN', detail: expect.stringContaining('not checked: no identity') })
      const checks = await listenerChecks(home, { ...base, preset: 'codex', profile: 'answer', workdir: path.join(tmp, 'user') }, env)
      expect(checks.find((c) => c.name === 'workdir')).toMatchObject({
        verdict: 'WARN',
        detail: expect.stringContaining(`is your home folder or contains it — answer runs work in ${path.join(tmp, 'user', '.codex', 'agentchat-answer-workdir')} instead`),
      })
    })
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

  it('runs failing for a runtime reason, and another listener serving the agent, are said by status and doctor', { timeout: 30_000 }, async () => {
    signIn('http://127.0.0.1:9') // unreachable on purpose: these lines come from the listener's own record
    const since = new Date(Date.now() - 60_000).toISOString()
    writeIntegrationStatus(home, { ...listenerRecord(), runtime: 'claude', runs_failing: { reason: 'claude: claude is not signed in (run `claude` once and sign in)', since, runs_missed: 2, checked_at: new Date().toISOString() } })
    await main(['--home', home, 'status'])
    expect(out.join('\n')).toContain('runs failing: claude: claude is not signed in')
    out.length = 0
    expect(await main(['--home', home, 'doctor'])).toBe(1)
    expect(out.join('\n')).toContain('FAIL runs: runs failing: claude: claude is not signed in')

    writeIntegrationStatus(home, { ...listenerRecord(), socket: 'idle', standby: { home: '/elsewhere/.claude/agentchat', pid: 4243, since } })
    out.length = 0
    await main(['--home', home, 'status'])
    expect(out.join('\n')).toContain('standby: /elsewhere/.claude/agentchat (pid 4243) serves this agent')
    out.length = 0
    await main(['--home', home, 'doctor'])
    expect(out.join('\n')).toContain('WARN single-listener: another listener serves this agent: /elsewhere/.claude/agentchat (pid 4243)')
  })

  it('a listener that gave the agent up — a refused key, or failing runs handed to a waiting listener — is said by doctor, with what clears it; a serving one too', { timeout: 30_000 }, async () => {
    signIn('http://127.0.0.1:9')
    const since = new Date(Date.now() - 120_000).toISOString()
    const retryAt = new Date(Date.now() + 60_000).toISOString()
    writeIntegrationStatus(home, { ...listenerRecord(), socket: 'idle', unservable: { reason: 'key_refused', detail: 'auth rejected (close 1008 Invalid token)', since, retry_at: retryAt } })
    expect(await main(['--home', home, 'doctor'])).toBe(1)
    expect(out.join('\n')).toContain('FAIL listener-serving: this home gave the agent up: the server refuses its key (auth rejected (close 1008 Invalid token)); signing in again here')
    out.length = 0
    await main(['--home', home, 'status'])
    expect(out.join('\n')).toContain("gave up: the server refuses this home's key")

    const reason = 'claude: claude is not signed in'
    writeIntegrationStatus(home, {
      ...listenerRecord(),
      socket: 'idle',
      runs_failing: { reason, since, runs_missed: 4, checked_at: new Date().toISOString() },
      unservable: { reason: 'runs_failing', detail: `runs failing: ${reason}`, since, retry_at: retryAt },
    })
    out.length = 0
    await main(['--home', home, 'doctor'])
    expect(out.join('\n')).toContain(`FAIL listener-serving: this home gave the agent up to another listener that was waiting: runs failing: ${reason} (since ${since}); a runtime check that passes clears this`)

    // A lone listener keeps serving while runs fail; lock renewal errors are said.
    writeIntegrationStatus(home, { ...listenerRecord(), runs_failing: { reason, since, runs_missed: 4, checked_at: new Date().toISOString() }, lease_errors: { count: 3, last: 'ENOENT: the lock folder is gone' } })
    out.length = 0
    await main(['--home', home, 'doctor'])
    expect(out.join('\n')).toContain(`WARN listener-serving: socket ready, but runs are failing: ${reason}`)
    expect(out.join('\n')).toContain('WARN locks: 3 lock renewal(s) failed (last: ENOENT: the lock folder is gone)')

    writeIntegrationStatus(home, listenerRecord())
    out.length = 0
    await main(['--home', home, 'doctor'])
    expect(out.join('\n')).toContain('PASS listener-serving: serving @probe (socket ready, 1 run(s), 1 ok)')
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
    fs.writeFileSync(path.join(home, 'presets', 'claude-code.mcp.run-1.identity.md'), 'left by a run cut off\n')
    fs.writeFileSync(path.join(home, 'integration.status.json'), '{}')
    expect(fs.existsSync(path.join(home, 'forward.secret'))).toBe(true)
    expect(await runListen(home, 'listen', { uninstall: true }, ioq)).toBe(0)
    for (const gone of ['bin', 'presets', 'forward.secret', 'integration.status.json']) expect(fs.existsSync(path.join(home, gone)), gone).toBe(false)
    for (const kept of ['credentials', 'listener.json']) expect(fs.existsSync(path.join(home, kept)), kept).toBe(true)
  })
})
