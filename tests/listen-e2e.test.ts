import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { runListen } from '../src/listen.js'
import { writeListenerConfig } from '../src/listener/config.js'
import { runWatch, describeFrame } from '../src/watch.js'
import { MANUAL_URL, formatIntegrationStatus, readIntegrationStatus, RUN_PROFILES } from '@agentchatme/agent-core'
import * as presets from '@agentchatme/agent-core/presets'
import { RUNTIME_CHECK_PROMPT, claudeMcpConfigPath, claudeProjectsDirFor, claudeRuntimeCheckWorkdir, codexRunArgs, readDenyRules } from '@agentchatme/agent-core/presets'
import { defaultPresetWorkdir } from '../src/listener/config.js'
import { claudePresetDenyPaths } from '../src/identity.js'
import { VERSION } from '../src/version.js'
import { installFakeClaude, installFakeCodex, readFakeMcpLists, readFakeRuns } from './helpers/fake-runtimes.js'
import { startServerDouble, until, pause, type ServerDouble } from './helpers/server-double.js'

/** Whether the engine this build runs on has the `own` profile (the pin moves to it at the release step). */
const ENGINE_HAS_OWN = (RUN_PROFILES as readonly string[]).includes('own')

// ─── A foreground listener, end to end, against the server double ───────────
//
// The double speaks the socket's HELLO path, the tray, the texts and the
// invites. Each test signs a throwaway home in against it, starts
// `runListen` in the foreground, and checks what the wake did: the owner's
// command ran once with the served wake instruction on stdin; the forwarder
// POSTed the agentchat-dialect wake; the claude preset ran the fake `claude`
// with the listener's own tool config. Every message.new is acked before.

const KEY = 'ac_live_' + 'e'.repeat(40)
/** The served conversation-run prompt, as a double serves it. Not the server's words: a test that passed because a fixture matched a copy would prove nothing. */
const TEMPLATE = 'SERVED CONVERSATION RUN for <conversation_id>: only this one.'
const MANUAL = { version: '9.0.0', body: '---\nname: agentchat\nversion: 9.0.0\n---\n\nTest manual.\n' }
let tmp: string
let home: string
let server: ServerDouble
let lines: string[]
const originalPath = process.env['PATH']

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-listen-e2e-'))
  home = path.join(tmp, 'home')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(tmp, 'work'), { recursive: true })
  // The texts announce a manual the double serves itself: no test reaches agentchat.me.
  server = await startServerDouble({ tray: { waiting: 1 }, manual: { version: '9.0.0', body: '---\nname: agentchat\nversion: 9.0.0\n---\n\nTest manual.\n' } })
  fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe', api_base: server.apiBase }))
  lines = []
})
afterEach(async () => {
  // A test that failed before its own abort leaves its listener running: stop
  // it, and let it end, before its server and its folder go — otherwise it
  // runs on into the next test (and spawns from a folder that is gone).
  // Bounded: a stopping listener gives its run 10 s to end (the engine's stop grace).
  for (const controller of running.controllers.splice(0)) controller.abort()
  await Promise.race([Promise.allSettled(running.done.splice(0)), pause(20_000)])
  process.env['PATH'] = originalPath
  await server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}, 30_000)

/** The listeners (and watchers) this test started, stopped by `afterEach` whatever happened. */
const running = { controllers: [] as AbortController[], done: [] as Promise<unknown>[] }
const stoppable = (): AbortController => {
  const controller = new AbortController()
  running.controllers.push(controller)
  return controller
}
const tracked = <T>(done: Promise<T>): Promise<T> => {
  running.done.push(done)
  return done
}

const io = (signal: AbortSignal, env: NodeJS.ProcessEnv = process.env) => ({
  out: (l: string) => lines.push(l),
  err: (l: string) => lines.push(l),
  cwd: path.join(tmp, 'work'),
  signal,
  env,
  exit: () => undefined,
})

/** A server double that serves the conversation-run prompt (the current server), signed in as before. */
async function conversationRunServer(tray: Parameters<ServerDouble['setTray']>[0]): Promise<void> {
  await server.close()
  server = await startServerDouble({ tray, conversationRunTemplate: TEMPLATE, manual: MANUAL })
  fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe', api_base: server.apiBase }))
}

/** A command that records each run (stdin, kind, conversation, run id) and fails, after some output, for the conversation named in `failOn` (`*`: every one). */
function recordingCommand(record: string, failOn: string | null = null): string {
  const script = path.join(tmp, `agent-${Math.random().toString(16).slice(2)}.cjs`)
  fs.writeFileSync(
    script,
    [
      "let d = ''",
      "process.stdin.on('data', (c) => (d += c))",
      "process.stdin.on('end', () => {",
      `  require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ stdin: d, kind: process.env.AGENTCHAT_WAKE_KIND, conv: process.env.AGENTCHAT_CONVERSATION_ID ?? null, run: process.env.AGENTCHAT_RUN_ID }) + '\\n')`,
      "  process.stdout.write('ok')",
      `  const failOn = ${JSON.stringify(failOn)}`,
      "  if (failOn !== null && (failOn === '*' || process.env.AGENTCHAT_CONVERSATION_ID === failOn)) { console.error('API Error: refused'); process.exit(1) }",
      '})',
    ].join('\n'),
  )
  return `"${process.execPath}" "${script}"`
}

