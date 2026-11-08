import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { InboxCard, InboxTray, TrayInvite } from 'agentchatme'
import type { RunOutcome, RunPreflight, RunRequest, RunRunner, RunWake } from '@agentchatme/agent-core'
import { atomicWriteFile } from '@agentchatme/agent-core'
import { log } from '@agentchatme/agent-core'

// ─── Forward: each wake to a local endpoint, in the `agentchat` wake dialect ─
//
// `agentchat forward --to http://localhost:PORT/…` is for developers building
// their own receiver: the listener holds the socket, and every wake run is one
// HTTP POST shaped like the server's webhook wake in the `agentchat` dialect —
// `Authorization: Bearer <secret>`, `X-AgentChat-Delivery`,
// `X-AgentChat-Attempt`, and the JSON wake payload, version 1: `reason` (and
// `step` on `unanswered`) from the wake that triggered it, the conversations
// with unread messages. A receiver written against this works unchanged
// behind a real wake webhook. `summary` is empty: the contract calls it
// informative, and its wording is the server's, never copied here. The tray's
// pending invites ride along as `invites` (ids and handles; receivers ignore
// fields they do not know).
//
// What travels is what a wake carries: who you are, which conversations have
// unread messages, how many, from whom, the cycle id. Never a message body —
// the tray is read for its counts (`conversation_id`, `unread`, `last_sender`;
// the preview is not touched) and its invites' ids. Reading the tray marks
// nothing delivered or read. The receiver reads and decides through the
// hosted tools; a 2xx says the receiver took the POST, not that the agent saw
// anything, so in this mode no invite is ever dismissed on the agent's behalf.
//
// The bearer secret is generated once into the identity home
// (`forward.secret`, owner-only) and read by the receiver from there. The
// address is the owner's: plain HTTP only to this machine, named literally
// (`localhost`, `127.0.0.1`, `::1`), HTTPS anywhere; never with credentials in
// it; redirects are not followed (a redirect would carry the bearer somewhere
// the owner did not name).
//
// Outcomes: a 2xx is `ok`; nothing listening is `not_started`; any other
// answer is `failed`; no answer within the timeout is `timed_out`.

export const FORWARD_SECRET_FILE = 'forward.secret'
/** One POST, a few seconds: a local receiver answers at once or is broken. */
export const FORWARD_TIMEOUT_MS = 30_000

export function forwardSecretPath(home: string): string {
  return path.join(home, FORWARD_SECRET_FILE)
}

/** The secret in `home`, created (owner-only) when absent. Printable ASCII, no whitespace — a valid wake secret. */
export function ensureForwardSecret(home: string): string {
  const existing = readForwardSecret(home)
  if (existing !== null) return existing
  const secret = `whfwd_${crypto.randomBytes(32).toString('base64url')}`
  atomicWriteFile(forwardSecretPath(home), `${secret}\n`, 0o600)
  return secret
}

export function readForwardSecret(home: string): string | null {
  try {
    const value = fs.readFileSync(forwardSecretPath(home), 'utf-8').trim()
    return /^[\x21-\x7e]{16,256}$/.test(value) ? value : null
  } catch {
    return null
  }
}

/** This machine, named literally: `localhost`, `127.0.0.1`, `::1` — nothing a resolver or a wildcard could redirect. */
const LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1'])

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname.replace(/^\[|\]$/g, '').toLowerCase())
}

/** Null when the owner's address may receive wakes; otherwise why not. */
export function forwardUrlProblem(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `${raw} is not a URL`
  }
  if (url.username !== '' || url.password !== '') return 'the address must not carry credentials (the bearer secret is sent in a header)'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:') {
    return isLoopbackHost(url.hostname) ? null : 'plain http is allowed only to this machine, named as localhost, 127.0.0.1 or ::1; use https for anything else'
  }
  return `unsupported scheme ${url.protocol} (http to localhost, or https)`
}

/** A pending invite as the payload carries it: ids and handles, no group name. */
export interface ForwardedInvite {
  readonly invite_id: string
  readonly group_id: string
  readonly invited_by: string
  readonly at: string
}

/** The webhook wake payload, version 1, `agentchat` dialect (contract v1), plus the tray's invites. No message content. */
export interface WakePayloadV1 {
  readonly version: 1
  readonly type: 'agentchat.wake'
  /** `messages`, `reminder`, `invite`, `unanswered`, or a newer reason the server sent. */
  readonly reason: string
  /** The re-wake rung, on `unanswered` only. */
  readonly step?: number
  /** `@`-prefixed recipient handle. */
  readonly handle: string
  readonly conversations: ReadonlyArray<{ readonly id: string; readonly unread: number; readonly latest_sender: string }>
  readonly invites: readonly ForwardedInvite[]
  /** Informative in the contract; empty here (its wording is the server's). */
  readonly summary: ''
  readonly delivery_id: string
  readonly ts: string
}

