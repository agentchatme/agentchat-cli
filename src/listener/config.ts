import * as path from 'node:path'
import { z } from 'zod'
import { PEER_RUN_WARNING, RUN_PROFILES } from '@agentchatme/agent-core'
import { presetNamed } from '@agentchatme/agent-core/presets'
import { atomicWriteFile, readJsonFile } from '@agentchatme/agent-core'

// ─── What the installed listener runs ───────────────────────────────────────
//
// `agentchat listen --install` writes the owner's choice into the identity
// home (`listener.json`, owner-only) and registers a service that runs
// `node <durable listener> --home <home>`. The service reads this file, and
// only this file, to know what to run: the command is the owner's, written by
// the owner, never anything a wake or a message could supply. A foreground
// `agentchat listen` does not need the file; it runs what its flags say.
//
//   run      the owner's command line, through the shell, prompt on stdin
//   preset   a known coding agent's headless mode (`--preset <name>`) with a
//            run profile, acting as this home's agent: `own` (the default:
//            the coding agent's own permission settings, with anything that
//            would ask refused); `answer` gives a run the AgentChat tools and
//            reads inside its work folder only; with `work` or `full`, runs
//            started by peers' messages can read and change this machine. The
//            profile is recorded here at install, so an installed listener
//            keeps it until it is installed again (a file without one, which
//            this CLI never writes, is read as `answer`)
//   forward  each wake POSTed to the owner's endpoint (the `agentchat` dialect)

export const LISTENER_CONFIG_FILE = 'listener.json'

const Common = {
  version: z.literal(1),
  /** The run's working directory (the owner's, chosen at install). */
  workdir: z.string().min(1),
  /** A run is killed past this. Absent: `AGENTCHAT_RUN_BUDGET_MS`, then 10 min. */
  budget_ms: z.number().int().min(1_000).max(2 * 3_600_000).optional(),
  updated_at: z.string(),
}

export const ListenerConfigSchema = z.discriminatedUnion('mode', [
  z.object({
    ...Common,
    mode: z.literal('run'),
    command: z.string().trim().min(1),
    /** Put `AGENTCHAT_API_KEY` in the run's environment. */
    with_key: z.boolean().default(false),
  }),
  z.object({
    ...Common,
    mode: z.literal('preset'),
    preset: z.string().min(1),
    profile: z.enum(RUN_PROFILES).default('answer'),
  }),
  z.object({
    ...Common,
    mode: z.literal('forward'),
    url: z.string().min(1),
  }),
])

export type ListenerConfig = z.infer<typeof ListenerConfigSchema>
export type ListenerConfigInput = z.input<typeof ListenerConfigSchema>

export function listenerConfigPath(home: string): string {
  return path.join(home, LISTENER_CONFIG_FILE)
}

/**
 * Where a preset's runs work when `--workdir` names nowhere: `<home>-workdir`,
 * a folder of its own BESIDE the identity home. Never inside it: a Claude Code
 * preset run is denied the home, so a work folder there is one it cannot read.
 */
export function defaultPresetWorkdir(home: string): string {
  const resolved = path.resolve(home)
  return path.join(path.dirname(resolved), `${path.basename(resolved)}-workdir`)
}

export type ListenerConfigRead = { ok: true; config: ListenerConfig } | { ok: false; error: string }

export function readListenerConfig(home: string): ListenerConfigRead {
  const raw = readJsonFile<unknown>(listenerConfigPath(home))
  if (raw === null) return { ok: false, error: `no listener configured (${listenerConfigPath(home)} is missing)` }
  const parsed = ListenerConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `${listenerConfigPath(home)} is not a valid listener config (${issue ? `${issue.path.join('.') || 'root'}: ${issue.message}` : 'invalid'})` }
  }
  return { ok: true, config: parsed.data }
}

export function writeListenerConfig(home: string, config: ListenerConfigInput): ListenerConfig {
  const parsed = ListenerConfigSchema.parse(config)
  atomicWriteFile(listenerConfigPath(home), `${JSON.stringify(parsed, null, 2)}\n`, 0o600)
  return parsed
}

/**
 * What `own` does, in one line, for a preset's runtime (`Claude Code`,
 * `Codex`): the engine's `ownProfileLine(label)` (tests/cli.test.ts holds the
 * two equal once the engine has it).
 */
export function ownProfileLine(label: string): string {
  return `reply runs use your own ${label} permission settings, with anything that would ask refused`
}

/** The honest sentence after it: the engine's `OWN_RUN_WARNING` (held equal the same way). */
export const OWN_PROFILE_WARNING = "runs started by peers' messages act with those permissions"

/** What a preset run of `profile` may do, in one line (`label`: the preset's runtime). A value that is not a profile reads as `answer`. */
export function presetProfileSummary(profile: string, label: string): string {
  switch (profile) {
    case 'own':
      return `${ownProfileLine(label)}; ${OWN_PROFILE_WARNING}`
    case 'work':
    case 'full':
      return PEER_RUN_WARNING
    default:
      return "the AgentChat tools and reads inside the run's work folder only"
  }
}

/** One line for `status`: what the listener runs. Never the key; the command as the owner wrote it. */
export function describeListenerConfig(config: ListenerConfig): string {
  switch (config.mode) {
    case 'run':
      return `runs \`${config.command}\` in ${config.workdir}${config.with_key ? ' (key in its environment)' : ''}`
    case 'preset': {
      const label = presetNamed(config.preset)?.label ?? config.preset
      return `runs the ${config.preset} preset (profile ${config.profile} — ${presetProfileSummary(config.profile, label)}) in ${config.workdir}`
    }
    case 'forward':
      return `forwards each wake to ${config.url}`
  }
}
