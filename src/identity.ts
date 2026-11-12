import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { alwaysOnWanted, checkManual, DEFAULT_API_BASE, createIdentityCommands, describeManualSync, probeHostedMcp, readCredentials, renderAnchorBlock, resolveIdentity, syncManual, workdirExposesHome, type DoctorCheck, type DoctorContext, type HostProfile, type IdentityCommands, type RunProfile, type ServedManual, type StatusContext } from '@agentchatme/agent-core'
import { describeListenerConfig, readListenerConfig, type ListenerConfig } from './listener/config.js'
import { forwardUrlProblem, readForwardSecret } from './listener/forward.js'
import {
  CLAUDE_CODE_PRESET,
  CODEX_PRESET,
  ClaudeRunner,
  claudeAnswerFallbackWorkdir,
  claudeConfigDirFrom,
  claudeHomeFor,
  claudeMcpConfigPath,
  claudeUserStatePathFor,
  codexAnswerFallbackWorkdir,
  codexHomeFrom,
  deniedAncestorOf,
  inexpressibleDenyPaths,
  presetNamed,
  type Preset,
} from '@agentchatme/agent-core/presets'
import { cliClient, invocation, manualPathFor } from './home.js'
import { VERSION } from './version.js'
import { installListenerService, listenerServiceCurrent, listenerServiceStatus } from './service.js'
import { envKeyConflict, listenerFilesProblem } from './guards.js'

// ─── This agent, described once, for the identity commands ──────────────────
//
// register / login / recover / status / logout / doctor are the engine's flows
// (`createIdentityCommands`); this file says which home they act on and what
// "placing" means for a listener: the served manual kept at
// `<home>/skills/agentchat/SKILL.md`. There is no instruction file to put an
// identity line in — the listener runs an owner's command — so none is placed.
// Signing out also removes what carries the key besides `credentials`: a
// preset's tool config under `<home>/presets/`, and whatever a preset run cut
// off left beside it (a Claude Code answer run's identity-line file).

const PRESET_FILES_DIR = 'presets'

/**
 * Everything in `<home>/presets/`: a preset's tool config (`--mcp-config`,
 * it holds the key) and the files a run writes for itself there and removes
 * when it ends (`claude-code.mcp.<run id>.identity.md`), left behind by a run
 * cut off. The folder goes too. Removed on logout (and by `listen --uninstall`).
 */
export function removeKeyFiles(home: string): string[] {
  const dir = path.join(home, PRESET_FILES_DIR)
  if (!fs.existsSync(dir)) return []
  const removed: string[] = []
  for (const name of fs.readdirSync(dir)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true })
      removed.push(name)
    } catch {
      /* best effort */
    }
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    /* not empty, or already gone */
  }
  return removed.length > 0 ? [`  removed ${removed.length} preset file(s) from ${dir}: the tool config that holds the key, and what an interrupted run left`] : []
}

/**
 * The preset runner's own preflight — the gate the listener applies before it
 * holds the socket — in its words. For `answer` that includes Claude Code's
 * refusal while a settings file lists `permissions.additionalDirectories`, and
 * Codex's while one of its MCP servers cannot be switched off for a run (its
 * listing runs, with the listener's key in its environment, as the
 * listener's would).
 *
 * Built as the listener builds it, with one difference: nothing is written. The
 * listener writes a Claude Code run's tool config (it holds the key) when it
 * starts; a doctor must never rewrite the one a running listener's runs use
 * (the shell running doctor may name another API base), so here an answer
 * runner is given a stand-in for it at the same path, which preflight checks
 * but never reads or writes, and the deny list of the preset's own runner
 * (`claudeCodePreset.runner` in agent-core). Like the listener, preflight
 * creates the work folder when there is none.
 */
/**
 * What a Claude Code preset run's file tools are denied: the listener's home
 * (its key and tool config), the user-scope MCP state and an integration's
 * identity home beside it. The list `claudeCodePreset.runner` in agent-core
 * builds — a test runs the real listener and holds the two equal.
 */
export function claudePresetDenyPaths(home: string, configDir: string | undefined): string[] {
  return [home, claudeUserStatePathFor(configDir), path.join(claudeHomeFor(configDir), 'agentchat')]
}

