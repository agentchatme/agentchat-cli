import * as fs from 'node:fs'
import * as path from 'node:path'
import { ensureForwardSecret, forwardSecretPath, forwardUrlProblem } from './listener/forward.js'
import { defaultPresetWorkdir, describeListenerConfig, ListenerConfigSchema, readListenerConfig, writeListenerConfig, type ListenerConfig, type ListenerConfigInput } from './listener/config.js'
import { INTEGRATION_ENV, INTEGRATION_ENV_LEGACY, isRunProfile, PEER_RUN_WARNING, resolveIdentity, resolveRunProfile } from '@agentchatme/agent-core'
import { runIntegration } from '@agentchatme/agent-core/daemon'
import { presetNamed, presetNames } from '@agentchatme/agent-core/presets'
import { invocation, offByLegacySwitch } from './home.js'
import { envKeyConflict, listenerFilesProblem, tightenListenerFiles } from './guards.js'
import { planListener, type PlanOptions } from './runners.js'
import { installListenerService, listenerServiceStatus, uninstallListenerService } from './service.js'

// ─── `agentchat listen` / `agentchat forward` ───────────────────────────────
//
// One resident loop, three things it can do on a wake (listener.json modes):
// run the owner's command, run a known coding agent's headless mode (a
// preset), or forward the wake to the owner's endpoint. In the foreground it
// runs what the flags say until Ctrl-C; with `--install` the choice is written
// to `<home>/listener.json` and a background service runs it from then on.
// One listener per identity home (the engine's leader lock): a foreground
// listener on a home whose service is running is refused.
//
// Where a run works. `--run` and `forward`: the directory `listen` ran in
// (`--workdir` to change it) — the owner's command decides what it reads, and
// its relative paths mean what they meant in that shell. A preset: a folder of
// its own beside the home (`defaultPresetWorkdir`), in every profile. A
// preset's run is started by any peer's message, a stranger's cold DM
// included: an `answer` run reads every file in its work folder, and a `work`
// run edits there without asking, so the default is an empty folder rather
// than whatever directory the install happened to run in; `--workdir <dir>`
// is the opt-in to give runs a project. A re-install keeps the folder the
// installed preset listener already has, and any change to an installed
// listener's folder that the flags did not ask for is said in one line.

export interface ListenFlags {
  readonly run?: string | undefined
  readonly preset?: string | undefined
  readonly profile?: string | undefined
  readonly to?: string | undefined
  readonly workdir?: string | undefined
  /** Seconds. */
  readonly budget?: string | undefined
  readonly withKey?: boolean | undefined
  readonly install?: boolean | undefined
  readonly uninstall?: boolean | undefined
}

export interface ListenIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  /** Tests: end a foreground listener. */
  readonly signal?: AbortSignal
  /** Tests: what a signal-initiated shutdown calls last. */
  readonly exit?: (code: number) => void
  /** Tests: the bundle the service copies. */
  readonly shipped?: string
  readonly plan?: PlanOptions
}

/** A listener config the flags describe, and a line to print when its work folder is not the one the flags or the installed listener named. */
type Built = { ok: true; config: ListenerConfigInput; workdirNote?: string } | { ok: false; error: string }

export interface FlagsIo {
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  /** The identity home: a preset's default work folder sits beside it. */
  readonly home: string
  /** The installed listener's config (`--install` only): its work folder is kept when the flags name none. */
  readonly saved?: ListenerConfig | null
}

function budgetMs(raw: string | undefined): number | undefined | Error {
  if (raw === undefined) return undefined
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 7_200) return new Error('--budget is seconds, 1–7200')
  return Math.round(seconds * 1000)
}

/**
 * A preset's work folder when the flags name none: the installed preset
 * listener's (kept), else a folder of its own beside the home. With the line
 * that says so when that is not the installed listener's folder.
 */
function presetWorkdir(io: FlagsIo): { workdir: string; note?: string } {
  const saved = io.saved ?? null
  if (saved !== null && saved.mode === 'preset') return { workdir: saved.workdir, note: `Work folder: ${saved.workdir}, kept from the installed listener (--workdir <dir> changes it).` }
  const workdir = defaultPresetWorkdir(io.home)
  if (saved !== null && saved.mode !== 'forward' && path.resolve(saved.workdir) !== workdir) {
    return { workdir, note: `Work folder: ${workdir}, a folder of its own for the preset's runs; the installed listener used ${saved.workdir} (--workdir ${saved.workdir} keeps that).` }
  }
  return { workdir }
}

