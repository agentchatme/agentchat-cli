import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── The CLI uses the engine only through its public entry points ───────────
//
// The engine is @agentchatme/agent-core: the resident supervisor, the runner
// seam, the identity flows, the service plumbing, the presets. The CLI may
// import it only as `@agentchatme/agent-core`, `…/daemon` and `…/presets` —
// never a file behind them — so an engine release that keeps its entry points
// cannot break the CLI, and the CLI carries no copy of the engine's code.

const SRC = path.join(__dirname, '..', 'src')
const ENGINE = new Set(['@agentchatme/agent-core', '@agentchatme/agent-core/daemon', '@agentchatme/agent-core/presets'])

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? tsFiles(full) : e.name.endsWith('.ts') ? [full] : []
  })
}

describe('engine boundary', () => {
  const files = tsFiles(SRC)

  it('finds the source', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('imports the engine only by its public entry points, and never reaches outside src', () => {
    const offenders: string[] = []
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf-8')
      for (const match of text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
        const spec = match[1] ?? ''
        const where = path.relative(SRC, file)
        if (spec.startsWith('@agentchatme/agent-core') && !ENGINE.has(spec)) offenders.push(`${where}: ${spec}`)
        if (spec.startsWith('.') && !path.resolve(path.dirname(file), spec).startsWith(SRC + path.sep)) offenders.push(`${where}: ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
