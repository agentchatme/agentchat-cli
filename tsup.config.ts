import { defineConfig } from 'tsup'

// Two self-contained ESM files, built from one config so they never drift in
// target or inlining:
//
//   dist/cli.js              the `agentchat` bin
//   dist/listener-daemon.js  the background listener, copied to a durable path
//                            by `listen --install` and run by the service
//
// Both run with no node_modules beside them (an npx cache, the durable copy),
// so the engine, the SDK and every other dependency are inlined and nothing is
// split into chunks — which is also why they are devDependencies: an install
// fetches one package, and the bin and the engine can never be different
// versions. `ws` is CommonJS and reaches for `require` at runtime, which plain
// ESM has no binding for ("Dynamic require of events is not supported"); the
// banner defines it from `import.meta.url`.
const BANNER = [
  '#!/usr/bin/env node',
  'import{createRequire as __acCreateRequire}from"node:module";',
  'const require=__acCreateRequire(import.meta.url);',
].join('\n')

export default defineConfig({
  entry: { cli: 'src/bin.ts', 'listener-daemon': 'src/listener-daemon.ts' },
  format: ['esm'],
  dts: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  platform: 'node',
  target: 'node22',
  banner: { js: BANNER },
  noExternal: ['@agentchatme/agent-core', 'agentchatme', 'cross-spawn', 'zod', 'ws'],
})