/** The listener config the flags describe. Pure apart from reading `env` and `io.saved`. */
export function configFromFlags(mode: 'listen' | 'forward', flags: ListenFlags, io: FlagsIo): Built {
  const budget = budgetMs(flags.budget)
  if (budget instanceof Error) return { ok: false, error: budget.message }
  const preset = mode === 'listen' && flags.preset !== undefined && flags.run === undefined
  const chosen = flags.workdir !== undefined ? { workdir: path.resolve(io.cwd, flags.workdir) } : preset ? presetWorkdir(io) : { workdir: path.resolve(io.cwd) }
  const workdir = chosen.workdir
  const note = chosen.note !== undefined ? { workdirNote: chosen.note } : {}
  const common = { version: 1 as const, workdir, ...(budget !== undefined ? { budget_ms: budget } : {}), updated_at: new Date().toISOString() }

  if (mode === 'forward') {
    if (flags.run !== undefined || flags.preset !== undefined) return { ok: false, error: '`forward` takes --to only; `listen` runs a command' }
    if (flags.to === undefined) return { ok: false, error: `Missing --to. Usage: ${invocation(io.env)} forward --to http://localhost:<port>/<path>` }
    const problem = forwardUrlProblem(flags.to)
    if (problem !== null) return { ok: false, error: problem }
    return { ok: true, config: { ...common, mode: 'forward', url: flags.to } }
  }

  if (flags.to !== undefined) return { ok: false, error: '--to belongs to `forward`' }
  if (flags.run !== undefined && flags.preset !== undefined) return { ok: false, error: 'pass --run or --preset, not both' }
  if (flags.run !== undefined) {
    if (flags.run.trim().length === 0) return { ok: false, error: '--run needs a command' }
    if (flags.profile !== undefined) return { ok: false, error: '--profile belongs to a preset; your command decides what its runs may do' }
    return { ok: true, config: { ...common, mode: 'run', command: flags.run, with_key: flags.withKey === true }, ...note }
  }
  if (flags.preset !== undefined) {
    if (flags.withKey === true) return { ok: false, error: '--with-key belongs to --run; a preset hands its runs the key itself' }
    if (presetNamed(flags.preset) === null) return { ok: false, error: `unknown preset "${flags.preset}" (presets: ${presetNames().join(', ')})` }
    if (flags.profile !== undefined && !isRunProfile(flags.profile)) {
      return { ok: false, error: `--profile is answer, work or full (answer, the default: the AgentChat tools and reads inside the run's work folder only; work and full: ${PEER_RUN_WARNING})` }
    }
    const profile = flags.profile !== undefined && isRunProfile(flags.profile) ? flags.profile : resolveRunProfile(io.env)
    return { ok: true, config: { ...common, mode: 'preset', preset: flags.preset, profile }, ...note }
  }
  return { ok: false, error: `Missing what to run. Usage: ${invocation(io.env)} listen --run "<command>"  or  ${invocation(io.env)} listen --preset <${presetNames().join('|')}>` }
}