/**
 * The key stores a preset run working in `workdir` could read: for Claude Code
 * those its deny rules cannot carry there (Windows; a comma or whitespace in
 * the path), for Codex — whose answer run's `apply_patch` reads its working
 * root, and whose other runs read anything — the listener's home and
 * `$CODEX_HOME` (its `.env`) whenever they are inside it.
 */
function keyStoresInside(preset: Preset, home: string, workdir: string, env: NodeJS.ProcessEnv): string[] {
  const inside = (paths: string[]): string[] => paths.filter((p) => deniedAncestorOf(p, [workdir]) !== null)
  if (preset.name === CLAUDE_CODE_PRESET) return inexpressibleDenyPaths(inside(claudePresetDenyPaths(home, claudeConfigDirFrom(env))))
  if (preset.name === CODEX_PRESET) return inside([home, codexHomeFrom(env)])
  return []
}

export async function presetPreflightCheck(home: string, preset: Preset, profile: RunProfile, workdir: string, env: NodeJS.ProcessEnv, apiBase: string): Promise<DoctorCheck> {
  const key = readCredentials(home)?.api_key ?? null
  if (key === null) return check('preset-preflight', 'WARN', `not checked: no identity in ${home} (the listener idles until this home signs in)`)
  let pre
  if (preset.name === CLAUDE_CODE_PRESET) {
    const configDir = claudeConfigDirFrom(env)
    const runner = new ClaudeRunner({
      configDir,
      workdir,
      profile,
      denyReadPaths: claudePresetDenyPaths(home, configDir),
      ...(profile === 'answer' ? { answerMcp: { file: claudeMcpConfigPath(home), apiBase, apiKey: () => null } } : {}),
      inexpressibleDeny: process.platform === 'win32' ? 'warn' : 'refuse',
      env,
    })
    pre = await runner.preflight()
  } else if (preset.name === CODEX_PRESET) {
    pre = await preset.runner({ home, workdir, profile, apiKey: key, apiBase, env, clientVersion: VERSION }).preflight()
  } else {
    return check('preset-preflight', 'WARN', `not checked: this build cannot check the ${preset.label} preset without starting it`)
  }
  return pre.ok
    ? check('preset-preflight', 'PASS', `${preset.label}: the listener can start a run (the preset's preflight passes)`)
    : check('preset-preflight', 'FAIL', `${preset.label}: no run starts: ${pre.detail ?? "the preset's preflight failed"}`)
}

/** The folder an answer run of `preset` works in when its work folder is the home folder or contains it. */
function answerFallbackFor(preset: Preset, env: NodeJS.ProcessEnv): string | null {
  if (preset.name === CLAUDE_CODE_PRESET) return claudeAnswerFallbackWorkdir(claudeConfigDirFrom(env))
  if (preset.name === CODEX_PRESET) return codexAnswerFallbackWorkdir(codexHomeFrom(env))
  return null
}

function check(name: string, verdict: DoctorCheck['verdict'], detail: string): DoctorCheck {
  return { name, verdict, detail }
}