type RecordedRun = { stdin: string; kind: string; conv: string | null; run: string }
const readRuns = (record: string): RecordedRun[] =>
  fs.existsSync(record) ? fs.readFileSync(record, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as RecordedRun) : []

describe('agentchat listen --run, end to end', () => {
  it('texts without the conversation-run prompt (an older server): a wake runs the owner\'s command once for the tray: served wake instruction on stdin, identity in env, no key; the frame is acked first', async () => {
    const record = path.join(tmp, 'runs.jsonl')
    const script = path.join(tmp, 'agent.cjs')
    fs.writeFileSync(
      script,
      [
        "let d = ''",
        "process.stdin.on('data', (c) => (d += c))",
        "process.stdin.on('end', () => {",
        `  require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ stdin: d, handle: process.env.AGENTCHAT_HANDLE, kind: process.env.AGENTCHAT_WAKE_KIND, key: process.env.AGENTCHAT_API_KEY || null, mcp: process.env.AGENTCHAT_MCP_URL }) + '\\n')`,
        "  process.stdout.write('ok')",
        '})',
      ].join('\n'),
    )
    const controller = stoppable()
    const done = tracked(runListen(home, 'listen', { run: `"${process.execPath}" "${script}"` }, io(controller.signal)))
    // Connect → one coalesced wake → the tray count says 1 → one run.
    await until(() => fs.existsSync(record), 15_000)
    server.send({ type: 'message.new', payload: { id: 'msg_1', conversation_id: 'conv_1', sender: 'peer', content: { text: 'BODY NEVER READ' } } })
    await until(() => server.acks().includes('msg_1'), 5_000)
    controller.abort()
    expect(await done).toBe(0)

    const runs = fs.readFileSync(record, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, string | null>)
    expect(runs[0]).toMatchObject({ handle: '@probe', kind: 'wake', key: null, mcp: `${server.apiBase}/mcp` })
    expect(runs[0]?.stdin).toContain('SERVED WAKE INSTRUCTION for generic')
    expect(runs[0]?.stdin).toContain(path.join(home, 'skills', 'agentchat', 'SKILL.md'))
    // The pointer names the manual where the served texts say it is, not a constant.
    expect(runs[0]?.stdin).toContain(`the same text is at ${server.apiBase}/skill.md.)`)
    expect(runs[0]?.stdin).not.toContain(MANUAL_URL)
    expect(JSON.stringify(runs)).not.toContain('BODY NEVER READ')
    // The skill file follows the manual the texts announce.
    expect(fs.readFileSync(path.join(home, 'skills', 'agentchat', 'SKILL.md'), 'utf-8')).toContain('version: 9.0.0')
    // Texts for the generic runtime; the CLI's own client name on the hello.
    expect(server.requests.some((r) => r.startsWith('/v1/texts?runtime=generic'))).toBe(true)
    expect(server.served[0]?.hello?.['client']).toBe('agentchat-cli')
    expect(readIntegrationStatus(home)).toMatchObject({ runtime: 'command', handle: 'probe' })
    expect(lines.join('\n')).toMatch(/Listening as @probe — on each wake: run `/)
    expect(lines.join('\n')).toContain('One run per conversation that owes a reply, one at a time; the served prompt for it goes to stdin')
  }, 30_000)

  it('with the conversation-run prompt: one run per conversation that owes a reply, each told its conversation (AGENTCHAT_WAKE_KIND=conversation, AGENTCHAT_CONVERSATION_ID) and prompted for it alone; the invites get a run of their own; an inherited AGENTCHAT_CONVERSATION_ID never reaches a run', async () => {
    await conversationRunServer({ waiting: 2, invites: ['gri_1'] })
    const record = path.join(tmp, 'conversation-runs.jsonl')
    const controller = stoppable()
    const env = { ...process.env, AGENTCHAT_CONVERSATION_ID: 'conv_inherited' }
    const done = tracked(runListen(home, 'listen', { run: recordingCommand(record) }, io(controller.signal, env)))
    await until(() => readRuns(record).length >= 3, 20_000)
    await pause(300)
    controller.abort()
    expect(await done).toBe(0)
    const runs = readRuns(record)
    // Runs go one at a time, the conversations first, then the invite run.
    expect(runs.map((r) => [r.kind, r.conv])).toEqual([
      ['conversation', 'conv_0'],
      ['conversation', 'conv_1'],
      ['invite', null],
    ])
    expect(runs[0]?.stdin).toContain('SERVED CONVERSATION RUN for conv_0: only this one.')
    expect(runs[0]?.stdin).not.toContain('conv_1')
    expect(runs[1]?.stdin).toContain('SERVED CONVERSATION RUN for conv_1: only this one.')
    expect(runs[2]?.stdin).toContain('SERVED INVITE PROMPT for generic')
    expect(new Set(runs.map((r) => r.run)).size).toBe(3)
    expect(JSON.stringify(runs)).not.toContain('conv_inherited')
    expect(JSON.stringify(runs)).not.toContain('MUST NEVER BE LOGGED')
    expect(server.processingFailures).toEqual([])
    expect(readIntegrationStatus(home)?.last_run).toMatchObject({ kind: 'invite' })
  }, 40_000)
})

describe('agentchat listen --run: could not process, end to end', () => {
  it('a conversation whose run fails is reported once another conversation\'s run completes after it (`other_run_completed`: a custom command has no runtime check); the server\'s answer is followed, and status says it', async () => {
    await conversationRunServer({ waiting: 2 })
    const record = path.join(tmp, 'cnp-runs.jsonl')
    const controller = stoppable()
    const done = tracked(runListen(home, 'listen', { run: recordingCommand(record, 'conv_0') }, io(controller.signal)))
    await until(() => server.processingFailures.length === 1, 20_000)
    // `none` (the double's default answer): nothing more for conv_0.
    await pause(500)
    controller.abort()
    expect(await done).toBe(0)
    expect(server.processingFailures).toHaveLength(1)
    expect(server.processingFailures[0]).toMatchObject({ conversationId: 'conv_0', body: { through_message_id: 'msg_0', outcome: 'failed', evidence: 'other_run_completed' } })
    expect(readRuns(record).map((r) => r.conv)).toEqual(['conv_0', 'conv_1'])
    const status = readIntegrationStatus(home)
    expect(status?.could_not_process).toMatchObject({ runtime_check: false, reported: 1, none: 1, paused_conversations: [] })
    expect(formatIntegrationStatus(status).join('\n')).toContain("no runtime check for this runtime: a failed run is reported only after another conversation's run completes")
  }, 40_000)

  it('every run fails: nothing is reported (a broken command is not a conversation\'s fault); the cards wait for the server\'s re-wakes', async () => {
    await conversationRunServer({ waiting: 2 })
    const record = path.join(tmp, 'cnp-all-fail.jsonl')
    const controller = stoppable()
    const done = tracked(runListen(home, 'listen', { run: recordingCommand(record, '*') }, io(controller.signal)))
    await until(() => readRuns(record).length >= 2, 20_000)
    await pause(1_000)
    controller.abort()
    expect(await done).toBe(0)
    expect(server.processingFailures).toEqual([])
    expect(readIntegrationStatus(home)?.could_not_process).toMatchObject({ runtime_check: false, reported: 0, report_errors: 0 })
  }, 40_000)

  it('`paused`: the conversation paused for this agent is in the status file until the pause ends, said plainly', async () => {
    await conversationRunServer({ waiting: 2 })
    const pausedUntil = new Date(Date.now() + 24 * 3_600_000).toISOString()
    server.answerProcessingFailures({ action: 'paused', attempts: 3, hidden_message_ids: [], paused_until: pausedUntil })
    const record = path.join(tmp, 'cnp-paused.jsonl')
    const controller = stoppable()
    const done = tracked(runListen(home, 'listen', { run: recordingCommand(record, 'conv_0') }, io(controller.signal)))
    await until(() => (readIntegrationStatus(home)?.could_not_process?.paused_conversations.length ?? 0) === 1, 20_000)
    controller.abort()
    expect(await done).toBe(0)
    const status = readIntegrationStatus(home)
    expect(status?.could_not_process?.paused_conversations).toMatchObject([{ conversation_id: 'conv_0', paused_until: pausedUntil }])
    expect(formatIntegrationStatus(status).join('\n')).toContain(`could not process: 1 conversation paused until ${pausedUntil}`)
  }, 40_000)
})

describe('agentchat forward, end to end', () => {
  it('each wake is one POST in the agentchat dialect, with the counts from the tray', async () => {
    const hits: Array<{ auth: string | undefined; body: Record<string, unknown> }> = []
    const receiver = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        hits.push({ auth: req.headers['authorization'], body: JSON.parse(body) as Record<string, unknown> })
        res.statusCode = 202
        res.end()
      })
    })
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()))
    const address = receiver.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    try {
      const controller = stoppable()
      const done = tracked(runListen(home, 'forward', { to: `http://127.0.0.1:${address.port}/wake` }, io(controller.signal)))
      await until(() => hits.length > 0, 15_000)
      controller.abort()
      expect(await done).toBe(0)
      const secret = fs.readFileSync(path.join(home, 'forward.secret'), 'utf-8').trim()
      expect(hits[0]?.auth).toBe(`Bearer ${secret}`)
      expect(hits[0]?.body).toMatchObject({ version: 1, type: 'agentchat.wake', handle: '@probe' })
      expect(Array.isArray(hits[0]?.body['conversations'])).toBe(true)
    } finally {
      receiver.closeAllConnections()
      await new Promise<void>((r) => receiver.close(() => r()))
    }
  }, 30_000)
})

