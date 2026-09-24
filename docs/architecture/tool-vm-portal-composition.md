# Tool Portal from Tool VM code

Composition runs in Tool VM. Individual calls retain Tool Portal's configured
destination, policy, approval, and artifact ownership. The existing Python and
TypeScript SDKs and CLI supply the same Portal contracts, not provider wrappers.

```text
Tool VM                               Gateway VM
Python / TypeScript / CLI              Hermes invocation middleware
        │                                      │ owns lifetime + conversation
        ▼                                      ▼
invocation-local Unix socket          Python SDK execution bridge
        │                                      │
        └─ guest relay ◄── SSH process I/O ──────┤
                                               ▼
                                      existing managed Tool Portal
                                               │
                                      configured capability backend
```

## Using the installed interface

Python imports `connect_tool_portal` from `agent_vm_agent_portal_sdk` and uses
the returned asynchronous context manager. TypeScript awaits `connectToolPortal`
from `@agent-vm/agent-portal-sdk` and closes the client in `finally`. The
`tool-portal` CLI selects managed transport when transport flags are omitted.
All three expose list, search, describe, call, and authorized artifact reads.
The packaged `/agent-vm/tool-portal.md` guide gives canonical request examples.

## Catalog presentation and generated TypeScript

Managed and standalone startup select catalog presentation in different places.
A managed Tool Portal profile sets `catalogMode` to `compact` or `catalog` in
`tool-portal.config.jsonc`; omission means `compact`. Compact mode keeps the
generic Hermes list, search, describe, and call tools. Catalog mode registers the
profile's admitted capabilities as individual Hermes-native tools. Generated
TypeScript modules remain available to Tool VM code in both modes.

Managed startup prepares every profile's complete admitted definitions after
the private Gateway Runtime connection opens and before Hermes is started or the
Gateway becomes ready. A catalog-mode profile with incomplete preparation blocks
startup. The prepared definitions are fixed for that managed Gateway epoch:
there is no live refresh and a newly leased Tool VM does not rediscover provider
definitions. Config, provider, policy, or schema changes take effect after a
managed Gateway restart prepares a new snapshot.

Standalone MCP Portal uses its own startup switch:
`mcp-portal mcp-proxy serve --catalog-mode compact|catalog`. Its default is also
`compact`. This CLI option and standalone `mcp-portal.config.jsonc` do not become
managed Gateway policy; managed profiles remain private-UDS configuration owned
by `tool-portal.config.jsonc`.

For a managed Hermes turn, orientation supplies exact import lines for selected
prepared namespaces within its prompt budget. Each displayed line names the real
per-namespace factory and its fingerprinted module under
`/run/agent-vm/tool-portal-sdk/<definitionFingerprint>/`. The same directory's
`manifest.json` is the complete mapping: it records the fingerprint plus every
namespace's `modulePath` and `exportedFactoryName`, including namespaces omitted
from orientation. Operators should copy those exact values rather than guessing
generated identifiers. The namespace module itself declares the generated
function names and input types. Once the relay reports catalog readiness, the
foreground command receives that exact manifest path as
`AGENT_VM_TOOL_PORTAL_SDK_MANIFEST`; its absence means generated imports were not
admitted for that environment generation.

Run the resulting `.ts` file with Node 24 from the foreground Hermes terminal.
The script imports `connectToolPortal`, imports the namespace factory from the
orientation-provided path, opens one client, binds every needed namespace
factory to that client, and closes the client in `finally`. Generated functions
return the full canonical Portal result (`ok`, `items`, and any diagnostics), so
the script must inspect the complete result before deciding what follows. The
factory is only a typed caller over that Portal client: it does not connect to a
provider directly, bypass provider authentication, skip call policy or approval,
or extend the invocation deadline. Immutable generated files may be reused by a
later invocation when its fresh manifest selects the same fingerprint. The prior
client, socket, and authority are invocation-scoped and must never be reused.

The image installs Python in `/opt/agent-vm-tools`, selects it through the login
PATH, and exposes the Node dependency tree through `/node_modules`. Imports
therefore work from ordinary `/work`, `/workspace`, and temporary script paths.
Normal nearer package installations can shadow these packages; installation is
not a security boundary inside an arbitrary-execution Tool VM.

## Connection and authority

Hermes's stock `execute_code` and foreground `terminal` continuation remain the
execution owner. Adapter middleware captures the admitted projection, originating
session, and outer invocation deadline. The first managed launch opens one relay
for that invocation and environment generation. Child processes inherit only
`AGENT_VM_TOOL_PORTAL_SOCKET`, not managed credentials or an approval token.
Managed `execute_code` starts a fresh remote kernel for every call, including
consecutive calls in one session. In-memory Python state does not carry between
calls; use explicit files or Tool Portal results for cross-call state. This
prevents a kernel keyed by Hermes's raw task ID from surviving a managed Tool VM
environment rotation.

The bridge starts the relay through existing managed process/stream APIs over
pinned SSH. Request frames travel on the helper's stdout and responses on its
stdin, separately from composition output. No reverse SSH forwarding, public
listener, or guest access to the trusted managed-plugin socket is introduced.

The trusted bridge validates public Portal requests, supplies frozen authority,
and uses the existing human approval presenter and exact-item retry. Guest code
cannot supply an agent/profile override or approval decision. Invocation-scoped
call IDs prevent an unused approval from transferring into a successor scope.
Each admitted request also gets a trusted identity, so independent calls that
reuse an item ID cannot share approval identity; exact approval retries keep
their original identity.

## Failure and lifetime

Invocation completion closes admission and cancels its own pending work and
relay. It does not close the shared Tool VM or SDK connection. Detached programs
cannot retain the ended invocation's Portal endpoint. Missing or stale context
fails explicitly; it never falls back to another transport or execution host.

If relay startup fails while the invocation remains live, ordinary commands
still run in the same Tool VM without Portal connection context. The adapter
emits a bounded diagnostic and does not retry relay startup for that invocation
and environment generation. Closed, expired, or mismatched invocation authority
does not become an ordinary-command fallback.

Independent calls correlate by ID. Frames, pending requests, artifacts, and
process streams have finite bounds; control traffic retains reserved capacity.
Consumed data and acknowledged write records release capacity for subsequent
calls. The relay limits retained data rather than cumulative bytes transferred.
Artifact ranges are authorized and streamed in 64 KiB chunks, then reconstructed
by the guest client. Transport loss is distinct from a Portal result: a possibly
dispatched effect is uncertain, not safe to replay. Cancellation is not rollback.

Portal policy still governs only calls through Portal. Direct arbitrary Tool VM
execution remains a separate surface. Same-agent processes sharing a Tool VM
are not newly isolated from each other by this relay.
