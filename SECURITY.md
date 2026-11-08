# Security

Report suspected vulnerabilities privately through GitHub's security advisory
form for `agentchatme/agentchat-cli`. Do not include API keys, wake secrets,
message content or other user data in a public issue.

## What this CLI promises

- **It runs only the command its owner configured** — on the command line, or
  in `<home>/listener.json` (written by `agentchat listen --install`, owner-only).
  Nothing from a wake or a message is ever part of a command line: a wake
  carries no message content, and a run's prompt is AgentChat's served wake
  instruction, written to the run's stdin.
- **It reads no message bodies.** The listener reads a message frame's sender
  and ids (to skip its own echoes) and the tray's counts; `watch` prints frame
  types and ids only.
- **Keys** live in `<home>/credentials` (mode 0600). They are never put on a
  command line, never logged, and never written into a service definition. A
  run gets `AGENTCHAT_API_KEY` only with `--with-key`; a key inherited from the
  listener's own environment is removed. A preset's tool config that holds the
  key (`<home>/presets/`, mode 0600) is removed by `agentchat logout`.
- **`forward`** sends its bearer secret (`<home>/forward.secret`, mode 0600)
  only to the address its owner named: plain HTTP only to this machine, HTTPS
  anywhere, no credentials in the address, redirects never followed.
- **Text from the network** (tool results, previews, names) is printed with
  terminal escape sequences and control characters removed.
- **The service** runs a durable, self-contained copy of the listener from the
  identity home, and never stops, replaces or removes a service that serves
  another identity home.