/** What the configured listener needs to work, as doctor checks. */
export async function listenerChecks(home: string, config: ListenerConfig, env: NodeJS.ProcessEnv = process.env, apiBase: string = DEFAULT_API_BASE): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [check('listener', 'PASS', describeListenerConfig(config))]
  // What the boot service refuses: someone else's (or a shared-writable) home or config.
  const unsafe = listenerFilesProblem(home)
  checks.push(unsafe === null ? check('listener-files', 'PASS', `${home} and listener.json are yours alone`) : check('listener-files', 'FAIL', `${unsafe} — the service refuses to run it; \`${invocation(env)} listen --install\` tightens files you own`))
  const preset = config.mode === 'preset' ? presetNamed(config.preset) : null
  // A preset first: its preflight creates the work folder when there is none,
  // as the listener's does when it starts, so the folder is then judged as the
  // listener will find it.
  const presetChecks: DoctorCheck[] = []
  if (config.mode === 'preset') {
    if (preset === null) presetChecks.push(check('preset', 'FAIL', `unknown preset "${config.preset}"`))
    else {
      const inspected = await preset.inspect(env)
      presetChecks.push(check('preset', inspected.ok ? 'PASS' : 'FAIL', `${preset.label}: ${inspected.detail}`))
      // The hosted-tool configuration a run of this preset will see (no key printed).
      for (const line of preset.describeMcp({ home, apiBase, env })) presetChecks.push(check('preset-mcp', 'PASS', line))
      // The runner's own gate needs a working, signed-in runtime first; the check above says when it is not.
      if (inspected.ok) presetChecks.push(await presetPreflightCheck(home, preset, config.profile, config.workdir, env, apiBase))
    }
  }
  let workdirOk = true
  try {
    workdirOk = fs.statSync(config.workdir).isDirectory()
  } catch {
    workdirOk = false
  }
  if (config.mode !== 'forward') {
    const stores = preset !== null && workdirOk ? keyStoresInside(preset, home, config.workdir, env) : []
    if (!workdirOk) {
      checks.push(
        config.mode === 'preset'
          ? check('workdir', 'WARN', `${config.workdir} does not exist yet — the listener creates it (owner-only) when it starts`)
          : check('workdir', 'FAIL', `${config.workdir} does not exist — create it, or re-run \`${invocation(env)} listen … --install\` with \`--workdir <dir>\``),
      )
    } else if (config.mode === 'preset' && workdirExposesHome(config.workdir)) {
      // A preset run started by a peer's message would see the whole home there.
      const fallback = preset !== null ? answerFallbackFor(preset, env) : null
      checks.push(
        check(
          'workdir',
          'WARN',
          `${config.workdir} is your home folder or contains it — ${
            config.profile === 'answer' && fallback !== null ? `answer runs work in ${fallback} instead` : "a run started by a peer's message there can see everything under it"
          }; re-run \`${invocation(env)} listen --preset ${config.preset} --install --workdir <a folder of its own>\``,
        ),
      )
    } else if (config.mode === 'preset' && stores.length > 0) {
      checks.push(
        check(
          'workdir',
          'WARN',
          `${config.workdir} contains ${stores.join(' and ')}, where a key is, and a run working there can read it; re-run \`${invocation(env)} listen --preset ${config.preset} --install --workdir <a folder of its own>\``,
        ),
      )
    } else {
      checks.push(check('workdir', 'PASS', config.workdir))
    }
  }
  checks.push(...presetChecks)
  if (config.mode === 'forward') {
    const problem = forwardUrlProblem(config.url)
    checks.push(problem === null ? check('forward', 'PASS', config.url) : check('forward', 'FAIL', problem))
    checks.push(
      readForwardSecret(home) !== null
        ? check('forward-secret', 'PASS', `${path.join(home, 'forward.secret')} (the receiver checks Authorization: Bearer against it)`)
        : check('forward-secret', 'WARN', 'not created yet — the listener creates it on start'),
    )
  }
  return checks
}