describe('agentchat forward, with the conversation-run prompt served', () => {
  it('still one POST per wake, carrying every conversation (the receiver reads the whole tray itself); no could-not-process report', async () => {
    await conversationRunServer({ waiting: 2 })
    const hits: Array<Record<string, unknown>> = []
    const receiver = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        hits.push(JSON.parse(body) as Record<string, unknown>)
        res.statusCode = 204
        res.end()
      })
    })
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()))
    const address = receiver.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    try {
      const controller = stoppable()
      const done = tracked(runListen(home, 'forward', { to: `http://127.0.0.1:${address.port}/wake` }, io(controller.signal)))
      await until(() => hits.length > 0, 15_000)
      await pause(1_000)
      controller.abort()
      expect(await done).toBe(0)
      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({ version: 1, conversations: [{ id: 'conv_0' }, { id: 'conv_1' }] })
      expect(readIntegrationStatus(home)?.last_run).toMatchObject({ kind: 'wake' })
      expect(server.processingFailures).toEqual([])
      expect(lines.join('\n')).toContain('One POST per wake, one at a time; no message content is ever in it.')
    } finally {
      receiver.closeAllConnections()
      await new Promise<void>((r) => receiver.close(() => r()))
    }
  }, 30_000)
})

describe('agentchat forward — invites and wake reasons, end to end', () => {
  it('an invite-only tray is forwarded on every wake (reason invite, the invite on board) and never dismissed; an unanswered re-wake carries its step', async () => {
    await server.close()
    server = await startServerDouble({ tray: { waiting: 0, invites: ['gri_7'] }, helloCapabilities: ['ack', 'heartbeat', 'rewake'], manual: { version: '9.0.0', body: '---\nname: agentchat\nversion: 9.0.0\n---\n\nTest manual.\n' } })
    fs.writeFileSync(path.join(home, 'credentials'), JSON.stringify({ api_key: KEY, handle: 'probe', api_base: server.apiBase }))
    const hits: Array<Record<string, unknown>> = []
    const receiver = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        hits.push(JSON.parse(body) as Record<string, unknown>)
        res.statusCode = 204
        res.end()
      })
    })
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', () => r()))
    const address = receiver.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    try {
      const controller = stoppable()
      const done = tracked(runListen(home, 'forward', { to: `http://127.0.0.1:${address.port}/wake` }, io(controller.signal)))
      await until(() => hits.length === 1, 15_000)
      expect(hits[0]).toMatchObject({ version: 1, reason: 'invite', conversations: [], invites: [{ invite_id: 'gri_7', group_id: 'grp_gri_7', invited_by: '@peer' }], summary: '' })
      expect(JSON.stringify(hits[0])).not.toContain('A GROUP NAME')
      // Two more wakes with the invite still pending: the kit would dismiss it after two completed
      // runs in single-run mode; a forward is no proof the agent saw it.
      server.send({ type: 'group.invite.received', payload: { invite_id: 'gri_7' } })
      await until(() => hits.length === 2, 15_000)
      server.setTray({ waiting: 1, invites: ['gri_7'] })
      server.send({ type: 'wake', payload: { reason: 'unanswered', conversation_ids: ['conv_0'], step: 2, at: new Date().toISOString() } })
      await until(() => hits.length === 3, 15_000)
      expect(hits[2]).toMatchObject({ reason: 'unanswered', step: 2, conversations: [{ id: 'conv_0', unread: 1, latest_sender: '@peer' }] })
      await pause(500)
      expect(server.dismissed).toEqual([])
      controller.abort()
      expect(await done).toBe(0)
    } finally {
      receiver.closeAllConnections()
      await new Promise<void>((r) => receiver.close(() => r()))
    }
  }, 60_000)
})

