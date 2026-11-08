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