function serviceCheck(home: string, config: ListenerConfig | null, fix: boolean): DoctorCheck | null {
  if (!alwaysOnWanted(home)) return null
  const extraEnv = config?.mode === 'preset' ? (presetNamed(config.preset)?.serviceEnv ?? []) : []
  if (listenerServiceCurrent(home, { extraEnv })) return check('service', 'PASS', listenerServiceStatus(home))
  if (fix && config !== null) {
    try {
      installListenerService(home, { extraEnv })
      return check('service', 'PASS', `re-installed — ${listenerServiceStatus(home)}`)
    } catch (err) {
      return check('service', 'FAIL', `could not re-install: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return check('service', 'FAIL', `installed but not current (an older version, or its definition changed) — \`${invocation()} doctor --fix\` re-installs it`)
}

async function manualCheck(home: string, manual: ServedManual | null, apiBase: string | null, fix: boolean): Promise<DoctorCheck> {
  const file = manualPathFor(home)
  if (fix) {
    const result = await syncManual({ path: file, served: manual, apiBase })
    return check('manual', result.state === 'failed' ? 'FAIL' : result.state === 'current' || result.state === 'updated' ? 'PASS' : 'WARN', describeManualSync(result))
  }
  const checked = checkManual({ path: file, served: manual, apiBase })
  return check('manual', checked.verdict, checked.detail)
}

/** `~/.agentchat` for a home under the user's home directory; the full path otherwise. What output calls this agent. */
export function homeLabel(home: string): string {
  const user = os.homedir()
  return home === user || home.startsWith(user + path.sep) ? `~${home.slice(user.length)}` : home
}

export function cliProfile(home: string, env: NodeJS.ProcessEnv = process.env): HostProfile {
  return {
    label: homeLabel(home),
    id: 'agentchat-cli',
    client: cliClient(),
    home: () => home,
    invocation: () => invocation(env),
    renderAnchor: renderAnchorBlock,
    place: async (_handle, _apiKey, _identityLine, manual) => {
      const identity = resolveIdentity(home)
      const result = await syncManual({ path: manualPathFor(home), served: manual, apiBase: identity?.apiBase ?? null })
      return [`  manual: ${describeManualSync(result)}`]
    },
    unplace: () => removeKeyFiles(home),
    logoutHints: () => (alwaysOnWanted(home) ? [`The listener service stays installed and idles until you sign in again; \`${invocation(env)} listen --uninstall\` removes it.`] : []),
    extraStatus: async ({ manual }: StatusContext): Promise<string[]> => {
      const identity = resolveIdentity(home)
      const read = readListenerConfig(home)
      const lines = ['Listener:']
      lines.push(read.ok ? `  ✓ ${describeListenerConfig(read.config)}` : `  ○ none installed — \`${invocation(env)} listen --run "<command>" --install\``)
      if (alwaysOnWanted(home)) lines.push(`  service: ${listenerServiceStatus(home)}`)
      const manualState = checkManual({ path: manualPathFor(home), served: manual, apiBase: identity?.apiBase ?? null })
      lines.push(`  ${manualState.verdict === 'PASS' ? '✓' : '✗'} manual: ${manualState.detail}`)
      if (identity !== null) {
        const reach = await probeHostedMcp({ apiKey: identity.apiKey, apiBase: identity.apiBase, client: cliClient() })
        lines.push(`  ${reach.ok ? '✓' : '✗'} hosted tools: ${reach.ok ? `${reach.serverName ?? 'reachable'} ${reach.serverVersion ?? ''}`.trim() : (reach.error ?? 'unreachable')}`)
      }
      return lines
    },
    extraDoctorChecks: async (ctx: DoctorContext): Promise<DoctorCheck[]> => {
      const identity = resolveIdentity(home)
      const checks: DoctorCheck[] = [await manualCheck(home, ctx.manual, identity?.apiBase ?? null, ctx.fix === true)]
      const conflict = envKeyConflict(home, env)
      if (conflict !== null) checks.push(check('listener-identity', 'WARN', `the listener will not start: ${conflict}`))
      const read = readListenerConfig(home)
      let config: ListenerConfig | null = null
      if (read.ok) {
        config = read.config
        checks.push(...(await listenerChecks(home, config, env, identity?.apiBase ?? DEFAULT_API_BASE)))
      } else if (fs.existsSync(path.join(home, 'listener.json'))) {
        checks.push(check('listener', 'FAIL', read.error))
      } else {
        checks.push(check('listener', 'PASS', 'none installed (tools and a foreground `listen` still work)'))
      }
      const service = serviceCheck(home, config, ctx.fix === true)
      if (service !== null) checks.push(service)
      if (identity !== null) {
        const reach = await probeHostedMcp({ apiKey: identity.apiKey, apiBase: identity.apiBase, client: cliClient() })
        checks.push(check('hosted-tools', reach.ok ? 'PASS' : 'FAIL', reach.ok ? `${reach.serverName ?? 'reachable'} ${reach.serverVersion ?? ''}`.trim() : (reach.error ?? 'unreachable')))
      }
      return checks
    },
  }
}

export function cliIdentityCommands(home: string, env: NodeJS.ProcessEnv = process.env): IdentityCommands {
  return createIdentityCommands(cliProfile(home, env))
}