export async function runListen(home: string, mode: 'listen' | 'forward', flags: ListenFlags, io: ListenIo): Promise<number> {
  const env = io.env ?? process.env
  const cwd = io.cwd ?? process.cwd()
  const cli = invocation(env)

  if (flags.uninstall === true) {
    try {
      const { label } = uninstallListenerService(home)
      io.out(`Listener service ${label} removed. ${home}/listener.json is kept; \`${cli} listen --install\` brings it back.`)
      return 0
    } catch (err) {
      io.err(`Could not remove the listener service: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  // The listener serves the home's agent only; an exported key that is another agent's is a split.
  const conflict = envKeyConflict(home, env)
  if (conflict !== null) {
    io.err(conflict)
    return 1
  }

  // `listen --install` with nothing else re-installs what is saved.
  const nothingGiven = flags.run === undefined && flags.preset === undefined && flags.to === undefined
  let config: ListenerConfig
  let workdirNote: string | null = null
  if (flags.install === true && nothingGiven && mode === 'listen') {
    const saved = readListenerConfig(home)
    if (!saved.ok) {
      io.err(`${saved.error}. Say what to run: ${cli} listen --run "<command>" --install`)
      return 1
    }
    config = saved.config
  } else {
    const saved = flags.install === true ? readListenerConfig(home) : null
    const built = configFromFlags(mode, flags, { env, cwd, home, saved: saved?.ok === true ? saved.config : null })
    if (!built.ok) {
      io.err(built.error)
      return 1
    }
    workdirNote = built.workdirNote ?? null
    if (flags.install === true) config = writeListenerConfig(home, built.config)
    else {
      const parsed = ListenerConfigSchema.safeParse(built.config)
      if (!parsed.success) {
        io.err(parsed.error.issues[0]?.message ?? 'invalid listener config')
        return 1
      }
      config = parsed.data
    }
  }

  let plan
  try {
    plan = planListener(home, config, { env, ...io.plan })
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err))
    return 1
  }
  const identity = resolveIdentity(home, { envKey: false })
  const forwardNote = config.mode === 'forward' ? [`Bearer secret: ${forwardSecretPath(home)} — your endpoint checks \`Authorization: Bearer <that file's contents>\`.`] : []
  // A preset's own folder is created here, owner-only, so it is there (and the
  // owner's alone) before the first run and for `doctor`. A folder the owner named is theirs.
  if (config.mode === 'preset' && config.workdir === defaultPresetWorkdir(home)) {
    try {
      fs.mkdirSync(config.workdir, { recursive: true, mode: 0o700 })
    } catch (err) {
      io.err(`Could not create the work folder ${config.workdir}: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }
  const workdirLines = workdirNote !== null ? [workdirNote] : []

  if (flags.install === true) {
    if (config.mode === 'forward') ensureForwardSecret(home)
    // The boot service runs what listener.json says: it and the home must be
    // the owner's own, or the service will refuse them at every start.
    const tightened = tightenListenerFiles(home)
    const unsafe = listenerFilesProblem(home)
    if (unsafe !== null) {
      io.err(`Not installing: ${unsafe}. The service runs the command in ${home}/listener.json at every login, so only you may own and write it.`)
      return 1
    }
    for (const line of tightened) io.out(`Tightened ${line} (the home holds the key; the config is the service's command line).`)
    try {
      const { label } = installListenerService(home, { extraEnv: plan.preset?.serviceEnv ?? [], env, ...(io.shipped !== undefined ? { shipped: io.shipped } : {}) })
      io.out(
        [
          `Listener installed (${label}): ${describeListenerConfig(config)}.`,
          ...workdirLines.map((l) => `  ${l}`),
          `  ${listenerServiceStatus(home)}`,
          ...(offByLegacySwitch(env) ? [`  Held off: ${INTEGRATION_ENV_LEGACY}=${env[INTEGRATION_ENV_LEGACY]?.trim() ?? 'off'}, the old name of ${INTEGRATION_ENV}, is captured as ${INTEGRATION_ENV}=off — the service holds no socket and starts no run; set ${INTEGRATION_ENV}=off instead.`] : []),
          ...forwardNote.map((l) => `  ${l}`),
          identity === null
            ? `  It idles until this home has an identity: \`${cli} register\` or \`${cli} login\`.`
            : `  Acting as @${identity.handle ?? '?'}; one run at a time, the served wake instruction on stdin.`,
          `  \`${cli} status\` shows what it does; \`${cli} listen --uninstall\` removes it.`,
        ].join('\n'),
      )
      return 0
    } catch (err) {
      io.err(`Could not install the listener service: ${err instanceof Error ? err.message : String(err)}`)
      return 1
    }
  }

  if (identity === null) {
    io.err(`No AgentChat identity in ${home}. Set one up first: ${cli} register --email <email> --handle <handle>   (or ${cli} login)`)
    return 1
  }
  if (config.mode === 'forward') ensureForwardSecret(home)
  io.out(
    [
      `Listening as @${identity.handle ?? '?'} — on each wake: ${describeListenerConfig(config).replace(/^runs/, 'run').replace(/^forwards/, 'forward')}.`,
      ...workdirLines,
      ...forwardNote,
      'One run at a time; the served wake instruction goes to stdin; no message content is ever on a command line. Ctrl-C stops.',
    ].join('\n'),
  )
  const code = await runIntegration({
    home,
    workdir: config.workdir,
    runner: plan.runner,
    client: plan.client,
    manualPointer: plan.manualPointer,
    manualPath: plan.manualPath,
    ...(config.mode === 'preset' ? { profile: config.profile } : {}),
    ...(config.budget_ms !== undefined ? { budgetMs: config.budget_ms } : {}),
    // The home's agent only, never an exported key's.
    credentialsFromHomeOnly: true,
    // A receiver's 2xx is no proof the agent saw an invite: never dismiss one in forward mode.
    dismissIgnoredInvites: config.mode !== 'forward',
    env,
    ...(io.signal !== undefined ? { signal: io.signal } : {}),
    ...(io.exit !== undefined ? { exit: io.exit } : {}),
  })
  if (code !== 0) io.err(`Another listener already serves ${home} (the installed service, or another terminal). \`${cli} status\` shows it.`)
  return code
}
