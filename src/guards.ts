import * as fs from 'node:fs'
import { credentialsPath, envApiKey, readCredentials } from '@agentchatme/agent-core'
import { listenerConfigPath } from './listener/config.js'

// ─── What the listener refuses to run with ──────────────────────────────────
//
// Two splits a resident process must not live with:
//
//   * Identity. The listener serves the agent its home's `credentials` hold —
//     the same agent the service, `status` and the runs' environment name.
//     An `AGENTCHAT_API_KEY` exported in the shell that started it would
//     otherwise quietly make the socket another agent than the files say.
//     So the listener never takes its key from the environment, and when one
//     is exported and differs from the home's, it does not start at all.
//
//   * Ownership. The boot service runs whatever `<home>/listener.json` says,
//     as you, at every login. A file — or a home — that someone else owns or
//     can write is someone else's command line. The service refuses both, and
//     `listen --install` tightens what it created (and refuses what it did
//     not). POSIX permission bits; Windows ACLs are not checked.

/** One line when an exported `AGENTCHAT_API_KEY` is not the key this home holds; null when it is absent or the same. */
export function envKeyConflict(home: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exported = envApiKey(env)
  if (exported === null) return null
  const stored = readCredentials(home)
  if (stored !== null && stored.api_key === exported) return null
  return stored === null
    ? `AGENTCHAT_API_KEY is exported, but the listener serves only the agent whose key is in ${credentialsPath(home)}, and there is none: unset AGENTCHAT_API_KEY, or sign this home in (agentchat login).`
    : `AGENTCHAT_API_KEY is exported and is not the key ${credentialsPath(home)} holds; the listener serves only the home's agent: unset AGENTCHAT_API_KEY, or sign this home in with that key (agentchat login).`
}

/** Why `target` may not be trusted as the owner's own (another owner, writable by group or others, a link where a file belongs); null when it may. */
export function ownerOnlyProblem(target: string, kind: 'directory' | 'file'): string | null {
  if (process.platform === 'win32') return null
  let st: fs.Stats
  try {
    // The home may be a link to a directory of the owner's choosing; the file may not be a link at all.
    st = kind === 'file' ? fs.lstatSync(target) : fs.statSync(target)
  } catch {
    return `${target} does not exist`
  }
  if (kind === 'file' && !st.isFile()) return `${target} is not a regular file`
  if (kind === 'directory' && !st.isDirectory()) return `${target} is not a directory`
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && st.uid !== uid) return `${target} is owned by uid ${st.uid}, not by you (uid ${uid})`
  if ((st.mode & 0o022) !== 0) {
    const who = [(st.mode & 0o020) !== 0 ? 'its group' : null, (st.mode & 0o002) !== 0 ? 'others' : null].filter((w) => w !== null).join(' and ')
    return `${target} is writable by ${who} (mode ${(st.mode & 0o777).toString(8)})`
  }
  return null
}

/** The boot service's check: the home and its listener.json are the owner's own. Null when both are. */
export function listenerFilesProblem(home: string): string | null {
  return ownerOnlyProblem(home, 'directory') ?? ownerOnlyProblem(listenerConfigPath(home), 'file')
}

/**
 * Before `listen --install`: take group and other write off the home (it
 * holds the key) and the config, when they are the owner's; what is not
 * theirs is left alone and refused by the check that follows. Returns what
 * was changed, for the install's output.
 */
export function tightenListenerFiles(home: string): string[] {
  if (process.platform === 'win32') return []
  const changed: string[] = []
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  for (const target of [home, listenerConfigPath(home)]) {
    try {
      const st = fs.lstatSync(target)
      if (st.isSymbolicLink() || (uid !== null && st.uid !== uid)) continue
      const tight = st.isDirectory() ? 0o700 : 0o600
      if ((st.mode & 0o777) !== tight) {
        fs.chmodSync(target, tight)
        changed.push(`${target} → mode ${tight.toString(8)}`)
      }
    } catch {
      /* absent: the check that follows says so */
    }
  }
  return changed
}