describe('agentchat listen --preset claude-code, end to end (fake claude)', () => {
  it('the run is `claude -p` with this agent\'s own tool config, the claude-code texts, and no key on argv', async () => {
    const fake = installFakeClaude(tmp)
    const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${originalPath ?? ''}`, FAKE_RUNTIME_RECORD: fake.recordPath, CLAUDE_CONFIG_DIR: path.join(tmp, '.claude') }
    process.env['PATH'] = env.PATH
    const controller = stoppable()
    const done = tracked(runListen(home, 'listen', { preset: 'claude-code', profile: 'answer' }, io(controller.signal, env)))
    await until(() => readFakeRuns(fake).length > 0, 20_000)
    controller.abort()
    expect(await done).toBe(0)
    const [run] = readFakeRuns(fake)
    expect(run?.argv[run.argv.indexOf('--mcp-config') + 1]).toBe(claudeMcpConfigPath(home))
    // The run names its runtime to the hosted tools (no wake-webhook tools: the listener wakes it), and this CLI as what placed it.
    const mcp = JSON.parse(fs.readFileSync(claudeMcpConfigPath(home), 'utf-8')) as { mcpServers: Record<string, { headers: Record<string, string> }> }
    expect(mcp.mcpServers['agentchat']?.headers).toMatchObject({ 'X-AgentChat-Client': 'claude-code', 'X-AgentChat-Client-Version': VERSION })
    expect(run?.stdin).toContain('SERVED WAKE INSTRUCTION for claude-code')
    // An answer run (the default) reaches neither the manual's file nor the web: no pointer to either.
    expect(run?.stdin).not.toContain('agentchat.me/skill.md')
    expect(run?.stdin).not.toContain('The AgentChat manual')
    // Its only MCP server is the listener's own tool config; who it is comes from the served texts (no CLAUDE.md in an answer run).
    expect(run?.argv.slice(run.argv.indexOf('--mcp-config'), run.argv.indexOf('--mcp-config') + 3)).toEqual(['--mcp-config', claudeMcpConfigPath(home), '--strict-mcp-config'])
    expect(run?.mcpConfig).toMatchObject({ servers: ['agentchat'] })
    expect(run?.appendedSystemPrompt).toContain('Served identity line for claude-code')
    expect(run?.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBe('1')
    // The work folder is the preset's own, beside the home — not the directory listen ran in.
    expect(fs.realpathSync(run!.cwd)).toBe(fs.realpathSync(defaultPresetWorkdir(home)))
    expect(fs.readdirSync(path.join(home, 'presets')).filter((n) => n.endsWith('.identity.md'))).toEqual([]) // the run's own file is gone with it
    // The deny list doctor builds its stand-in runner with is the one the listener's real run carried (no drift).
    if (process.platform !== 'win32') {
      const configDir = path.resolve(tmp, '.claude')
      expect(run?.argv.at(-1)).toBe(['WebFetch', 'WebSearch', 'Bash', ...readDenyRules([...claudePresetDenyPaths(home, configDir), claudeProjectsDirFor(configDir)])].join(','))
    }
    expect(JSON.stringify(run)).not.toContain(KEY)
    expect(server.requests.some((r) => r.startsWith('/v1/texts?runtime=claude-code'))).toBe(true)
  }, 40_000)

  it.skipIf(!ENGINE_HAS_OWN)('own (the default): the listener\'s own tool config without --strict-mcp-config, the identity line appended, the user\'s context and settings left alone, the key store denied', async () => {
    const fake = installFakeClaude(tmp)
    const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${originalPath ?? ''}`, FAKE_RUNTIME_RECORD: fake.recordPath, CLAUDE_CONFIG_DIR: path.join(tmp, '.claude'), AGENTCHAT_RUN_PROFILE: '' }
    process.env['PATH'] = env.PATH
    const controller = stoppable()
    const done = tracked(runListen(home, 'listen', { preset: 'claude-code' }, io(controller.signal, env)))
    await until(() => readFakeRuns(fake).length > 0, 20_000)
    controller.abort()
    expect(await done).toBe(0)
    const [run] = readFakeRuns(fake)
    const argv = run!.argv
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe(claudeMcpConfigPath(home))
    for (const flag of ['--strict-mcp-config', '--tools', '--settings', '--permission-mode']) expect(argv).not.toContain(flag)
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__agentchat__*')
    expect(run?.appendedSystemPrompt).toContain('Served identity line for claude-code')
    expect(run?.env['CLAUDE_CODE_DISABLE_CLAUDE_MDS']).toBeUndefined()
    // Its prompt says where the manual is, as it can reach it: the address the served texts announce (the home is denied to it).
    expect(run?.stdin).toContain(`(The AgentChat manual is at ${server.apiBase}/skill.md.)`)
    expect(run?.stdin).not.toContain(MANUAL_URL)
    if (process.platform !== 'win32') {
      const configDir = path.resolve(tmp, '.claude')
      expect(argv.at(-1)).toBe(readDenyRules(claudePresetDenyPaths(home, configDir)).join(','))
    }
    expect(JSON.stringify(run)).not.toContain(KEY)
  }, 40_000)
})

