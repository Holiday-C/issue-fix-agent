# ADR-0003: Use a native OS command sandbox

- Status: accepted
- Date: 2026-08-18
- Deciders: project maintainer

## Context

Issue Fix Agent must execute repository verification commands without granting
those untrusted processes unrestricted filesystem or network access. Command
allowlists and user approval decide whether a command may be attempted, but do
not constrain what an approved command or its child processes can do.

Node.js 22 Permission Model can restrict filesystem, child-process, worker,
addon, and WASI capabilities. It cannot enforce network denial. Node.js added
the `--allow-net` permission in Node.js 25, so the selected Node.js 22 runtime
cannot provide the required boundary by itself.

Docker can provide the boundary, but would add a daemon, image lifecycle, and
container-specific path and ownership behavior to a local CLI. The first
release does not otherwise need containers.

Anthropic publishes `@anthropic-ai/sandbox-runtime`, a standalone native
sandbox using Seatbelt on macOS and Bubblewrap plus a proxy on Linux/WSL2. The
package is a beta research preview, so its API must not leak into domain
contracts.

## Decision

Define a provider-neutral process port and a separate immutable command policy.
Implement the first process adapter with the exactly pinned
`@anthropic-ai/sandbox-runtime` package.

The adapter must:

- fail closed when the platform or required sandbox dependencies are
  unavailable;
- allow no unsandboxed fallback or escape hatch;
- deny network access by using an empty strict domain allowlist;
- allow writes only to the canonical isolated worktree and a dedicated
  per-run temporary directory;
- deny reads from the user's home directory, then re-allow only the worktree
  and dedicated temporary directory within it;
- provide a minimal environment without user credentials;
- execute commands through a trusted shell with correctly quoted executable
  and argument arrays;
- bound time, stdout, and stderr and return normalized process results;
- reset sandbox resources after execution.

The first supported platforms are macOS, Linux, and WSL2. WSL1 and unsupported
platforms return a blocked result. Native Windows remains blocked until the
package's dedicated-user and Windows Filtering Platform implementation is
tested by this project; package capability alone is not a support claim.

The adapter runs one command at a time, matching the first release's
single-agent serial execution model.

## Consequences

- Verification commands and their child processes receive OS-level filesystem
  and network isolation without requiring Docker.
- Linux and WSL2 users must install Bubblewrap, socat, and ripgrep.
- The project gains an experimental infrastructure dependency with a larger
  transitive surface.
- Exact version pinning and adapter-level tests contain upstream API churn.
- Native Windows can still use built-in read and patch tools, but command
  execution and verification report blocked.
- A future adapter may use containers or another sandbox without changing the
  agent core or command policy.

## Alternatives Considered

- **Permission prompts and command allowlists only:** rejected because an
  approved command can still access arbitrary files or network resources.
- **Node.js 22 Permission Model:** rejected as the sole sandbox because it does
  not enforce network denial.
- **Docker:** strong and cross-platform, but introduces unnecessary daemon and
  image complexity for the first local release.
- **Direct Seatbelt/Bubblewrap integration:** avoids an experimental package
  but requires this project to maintain platform policy generation and network
  proxying itself.
- **Run commands unsandboxed after user approval:** rejected because it violates
  the fail-closed safety model.

## Validation

The decision is validated when tests demonstrate that the adapter:

- permits a supported command inside the worktree;
- blocks writes outside the worktree;
- blocks reads from denied credential locations;
- blocks outbound network access;
- returns blocked when sandbox setup is unavailable;
- never invokes a shell with unquoted model-controlled text.

Revisit if the upstream package becomes unavailable, cannot meet a required
platform boundary, or its operational complexity approaches that of a
container runtime.
