import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOVED_LINE, legacyCommand, main } from '../src/main.js'

// ─── Users of the previous @agentchatme/cli (0.0.x) ─────────────────────────
//
// Its README said `npx -y @agentchatme/cli install`. That job moved to each
// coding agent's own integration: the command says where in one line and
// succeeds. The old plugins' session hooks ran `agentchat hook …`, under a
// "never break a session" contract: a silent success.

let out: string[] = []
let err: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  out = []
  err = []
})
const capture = (): void => {
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')))
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')))
}

describe('the previous CLI\'s commands', () => {
  it('install — with or without its old flags — prints one line naming both integrations and exits 0', async () => {
    capture()
    expect(await main(['install'])).toBe(0)
    expect(await main(['install', '--platform', 'claude-code', '--yes'])).toBe(0)
    expect(out).toEqual([MOVED_LINE, MOVED_LINE])
    expect(MOVED_LINE).toContain('npx -y @agentchatme/claude-code')
    expect(MOVED_LINE).toContain('npx -y @agentchatme/codex')
    expect(MOVED_LINE.includes('\n')).toBe(false)
    expect(err).toEqual([])
  })

  it('anchor says the same; hook is a silent success (nothing on stdout)', async () => {
    capture()
    expect(await main(['anchor', 'install', '--platform', 'codex'])).toBe(0)
    expect(out).toEqual([MOVED_LINE])
    out.length = 0
    expect(await main(['hook', 'session-start', '--platform', 'claude-code'])).toBe(0)
    expect(out).toEqual([])
    expect(legacyCommand(['listen'])).toBeNull()
  })
})