describe('agentchat listen --preset codex, end to end (fake codex)', () => {
  it('an answer run: Codex’s MCP servers listed first, every other one switched off, the answer flags, the key in its environment only', async () => {
    const fake = installFakeCodex(tmp)
    const lists = path.join(tmp, 'mcp-lists.jsonl')
    const listed = JSON.stringify([{ name: 'agentchat', enabled: true }, { name: 'github', enabled: true }])
    const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${originalPath ?? ''}`, FAKE_RUNTIME_RECORD: fake.recordPath, FAKE_MCP_LIST: listed, FAKE_MCP_LIST_RECORD: lists, CODEX_HOME: path.join(tmp, '.codex') }
    process.env['PATH'] = env.PATH
    const controller = stoppable()
    const done = tracked(runListen(home, 'listen', { preset: 'codex', profile: 'answer' }, io(controller.signal, env)))
    await until(() => readFakeRuns(fake).length > 0, 20_000)
    controller.abort()
    expect(await done).toBe(0)
    const [run] = readFakeRuns(fake)
    const workdir = defaultPresetWorkdir(home)
    expect(readFakeMcpLists(lists).length).toBeGreaterThan(0)
    expect(readFakeMcpLists(lists)[0]?.argv.slice(0, 3)).toEqual(['mcp', 'list', '--json'])
    const answer = codexRunArgs('answer', { workdir, mcp: { url: `${server.apiBase}/mcp`, keyEnv: 'AGENTCHAT_LISTENER_API_KEY', clientVersion: VERSION } })
    expect(run?.argv).toEqual([...answer.slice(0, -1), '-c', 'mcp_servers.github.enabled=false', '-'])
    expect(run?.stdin).toContain('SERVED WAKE INSTRUCTION for codex')
    expect(run?.stdin).not.toContain('The AgentChat manual')
    expect(run?.env['AGENTCHAT_LISTENER_API_KEY']).toBe(KEY)
    expect(run?.argv.join(' ')).not.toContain(KEY)
  }, 40_000)

  it.skipIf(!ENGINE_HAS_OWN)('own (the default): the user\'s config left alone, the key from a headers helper in the home — none in the run\'s environment; Codex is asked first that nothing else would authenticate', async () => {
    const fake = installFakeCodex(tmp)
    const lists = path.join(tmp, 'own-mcp-lists.jsonl')
    const env = { ...process.env, PATH: `${fake.binDir}${path.delimiter}${originalPath ?? ''}`, FAKE_RUNTIME_RECORD: fake.recordPath, FAKE_MCP_LIST_RECORD: lists, CODEX_HOME: path.join(tmp, '.codex'), AGENTCHAT_RUN_PROFILE: '' }
    process.env['PATH'] = env.PATH
    const controller = stoppable()
    const done = tracked(runListen(home, 'listen', { preset: 'codex' }, io(controller.signal, env)))
    await until(() => readFakeRuns(fake).length > 0, 20_000)
    controller.abort()
    expect(await done).toBe(0)
    const [run] = readFakeRuns(fake)
    const helperPath = (presets as unknown as { codexListenerHeadersHelperPath: (home: string) => string }).codexListenerHeadersHelperPath(home)
    const helper = (presets as unknown as { codexHeadersHelperCommand: (script: string) => string }).codexHeadersHelperCommand(helperPath)
    const own = codexRunArgs('own' as never, { workdir: defaultPresetWorkdir(home), mcp: { url: `${server.apiBase}/mcp`, keyEnv: 'AGENTCHAT_LISTENER_API_KEY', headersHelper: helper, clientVersion: VERSION } as never })
    expect(run?.argv).toEqual(own)
    // One listing, with the run's own flags: how Codex's agentchat entry authenticates (nothing is switched off).
    expect(readFakeMcpLists(lists)).toHaveLength(1)
    expect(readFakeMcpLists(lists)[0]?.argv).toEqual(['mcp', 'list', '--json', ...own.slice(own.indexOf('-c'), -1)])
    expect(fs.existsSync(helperPath)).toBe(true)
    expect(run?.env['AGENTCHAT_LISTENER_API_KEY']).toBeUndefined()
    expect(JSON.stringify(run)).not.toContain(KEY)
    // Its prompt says where the manual is: Codex's sandboxes read the file; and the address the served texts announce.
    expect(run?.stdin).toContain('The AgentChat manual')
    expect(run?.stdin).toContain(`the same text is at ${server.apiBase}/skill.md.)`)
  }, 40_000)
})

describe('could not process with a preset: the runtime check is the evidence (fake runtimes)', () => {
  for (const name of ['claude-code', 'codex'] as const) {
    it(`${name}: a conversation's run fails, no other run is queued, so the preset's runtime check — the fixed prompt, no AgentChat tools, no key — answers, and the failure is reported with \`runtime_check\``, async () => {
      await conversationRunServer({ waiting: 1 })
      const fake = name === 'claude-code' ? installFakeClaude(tmp) : installFakeCodex(tmp)
      const configDir = path.join(tmp, name === 'claude-code' ? '.claude' : '.codex')
      const env = {
        ...process.env,
        PATH: `${fake.binDir}${path.delimiter}${originalPath ?? ''}`,
        FAKE_RUNTIME_RECORD: fake.recordPath,
        FAKE_MCP_LIST_RECORD: path.join(tmp, `${name}-lists.jsonl`),
        // The run for conv_0 fails the way a provider refusal does; any other prompt is answered.
        FAKE_RUNTIME_FAIL_ON: 'conv_0',
        ...(name === 'claude-code' ? { CLAUDE_CONFIG_DIR: configDir } : { CODEX_HOME: configDir }),
        AGENTCHAT_RUN_PROFILE: '',
      }
      process.env['PATH'] = env.PATH
      const controller = stoppable()
      const done = tracked(runListen(home, 'listen', { preset: name }, io(controller.signal, env)))
      await until(() => server.processingFailures.length === 1, 25_000)
      controller.abort()
      expect(await done).toBe(0)
      expect(server.processingFailures[0]).toMatchObject({ conversationId: 'conv_0', body: { through_message_id: 'msg_0', outcome: 'failed', evidence: 'runtime_check' } })
      const runs = readFakeRuns(fake)
      const run = runs.find((r) => r.stdin.includes('SERVED CONVERSATION RUN for conv_0'))
      const check = runs.find((r) => r.stdin === RUNTIME_CHECK_PROMPT)
      expect(run).toBeDefined()
      expect(check).toBeDefined()
      // Nothing from any peer and no AgentChat tools in the check; no key anywhere in it.
      expect(check!.stdin).not.toContain('conv_0')
      expect(check!.argv).not.toContain('--mcp-config')
      if (name === 'claude-code') {
        expect(check!.argv.slice(check!.argv.indexOf('--tools'), check!.argv.indexOf('--tools') + 2)).toEqual(['--tools', ''])
        expect(check!.argv).toContain('--strict-mcp-config')
        expect(fs.realpathSync(check!.cwd)).toBe(fs.realpathSync(claudeRuntimeCheckWorkdir(configDir)))
      } else {
        expect(check!.argv).toContain('mcp_servers.agentchat.enabled=false')
        expect(path.basename(check!.cwd)).toBe('agentchat-runtime-check')
      }
      expect(check!.env['AGENTCHAT_API_KEY']).toBeUndefined()
      expect(check!.env['AGENTCHAT_LISTENER_API_KEY']).toBeUndefined()
      expect(JSON.stringify(check)).not.toContain(KEY)
      expect(readIntegrationStatus(home)?.could_not_process).toMatchObject({ runtime_check: true, reported: 1, runtime_checks_ok: 1 })
    }, 45_000)
  }
})

