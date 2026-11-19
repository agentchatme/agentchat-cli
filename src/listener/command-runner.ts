import * as fs from 'node:fs'
import { hostedMcpUrl, RUN_CONTEXT_ENV, runContextEnv } from '@agentchatme/agent-core'
import type { RunOutcome, RunPreflight, RunPreflightOptions, RunRequest, RunRunner, RunnerIdentity } from '@agentchatme/agent-core'
import { spawnRun } from '@agentchatme/agent-core/daemon'
import { log } from '@agentchatme/agent-core'

// ─── The owner's command, once per run ──────────────────────────────────────
//
// `agentchat listen --run "<command>"`: when a wake finds something owed, the
// listener runs the command line its OWNER configured, through the platform
// shell, in the owner's working directory — once per conversation that owes
// a reply (one at a time), and once for pending group invites. The run's
// prompt is the server's text for that run (the served conversation-run
// prompt naming its one conversation, the served invite prompt, or — from an
// older server, whose texts have no conversation-run prompt — the served wake
// instruction for the whole tray), written to its stdin and closed. Nothing
// derived from a wake or a message ever reaches the command line: wakes carry
// no content, and the prompt is the server's text, on stdin.
//
// The run learns who it acts as, and what it is for, from its environment,
// never its argv:
//
//   AGENTCHAT_HOME             the identity home (`credentials` holds the key;
//                              the stdio MCP server and the SDKs' examples
//                              read it)
//   AGENTCHAT_HANDLE           `@handle`
//   AGENTCHAT_API_BASE         the API it talks to
//   AGENTCHAT_MCP_URL          the hosted tool server
//   AGENTCHAT_WAKE_KIND        `conversation` | `invite` | `wake`
//   AGENTCHAT_RUN_ID           unique per run
//   AGENTCHAT_CONVERSATION_ID  a `conversation` run: the one conversation it
//                              is for. Absent on every other run (one
//                              inherited from the listener's environment is
//                              removed).
//   AGENTCHAT_API_KEY          only when the owner asked for it
//                              (`--with-key`); otherwise an inherited one is
//                              REMOVED, so a key in the listener's own
//                              environment never leaks into a run by accident.
//
// AGENTCHAT_WAKE_KIND, AGENTCHAT_RUN_ID and AGENTCHAT_CONVERSATION_ID are the
// engine's run context (`runContextEnv`): one spelling for every runner that
// starts a command the owner configured.
//
// The output is discarded, as for every run (`spawnRun`).
//
// No runtime check (`RunRunner.checkRuntime`): the command is the owner's, and
// nothing here knows a model call it could make. So when a conversation's run
// fails or times out, the kit reports it (could not process) only once another
// conversation's run completes after it (`other_run_completed` evidence),
// within the kit's window (10 minutes); while every run fails, nothing is
// reported, and the cards wait for the server's re-wakes.

export const RUN_ENV = {
  home: 'AGENTCHAT_HOME',
  handle: 'AGENTCHAT_HANDLE',
  apiBase: 'AGENTCHAT_API_BASE',
  mcpUrl: 'AGENTCHAT_MCP_URL',
  wakeKind: RUN_CONTEXT_ENV.wakeKind,
  runId: RUN_CONTEXT_ENV.runId,
  conversationId: RUN_CONTEXT_ENV.conversationId,
  apiKey: 'AGENTCHAT_API_KEY',
} as const

export interface CommandRunnerOptions {
  /** The owner's command line, run through the platform shell. */
  readonly command: string
  readonly identity: RunnerIdentity
  /** Put the key in the run's environment (`AGENTCHAT_API_KEY`). Off by default. */
  readonly withKey?: boolean
  /** The environment runs inherit (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv
}

/** The environment one run of the owner's command gets: the run's context (the engine's `runContextEnv`), then who it acts as. Pure; exported for tests. */
export function commandRunEnv(options: CommandRunnerOptions, request: Pick<RunRequest, 'kind' | 'runId' | 'conversationId'>): NodeJS.ProcessEnv {
  const env = runContextEnv(options.env ?? process.env, request)
  delete env[RUN_ENV.apiKey]
  env[RUN_ENV.home] = options.identity.home
  env[RUN_ENV.handle] = `@${options.identity.handle}`
  env[RUN_ENV.apiBase] = options.identity.apiBase
  env[RUN_ENV.mcpUrl] = hostedMcpUrl(options.identity.apiBase)
  if (options.withKey === true) env[RUN_ENV.apiKey] = options.identity.apiKey
  return env
}

export class CommandRunner implements RunRunner {
  readonly name = 'command'

  constructor(private readonly options: CommandRunnerOptions) {
    if (options.command.trim().length === 0) throw new Error('the run command is empty')
  }

  /** Its working directory is there. `signal` (the integration stopping) is honoured: nothing is checked once it is aborted. */
  async preflight(options: RunPreflightOptions = {}): Promise<RunPreflight> {
    if (options.signal?.aborted) return { ok: false, detail: 'the check was stopped' }
    const workdir = this.options.identity.workdir
    try {
      if (!fs.statSync(workdir).isDirectory()) return { ok: false, detail: `the working directory ${workdir} is not a directory` }
    } catch {
      return { ok: false, detail: `the working directory ${workdir} does not exist` }
    }
    return { ok: true }
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    log.debug(`run ${request.runId} (${request.kind}${request.conversationId !== undefined ? ` ${request.conversationId}` : ''}): the owner's command, prompt on stdin`)
    return spawnRun({
      command: this.options.command,
      args: [],
      shell: true,
      cwd: this.options.identity.workdir,
      env: commandRunEnv(this.options, request),
      stdin: request.prompt,
      budgetMs: request.budgetMs,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.onStarted ? { onStarted: request.onStarted } : {}),
    })
  }
}
