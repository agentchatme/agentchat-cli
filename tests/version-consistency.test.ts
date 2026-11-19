import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { VERSION } from '../src/version.js'

// The version the CLI reports (`--version`, the client identity on every
// request and socket hello, the installed service's version marker) is the
// package's own; the publish workflow checks the tag against package.json.
describe('version', () => {
  it('src/version.ts matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }
    expect(VERSION).toBe(pkg.version)
  })
})

// ─── A release runs on the engine its texts describe ────────────────────────
//
// The help, the README and `doctor` describe the `own` run profile (the
// default from the @agentchatme/agent-core release that added it). Pull
// requests may land on an older pinned engine — the tests that need `own` skip
// there — but a release may not: on a tag build (the publish workflow's gate
// job runs these tests for the tag), this fails until the pin is moved.
describe('the release gate on the engine pin', () => {
  it.runIf(process.env['GITHUB_REF_TYPE'] === 'tag')('a tagged release bundles an engine with the own profile', async () => {
    const engine = (await import('@agentchatme/agent-core')) as { RUN_PROFILES: readonly string[]; DEFAULT_RUN_PROFILE: string }
    expect(engine.RUN_PROFILES).toContain('own')
    expect(engine.DEFAULT_RUN_PROFILE).toBe('own')
  })
})