describe('agentchat watch', () => {
  it('prints frame types and ids, never content; marks own echoes; shows the wake cycle a listener would start', async () => {
    const controller = stoppable()
    const printed: string[] = []
    const done = tracked(runWatch(home, {}, { out: (l) => printed.push(l), err: (l) => printed.push(l), signal: controller.signal }))
    await until(() => printed.some((l) => l.includes('hello.ok')), 10_000)
    server.send({ type: 'message.new', payload: { id: 'msg_7', conversation_id: 'conv_7', sender: 'peer', content: { text: 'SECRET PEER BODY' } } })
    server.send({ type: 'message.new', payload: { id: 'msg_8', conversation_id: 'conv_7', sender: 'probe', content: { text: 'my own echo' } } })
    await until(() => printed.some((l) => l.includes('wake cycle')), 10_000)
    await until(() => server.acks().includes('msg_7'), 5_000)
    controller.abort()
    expect(await done).toBe(0)
    const text = printed.join('\n')
    expect(text).toMatch(/message\.new conv=conv_7 msg=msg_7 from=@peer/)
    expect(text).toMatch(/msg=msg_8 from=@probe own=true/)
    expect(text).not.toContain('SECRET PEER BODY')
    expect(text).not.toContain(KEY)
  }, 30_000)

  it('describeFrame: a wake frame and an invite are wakes; content keys are never read', () => {
    expect(describeFrame('wake', { reason: 'reminder', conversation_id: 'c', step: 2, anchor_message_id: 'm' }, 'me')).toMatchObject({ wake: true, text: 'wake reason=reminder conv=c step=2' })
    expect(describeFrame('group.invite.received', { invite_id: 'inv_1', group_id: 'grp_1', inviter_handle: 'x', group_name: 'NAME NEVER SHOWN' }, 'me')).toMatchObject({ wake: true, text: 'group.invite.received invite=inv_1 group=grp_1 from=@x' })
    expect(describeFrame('presence.update', { handle: 'x', status: 'online' }, 'me')).toMatchObject({ wake: false })
  })

  it('describeFrame: the own echo is found through the kit\'s handle normalisation (a display `@`, case, spaces)', () => {
    for (const sender of ['me', '@me', '@Me', ' @me ', '@ me']) {
      expect(describeFrame('message.new', { id: 'm', conversation_id: 'c', sender }, 'me'), sender).toMatchObject({ wake: false, facts: { own: 'true' } })
    }
    expect(describeFrame('message.new', { id: 'm', conversation_id: 'c', sender: '@meme' }, 'me')).toMatchObject({ wake: true })
    expect(describeFrame('message.new', { id: 'm', conversation_id: 'c', sender: '@meme' }, 'me').facts).not.toHaveProperty('own')
  })
})