/** What a forwarded wake says woke it: the run's wake, else what the tray holds. */
export function forwardReason(wake: RunWake | undefined, cards: number, invites: number): { reason: string; step?: number } {
  if (wake !== undefined) return wake.reason === 'unanswered' && wake.step !== undefined ? { reason: wake.reason, step: wake.step } : { reason: wake.reason }
  return { reason: cards === 0 && invites > 0 ? 'invite' : 'messages' }
}

/** One wake from the tray's counts and invites. Reads `conversation_id`, `unread`, `last_sender` of each card and the invites' ids; nothing else. */
export function buildWakePayload(params: {
  handle: string
  cards: readonly Pick<InboxCard, 'conversation_id' | 'unread' | 'last_sender'>[]
  invites?: readonly Pick<TrayInvite, 'invite_id' | 'group' | 'invited_by' | 'at'>[]
  wake?: RunWake
  deliveryId: string
  now: Date
}): WakePayloadV1 {
  const handle = params.handle.startsWith('@') ? params.handle : `@${params.handle}`
  const conversations = params.cards
    .filter((card) => typeof card.conversation_id === 'string' && Number.isInteger(card.unread) && card.unread > 0)
    .map((card) => ({ id: card.conversation_id, unread: card.unread, latest_sender: card.last_sender ?? '@unknown' }))
  const invites = (params.invites ?? [])
    .filter((invite) => typeof invite.invite_id === 'string' && invite.invite_id.length > 0)
    .map((invite) => ({ invite_id: invite.invite_id, group_id: invite.group?.id ?? '', invited_by: invite.invited_by ?? '', at: invite.at ?? '' }))
  const { reason, step } = forwardReason(params.wake, conversations.length, invites.length)
  return {
    version: 1,
    type: 'agentchat.wake',
    reason,
    ...(step !== undefined ? { step } : {}),
    handle,
    conversations,
    invites,
    summary: '',
    delivery_id: params.deliveryId,
    ts: params.now.toISOString(),
  }
}

export interface ForwardRunnerOptions {
  /** The owner's receiver. Checked with `forwardUrlProblem` at construction. */
  readonly url: string
  /** The agent's bare handle. */
  readonly handle: string
  /** The identity home, where the secret lives (read per wake: deleting it rotates it). */
  readonly home: string
  /** The tray, for its counts and its pending invites (read with `includeInvites`). */
  readonly tray: () => Promise<Pick<InboxTray, 'conversations' | 'invites'>>
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
  readonly now?: () => Date
}

export class ForwardRunner implements RunRunner {
  readonly name = 'forward'
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly now: () => Date

  constructor(private readonly options: ForwardRunnerOptions) {
    const problem = forwardUrlProblem(options.url)
    if (problem !== null) throw new Error(problem)
    this.fetchImpl = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? FORWARD_TIMEOUT_MS
    this.now = options.now ?? (() => new Date())
  }

  async preflight(): Promise<RunPreflight> {
    ensureForwardSecret(this.options.home)
    return { ok: true }
  }

  async start(request: RunRequest): Promise<RunOutcome> {
    const started = Date.now()
    const done = (outcome: Omit<RunOutcome, 'durationMs'>): RunOutcome => ({ ...outcome, durationMs: Date.now() - started })
    if (request.signal?.aborted) return done({ state: 'not_started', exitCode: null, detail: 'interrupted before the wake was forwarded' })

    const secret = readForwardSecret(this.options.home) ?? ensureForwardSecret(this.options.home)
    let cards: Pick<InboxCard, 'conversation_id' | 'unread' | 'last_sender'>[] = []
    let invites: TrayInvite[] = []
    try {
      const tray = await this.options.tray()
      cards = tray.conversations
      invites = Array.isArray(tray.invites) ? tray.invites : []
    } catch (err) {
      // The wake was real; a receiver can read its inbox itself.
      log.warn(`forward: the tray could not be read (${err instanceof Error ? err.message : String(err)}) — forwarding the wake without its conversations`)
    }
    const payload = buildWakePayload({ handle: this.options.handle, cards, invites, ...(request.wake !== undefined ? { wake: request.wake } : {}), deliveryId: request.runId, now: this.now() })
    request.onStarted?.()

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, Math.min(this.timeoutMs, request.budgetMs))
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await this.fetchImpl(this.options.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          'X-AgentChat-Delivery': payload.delivery_id,
          'X-AgentChat-Attempt': '1',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      // The body is the receiver's business; drain it so the socket is reused.
      await res.arrayBuffer().catch(() => undefined)
      if (res.status >= 200 && res.status < 300) return done({ state: 'ok', exitCode: res.status })
      return done({ state: 'failed', exitCode: res.status, detail: `the receiver answered HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}` })
    } catch (err) {
      if (timedOut) return done({ state: 'timed_out', exitCode: null, detail: `the receiver did not answer within ${Math.round(Math.min(this.timeoutMs, request.budgetMs) / 1000)} s` })
      if (request.signal?.aborted) return done({ state: 'failed', exitCode: null, detail: 'interrupted — the listener was stopping' })
      const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
      const detail = typeof code === 'string' ? code : err instanceof Error ? err.message : String(err)
      return done({ state: 'not_started', exitCode: null, detail: `nothing answered at ${this.options.url} (${detail})` })
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }
}
