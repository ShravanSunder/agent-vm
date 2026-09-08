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

The bridge starts the relay through existing managed process/stream APIs over
pinned SSH. Request frames travel on the helper's stdout and responses on its
stdin, separately from composition output. No reverse SSH forwarding, public
listener, or guest access to the trusted managed-plugin socket is introduced.

The trusted bridge validates public Portal requests, supplies frozen authority,
and uses the existing human approval presenter and exact-item retry. Guest code
cannot supply an agent/profile override or approval decision. Invocation-scoped
call IDs prevent an unused approval from transferring into a successor scope.

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
Artifact ranges are authorized and streamed in 64 KiB chunks, then reconstructed
by the guest client. Transport loss is distinct from a Portal result: a possibly
dispatched effect is uncertain, not safe to replay. Cancellation is not rollback.

Portal policy still governs only calls through Portal. Direct arbitrary Tool VM
execution remains a separate surface. Same-agent processes sharing a Tool VM
are not newly isolated from each other by this relay.