const BUNDLE = path.join(__dirname, '..', 'dist', 'listener-daemon.js')

describe('the installed listener: the self-contained bundle a service runs', () => {
  it.skipIf(!fs.existsSync(BUNDLE))('copied to a bare directory, it reads listener.json, connects and runs the command on a wake', async () => {
    const bare = path.join(tmp, 'bare')
    fs.mkdirSync(bare)
    fs.copyFileSync(BUNDLE, path.join(bare, 'agentchat-listener.mjs'))
    const record = path.join(tmp, 'service-run.txt')
    // Diagnostics: each run appends a start and an end line to `runs.log` and
    // keeps its own stdin in `run-<pid>.txt`, after the shared record is written
    // exactly as before (so the record's timing is unchanged).
    const runsLog = path.join(tmp, 'runs.log')
    const runsDir = path.join(tmp, 'runs')
    fs.mkdirSync(runsDir)
    const script = path.join(tmp, 'agent.cjs')
    fs.writeFileSync(script, [
      `const fs=require('node:fs'),p=require('node:path');`,
      `fs.appendFileSync(${JSON.stringify(runsLog)}, 'start pid='+process.pid+' t='+Date.now()+'\\n');`,
      `let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{`,
      `fs.writeFileSync(${JSON.stringify(record)}, d);`,
      `fs.writeFileSync(p.join(${JSON.stringify(runsDir)}, 'run-'+process.pid+'.txt'), d);`,
      `fs.appendFileSync(${JSON.stringify(runsLog)}, 'end pid='+process.pid+' bytes='+Buffer.byteLength(d)+' t='+Date.now()+'\\n');`,
      `process.stdout.write('ok')})`,
    ].join(''))
    writeListenerConfig(home, { version: 1, mode: 'run', command: `"${process.execPath}" "${script}"`, workdir: path.join(tmp, 'work'), updated_at: new Date().toISOString() })
    const started = Date.now()
    const child = spawn(process.execPath, [path.join(bare, 'agentchat-listener.mjs'), '--home', home], { cwd: bare, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (c) => (log += String(c)))
    child.stderr.on('data', (c) => (log += String(c)))
    let firstRead: string | null = null
    let seenAt = 0
    const diagnose = async (): Promise<string> => {
      await pause(1_500)
      const reread = fs.existsSync(record) ? fs.readFileSync(record, 'utf-8') : null
      const runs = fs.readdirSync(runsDir).map((f) => {
        const body = fs.readFileSync(path.join(runsDir, f), 'utf-8')
        return `${f} bytes=${Buffer.byteLength(body)} instruction=${body.includes('SERVED WAKE INSTRUCTION for generic')}`
      })
      const runLines = fs.existsSync(runsLog) ? fs.readFileSync(runsLog, 'utf-8').trim().split('\n') : []
      return [
        `[bundle-diag] platform=${process.platform} node=${process.version} listener started t=${started} record seen t=${seenAt} (+${seenAt - started} ms)`,
        `[bundle-diag] first read bytes=${firstRead === null ? 'none' : Buffer.byteLength(firstRead)}; re-read after 1.5 s bytes=${reread === null ? 'none' : Buffer.byteLength(reread)} instruction=${reread?.includes('SERVED WAKE INSTRUCTION for generic') ?? false}`,
        `[bundle-diag] command starts=${runLines.filter((l) => l.startsWith('start')).length} ends=${runLines.filter((l) => l.startsWith('end')).length}`,
        ...runLines.map((l) => `[bundle-diag]   ${l}`),
        ...runs.map((r) => `[bundle-diag]   ${r}`),
      ].join('\n')
    }
    try {
      await until(() => fs.existsSync(record), 20_000)
      seenAt = Date.now()
      firstRead = fs.readFileSync(record, 'utf-8')
      try {
        expect(firstRead).toContain('SERVED WAKE INSTRUCTION for generic')
        expect(log).toContain('listener resident')
        expect(log).not.toMatch(/Dynamic require|Cannot find module/)
      } catch (error) {
        console.error(`${await diagnose()}\n[bundle-diag] listener log:\n${log}`)
        throw error
      }
      console.log(await diagnose())
    } finally {
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    }
  }, 40_000)
})

describe.skipIf(process.platform === 'win32' || !fs.existsSync(BUNDLE))('POSIX only (permission bits; Windows ACLs are not checked): the installed listener refuses a config that is not yours alone', () => {
  it('a group-writable listener.json: logged once, nothing run, still resident', async () => {
    const bare = path.join(tmp, 'bare-refuse')
    fs.mkdirSync(bare)
    fs.copyFileSync(BUNDLE, path.join(bare, 'agentchat-listener.mjs'))
    const record = path.join(tmp, 'must-not-run.txt')
    const script = path.join(tmp, 'agent-refuse.cjs')
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(record)}, 'ran')`)
    writeListenerConfig(home, { version: 1, mode: 'run', command: `"${process.execPath}" "${script}"`, workdir: path.join(tmp, 'work'), updated_at: new Date().toISOString() })
    fs.chmodSync(home, 0o700)
    fs.chmodSync(path.join(home, 'listener.json'), 0o660)
    const child = spawn(process.execPath, [path.join(bare, 'agentchat-listener.mjs'), '--home', home], { cwd: bare, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', (c) => (log += String(c)))
    child.stderr.on('data', (c) => (log += String(c)))
    try {
      await until(() => /writable by its group/.test(log), 10_000)
      await pause(1_500)
      expect(fs.existsSync(record)).toBe(false)
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    }
  }, 30_000)
})
