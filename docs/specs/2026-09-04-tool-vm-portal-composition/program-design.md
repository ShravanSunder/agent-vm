# Tool VM Portal composition program design

[Requirements](requirements.md) · [Specification](specification.md)

## The connection, end to end

The reusable Python SDK owns a trusted-side execution bridge. Hermes supplies
the originating invocation and approval presenter; it does not own the SDK.
The bridge uses Gateway Runtime's existing managed process/stream APIs to start
a small relay in Tool VM. Guest SDKs connect to that relay's local socket.
Requests travel back over the existing SSH process stdout; responses travel
over its stdin. No reverse TCP forwarding, public listener, provider-specific
wrapper, or new controller routing API is needed. Cancellation of an admitted
configured CLI does require completing the existing control channel's
operation-cancellation contract; that is separate from Portal request routing.

```text
GATEWAY VM                                  TOOL VM: composition origin

Hermes tool_execution middleware             foreground terminal: TS program
  owns exact invocation context               │
  │                                           ├─ generated TS functions
  ▼                                           ├─ existing TypeScript SDK
SDK execution bridge                          └─ tool-portal CLI
  owns request tasks and approval callbacks            │
  │                                                   ▼
  │      existing managed process/stream API     guest-local UDS
  ├────────────────────────────────────────────► relay helper
  │              Gateway Runtime + pinned SSH    │
  │◄──────── request frames on process stdout ────┘
  ├───────── result frames on process stdin ─────► SDK caller
  │
  ▼
existing managed Portal client ──► Tool Portal capability core
                                      ├─ MCP provider
                                      └─ configured CLI destination
                                         host / credentialed VM / Tool VM

The configured Tool VM destination already exists.
The composition program never moves to any destination above.
```

The two directions share the existing Gateway-to-Tool-VM SSH connection but use
a separate managed process channel from the composition program. Neither
program stdout nor Hermes's `hermes_tools` file RPC carries Portal protocol
frames. This prevents ordinary printed text from becoming a tool request.

## What exists and what changes

The table compares the pre-composition baseline at Agent VM `b4647ae2`
with the proposed path. The current foundation also includes the configured
Tool VM CLI destination. Hermes is pinned to 0.20.6,
`5fc308a70719a83cccdbba4c0e39c23f5a8239d5`.

| Edge | Current source / behavior | Target delta |
| --- | --- | --- |
| Hermes invokes execute_code | Pinned `agent/tool_executor.py:737–767` supplies invocation metadata to `tool_execution` middleware | Added adapter middleware captures one immutable scope and calls the stock continuation exactly once |
| Stock remote execution reaches Tool VM | Pinned `tools/code_execution_tool.py:1078–1214`; adapter `managed_gateway_runtime_environment.py:467` | Intentionally unchanged execution/whole-script approval; command launch additionally receives scoped guest connection environment |
| Guest code calls Portal SDK | Existing SDKs require manually supplied HTTP/stdio transport; no managed guest endpoint | Added local transport in existing SDKs and CLI, backed by the guest relay |
| Bridge starts relay | No predecessor | Added SDK bridge uses lower-level `sandbox.process`/`sandbox.stream`, not blocking BaseEnvironment command execution |
| Requests cross VM boundary | Strict SSH `openProcessChannel` already exposes stdout/stderr callbacks and repeated stdin writes | Reused process transport with explicit auxiliary relay I/O profile; ordinary process limits unchanged |
| Trusted caller reaches Portal | Existing Python GatewayRuntimeClient supplies protected context; operation identity uses caller item ID | Bridge supplies frozen context and invocation/request-qualified item IDs; caller-visible result IDs are restored, backend arguments unchanged |
| Portal approval | Existing `gateway_approval_bridge.py:126–220` calls presenter/decision/exact retry | Intentionally unchanged authority and algorithm; callbacks close over originating conversation |
| Cancellation reaches Portal | UDS server has AbortSignal, private projection drops it (`gateway-runtime-private-uds-dispatcher.ts:161–192`) | Carry signal through existing managed Portal invocation/projection into capability core |
| Cancellation reaches an admitted controller CLI | `controller-execution-gateway-control-adapter.ts:690–713` waits for the result without forwarding cancellation; gateway-origin cancel is refused by admission classification | Add operation-scoped cancellation on the existing control channel, with controller-owned admission/lifetime state and existing executor signals |
| Discovery and backend effects | Existing capability core, backends, controller approval and artifact ownership | Intentionally unchanged; relay is a caller adapter, not another Portal service |

The Python UDS write lock is released before waiting for a response
(`gateway_runtime_uds_transport.py:191–222`). Concurrent stream reads, Portal
calls, and approval decisions can share the existing admitted connection.
No second managed-plugin handshake or attachment is introduced.

## Why this transport

| Alternative | Useful foundation | Reason not selected |
| --- | --- | --- |
| Extend Hermes file RPC | Existing return path and context propagation | Hard-coded nested tools, synchronous polling, and Hermes-generated helper cannot be the generic SDK's authority/transport owner |
| Expose Gateway managed UDS | All operations already exist | Exposes multi-agent trustedContext, approval decisions, and sandbox RPC to untrusted guest code |
| Reuse standalone MCP HTTP server unchanged | Existing MCP schemas and transports | Standalone identity/HMAC approval differ from managed controller authority |
| Reverse SSH TCP forwarding | ssh2 supports it | Pinned Gondolin 0.12.0 starts sshd with `AllowTcpForwarding=no`; would require unrelated provider behavior change |
| Intercept outbound HTTP in controller | Existing mediation hook can return a Response | Requires new controller-to-Gateway Portal routing and session translation |
| SDK bridge over ordinary SSH process streams | Existing full-duplex transport, managed authority, and framework-neutral approval helper | Selected; pays for a bounded relay and invocation lifecycle, without a new network/control service |

The cost belongs to SDK/runtime maintainers: one small relay protocol must be
versioned and tested in both languages. A future requirement for detached,
long-lived external clients would reopen this choice. It is not a reason to
introduce a persistent broker now. Codex's current internal Code Mode supplies
prior art for correlated calls returning to an authoritative host; its V8
runtime and agent SDKs are not dependencies or compatibility authorities here.

## Package and component ownership

```text
Existing Python agent-vm-agent-portal-sdk
  ├─ ToolPortalMcpClient + automatic local transport
  │    consumer: guest Python code; changes with caller transport ergonomics
  ├─ guest relay entrypoint
  │    consumer: managed execution bridge; owns bounded local socket multiplexing
  └─ execution bridge + existing approval helper
       consumer: trusted framework adapters; owns request lifecycle/callbacks

Existing @agent-vm/agent-portal-sdk
  ├─ ToolPortalMcpClient + automatic local transport
  │    consumer: guest JS/TS code; same portable contracts
  ├─ generated-module runtime contract
  │    consumer: generated namespace modules; binds one explicit client
  └─ tool-portal CLI
       consumer: shell; owns JSON/exit-code interface

Existing @agent-vm/mcp-portal preparation-only entrypoint
  ├─ standalone PortalCore catalog preparation
  │    consumer: authenticated external MCP sessions; MCP-only authority
  ├─ existing catalog constants/validator generator
  │    consumers: generate-helper and mcp_portal_describe; unchanged contract
  └─ new pure managed namespace-module compiler
       consumer: managed SDK preparation only
       owns deterministic source generation, never visibility or call policy

Hermes adapter
  ├─ middleware: captures exact invocation; owns lexical lifetime
  ├─ environment launch integration: injects scope endpoint per command
  ├─ startup catalog coordinator: owns zero or one complete profile/epoch snapshot
  ├─ launch integration: selects and transports one immutable module set
  └─ existing presenter: maps conversation to native human approval route

Gateway Runtime
  ├─ existing sandbox process/stream runtime: transport and lease liveness
  ├─ existing managed ToolPortalCapabilityCore: cross-backend catalog and policy
  ├─ bounded epoch-source cache + private scoped catalog reader
  └─ existing Portal/artifact operations: dispatch and returned data

Tool VM guest relay helper
  └─ module publisher: validates and atomically publishes transported bytes

Controller
  ├─ control-session admission: owns cancellable command lifetime
  └─ unchanged lease, credential, approval-decision, and destination owners
```

No new top-level npm/PyPI package duplicates the existing SDKs. The Python
package's trusted-side bridge accepts typed callbacks and a process transport
port; importing its guest client never imports Hermes. The TS package need not
implement a second trusted-side host. Its guest client speaks the same portable
protocol, so any trusted embedding can use the existing Python host or implement
that documented port.

## One catalog, two existing presentation authorities

Standalone MCP Portal adds `--catalog-mode compact|catalog` to the existing
`mcp-portal mcp-proxy serve` parser and carries it through
`PortalServerCliArgs`; managed Hermes adds the same discriminator to each
resolved `tool-portal.config.jsonc` profile carried in its existing projection.
Both default to `compact`. The shared vocabulary does not merge policy:
standalone remains MCP-only with bearer/HMAC authority, while managed Hermes
retains the controller-authenticated private UDS and native presenter.

The two authority owners prepare separate catalogs. Standalone's MCP-only
`PortalCore` preserves its authenticated `PortalSession` lifecycle. Gateway
Runtime's managed `ToolPortalCapabilityCore` prepares once per managed Gateway
startup across its MCP, configured-CLI and Tool VM runner backends using each
admitted profile context. Both normalize authorized definitions into a
`PreparedCatalogSnapshot`: sorted records, discovery failures, definition
fingerprint, and compact/namespaced descriptors. They do not combine records or
reuse one surface's snapshot on the other. Managed SDK preparation additionally
feeds its complete normalized records to the pure module compiler. Standalone
MCP serving does not generate TypeScript; the existing explicit
`generate-helper` path keeps its current catalog-constant/validator generator
and output contract.

A snapshot with any discovery failure is incomplete and cannot become the
selected catalog or generated SDK. Standalone's current session manager already
exposes failures and caches only complete sessions
(`portal-session.ts:154–229`); managed preparation applies the same completeness
rule to the capability core's canonical list/describe results without moving
its backend or OAuth authority (`tool-portal-service.ts:202–220,563–590`).

```text
Standalone external MCP                    Managed Hermes
bearer auth → MCP PortalCore                admitted projection → private UDS
             │                               → ToolPortalCapabilityCore
             │                                      │
             └─ authorized MCP definitions          └─ authorized cross-backend definitions
                              │                      │
                              └──── pure normalizer ─────────┘
                                           │
                              separate immutable snapshots
                                └─ compact/namespaced descriptors

Managed complete snapshot ──► preparation-only compiler ──► TS modules

Standalone owns MCP session/list/call projection.
Hermes owns native registration, orientation and invocation selection.
Each surface retains its own schema, visibility and call-policy authority.
```

| Runtime path | Current edge | Target delta and return/error path |
| --- | --- | --- |
| Standalone MCP | `mcp-proxy serve` parser → bearer auth → session → fixed Portal descriptors (`mcp-portal-cli-parser.ts:161–187`; `portal-http-server.ts:210–245`) | **Changed:** CLI mode → authenticated MCP session preparation → mode projection → `Server.connect`; incomplete catalog returns bounded unavailability before tools are advertised |
| Managed native tools | profile projection → background compact inventory → fixed plugin registration (`managed_gateway_bootstrap.py:917–965`) | **Changed in catalog mode:** admitted managed capability preparation → namespaced registration; failure prevents catalog readiness, while compact partial diagnostics remain unchanged |
| Generated TypeScript | no predecessor | **Added:** complete Gateway-epoch bytes → profile/session/turn-scoped private offer of that same epoch snapshot → matching invocation acquisition → atomic Tool VM publication → foreground terminal static import → explicit client → existing relay/Portal result or error |
| Capability execution | MCP/native/generated wrapper → Portal core → configured backend | **Intentionally unchanged:** current visibility, schema validation, OAuth, approval, destination and canonical result/error owners |

For standalone `mcp-proxy serve --catalog-mode …`, authenticated session
creation prepares the snapshot before `Server.connect`; the current seam is
`portal-http-server.ts:210–245`. Compact mode registers the existing four MCP
Portal tools. Catalog mode registers deterministic namespace-qualified tools
from the exact input schemas. Each individual handler wraps its upstream
arguments in one canonical `mcp_portal_call` item and invokes the same MCP-only
`PortalCore.callStream` used today (`portal-mcp-server.ts:193–235`). The
existing `agent-vm/tool-portal-approval-token` MCP `_meta` key is copied into
the wrapper's `portalApprovalToken`; it never enters the upstream argument
object or its advertised schema. This preserves the existing verifier and
approved retry without adding a second approval channel. Every handler returns
the whole `PortalCoreResult`, including approval-required, mixed, failed and
uncertain outcomes. Its MCP `outputSchema` is the canonical Portal envelope
schema or is omitted; the upstream provider output schema remains descriptor
metadata and is not advertised as the wrapper's incompatible return shape.

Managed bootstrap already owns the Gateway startup sequence. It connects
Gateway Runtime, attempts every admitted profile's generated and native catalog,
configures the plugin, installs its hooks and policy bindings, and only then
forces plugin discovery and starts the stock Gateway
(`managed_gateway_bootstrap.py:893–979`; `managed_tool_portal/catalog.py:180–340`).
Retain that ordering: one coordinator attempts preparation and stores at most
one complete cross-backend snapshot per profile for the epoch. Catalog mode
registers one native Hermes tool per descriptor through the existing
`PluginContext.register_tool` seam
(`managed_tool_portal_capability_tools.py:327–342`). Its dynamic handler uses
the same trusted projection, native presenter and exact-retry helper as the
five compact handlers. It does not open an MCP listener. Compact mode keeps
the existing fixed tools and partial-discovery diagnostics. The native
`tool_portal_file` attachment action remains registered in both modes because
it is conversation delivery, not a catalog capability.

Registration is profile-scoped, not a global union of all agents' catalogs.
Pinned Hermes 0.20.6 `PluginContext.register_tool` supplies its plugin manager's
scope to the registry (`hermes_cli/plugins.py:1817–1839`); the registry overlays
only that profile's entries (`tools/registry.py:483–505`). Preparation and plugin
discovery run under the matching protected Hermes profile home. Missing or
mismatched projection prevents registration. Tests must enumerate two profiles
with different catalogs and overlapping names, including their native deferred
discovery paths. Existing scoped registration supports this structure without
requiring a Hermes distribution upgrade.

Incomplete preparation on an initial start or restart aborts catalog-mode
managed Gateway startup with bounded namespace diagnostics before plugin
discovery or Gateway readiness. For a compact profile, the coordinator preserves
the existing compact tools and generic SDK/CLI surface while leaving generated
SDK guidance unavailable. A ready Gateway never replaces, refreshes or
supplements any complete snapshot prepared for that epoch. Definition changes
require a managed Gateway restart; the new process prepares a new epoch snapshot
before advertising it. Current Portal visibility, OAuth/account preflight,
argument policy and approval still execute on every call, so stable definitions
remain convenience rather than authority. There is no refresh trigger,
scheduler or retained prior snapshot used to make a failed catalog-mode epoch
look ready.

| Prepared-catalog state | Owner and legal transition | Observable use |
| --- | --- | --- |
| absent | startup coordinator → preparing | No native catalog registration or generated-SDK guidance; catalog-mode Gateway is not ready |
| preparing | startup coordinator, once for every admitted profile in the new epoch | Catalog mode remains unready; compact keeps only its existing generic surface; no previous epoch is selectable in this process |
| complete | startup coordinator atomically installs one fingerprint per profile | May back native registration, orientation and private source offers for the full ready epoch |
| complete with private offers | `pre_llm_call` scopes the epoch fingerprint to profile + session + outer turn; Python tracks turn-open and active-invocation count | Literal imports and tool execution name the same epoch snapshot; releasing an offer never changes the prepared catalog |
| retired | Gateway shutdown | No new private selection; active foreground scopes close under their existing lifetime |

There is no incomplete-to-ready or retired-to-ready transition inside an epoch.
The startup coordinator completes preparation before catalog-mode readiness or
generated-SDK guidance can be advertised. A compact profile whose preparation
failed has no prepared fingerprint or private source offer. Every binding that
does exist names that epoch's exact fingerprint; there is no mutable “latest”
pointer and no second fingerprint published into a running Gateway. Restart
retires the old process and establishes a new epoch, which prepares
independently.

## Generated TypeScript modules and publication

The current `generateTypescriptCatalogArtifact` emits catalog constants and
runtime `z.fromJSONSchema` validators only
(`portal-config/typescript-artifact.ts:31–73`). Preserve that function and its
two current consumers unchanged: `generate-helper`
(`mcp-portal-command-dispatcher.ts:407–419`) and the optional
`mcp_portal_describe` helper (`core/portal-tools.ts:595–597`). New managed
wrappers have a different `ToolPortalMcpClient` call contract, so a separate
preparation-only entrypoint compiles one independent ESM `.ts` module per
namespace plus a small manifest. The compiler dependency is absent from
ordinary guest SDK import graphs.

The new compiler uses published `json-schema-to-typescript` 16.0.0, with
`unknownAny: true` for static argument types. The authoritative original JSON
Schema is stored separately and embedded only as JSON data for runtime
validation.
Source revision `5caacfc53671f9c891bb4e2a78bccc6190ed3ef4` supplies explanatory
API/emission references below; it is not bit-identical to the published package.
Implementation and safety proof use the installed package's actual API.
Generated validators use Zod 4 `fromJSONSchema` against that original schema;
Portal validates the same unchanged arguments again.

Each tool records `typing: structurally-derived | widened` and the unsupported
keyword/path when widening was required. “Structurally derived” covers the
TypeScript-representable shape; value constraints remain runtime obligations.
A failed or unsupported static conversion emits a
callable `JsonObject` input and an explicit diagnostic; it never emits a
narrower invented type. Preparation uses the existing tested Zod conversion
classification (`zod-schema-loader.ts:499–539`). Each tool records
`runtimeValidation: local-zod | portal-only`. A supported validator is created
lazily per function. A known unsupported conversion skips local validation and
lets the authoritative Portal validate the unchanged arguments. An unexpected
conversion failure reports `schema_validation_unavailable` only when that
function is called; namespace import, sibling functions and the generic SDK
still work. Stable escaping plus a short tool-ref digest keeps namespace,
function and collision mapping deterministic.

Catalog schemas, names and descriptions are untrusted source-generation input.
Before static compilation, the compiler recursively projects an isolated clone
that removes source-bearing extensions including nested `tsType` and
`tsEnumNames`, records their paths as widening diagnostics, and never mutates
the separately retained original schema. This is required because the selected
compiler copies `tsType` into a custom-type node and emits it verbatim
(`parser.ts:351–359`; `generator.ts:310–312`). Descriptions continue through
the upstream normalizer that escapes closing comment delimiters
(`normalizer.ts:334–339`); the design does not misclassify that handled case as
the source-bearing gap.

Static compilation also sets `$refOptions.resolve.file` and `.http` to `false`
and permits only in-document JSON Pointer references. An unresolved external
reference widens the affected input without reading Gateway files or the
network. After compilation, the preparation owner parses the declaration
fragment and accepts only type aliases and interfaces: no value import, enum,
class, function, expression or other runtime statement from schema-derived
declarations may enter the generated module. Failure of that check widens the
affected tool to `JsonObject`. The separately authored wrapper functions and
embedded-schema constants are the module's only runtime statements.

The trusted Python bridge does not generate source. Gateway Runtime's managed
preparation owner keeps generated manifests and bytes in a process-local
`PreparedCatalogSourceCache`, separate from operation-result artifacts. Its
private authority key contains Gateway epoch, stable principal, profile ID,
profile-assignment and semantic revisions, plus the definition fingerprint;
the manifest also records generator and SDK contract versions. These source
identity checks coexist with current visibility, OAuth, approval and policy
checks on every call. Each immutable entry is capped at 16 MiB for the complete
encoded bundle (including manifest and escaping), 256
namespace files and 1 MiB per file; the cache is capped at 64 MiB, 128 entries
and 128 active offers. It retains the epoch's one complete entry for each
principal/profile and every active private offer. If those protected entries
leave insufficient capacity, catalog-mode startup fails before readiness; a
compact profile remains on its generic surface without generated guidance. A
new private offer fails before guidance.

The acquisition path is a narrow addition to the existing protected UDS
`portal` operation group. During managed Gateway bootstrap,
`portal.catalog.prepare` returns an incomplete diagnostic or a complete manifest
containing the fingerprint, deterministic namespace paths, file sizes and
digests; it returns no source or host path. At `pre_llm_call`,
`portal.catalog.offer` binds that profile's already-prepared epoch fingerprint
to the trusted principal/profile/session and supplied outer turn, retains it,
and returns an opaque offer ID plus the manifest. It does not discover,
regenerate or select newer definitions. `portal.catalog.read` accepts that offer
ID, fingerprint, exact offset and at most 64 KiB, then returns the immutable
`contentBase64` range, byte length, total length and EOF. Every read synchronously
validates the offer, trusted principal/profile/session, epoch fingerprint and
range. Repeated or out-of-order reads are harmless because no read mutates source
or dispatches an effect. The Python binding keeps the offer retained while its
outer turn is current or any matching invocation remains; when both are false it
calls idempotent `portal.catalog.release`. A profile, principal, session or
Gateway-epoch change invalidates the offer. Guest fields cannot select another
entry. These operations create no synthetic capability, approval, result
artifact or execution authority, and do not change existing artifact quotas or
expiry.

A cache miss, wrong principal/profile, retired epoch, invalid range or released
binding returns bounded catalog-source unavailability. A cold Tool VM can fetch
the exact epoch snapshot after operation-result artifacts would have expired. A
later turn marks the previous turn closed but does not release its offer while a
matching foreground invocation remains active. Profile/session or Gateway
attachment retirement releases abandoned offers and refuses new reads. An
already-retired Gateway still uses existing process shutdown to end remaining
invocations.
There is no durable store, renewal timer, catalog service or public listener.

The bridge copies selected bytes through the existing bounded managed
process/stream path. The guest helper publishes into
`/run/agent-vm/tool-portal-sdk/<definition-fingerprint>/`: write a sibling
temporary directory, validate manifest hashes and file bounds, then rename the
complete directory. An existing matching directory is reused unchanged. An
incomplete or mismatched final directory is rejected rather than repaired in
place. The rootfs/COW lifetime makes this a rebuildable Tool VM generation
cache, not workspace or backup state.

On invocation open, the Python bridge starts the existing guest relay helper
with the selected fingerprint. Before opening its local socket, the helper
checks the final directory's manifest digest and emits either `cache-hit` or
`content-required` on the existing auxiliary process stream. For a miss, the
bridge reads the bundle through bounded `portal.catalog.read` requests and
streams ordered chunks over the relay stdin. The helper validates the canonical
file list, relative paths, counts, byte lengths and digests, writes the sibling
temporary tree, renames it, and only then emits `catalog-ready` followed by the
normal relay `ready`. A cache hit transfers no module contents. Failure closes
this invocation's relay before its socket or module path is injected; it does
not start a second transport or replay a Portal call.

### The epoch import and foreground invocation share one private binding

Pinned Hermes 0.20.6 invokes `pre_llm_call` with `session_id`, `task_id` and
`turn_id` (`agent/turn_context.py:1274–1290`). Its `tool_execution` path carries
the same `session_id` and `turn_id`, plus tool-call and API-request identities
(`agent/tool_executor.py:737–767`). The binding uses the two identities common
to both seams; it does not guess or derive an API-request ID.

The existing hook state is extended with an `OfferedDefinitionBinding` keyed by
protected profile/epoch, exact session and outer `turn_id`. The first
`pre_llm_call` for that key scopes the profile's one complete epoch fingerprint,
retains it through `portal.catalog.offer`, stores the opaque offer ID, and renders
orientation from that exact manifest. Repeated model calls and tool iterations
in the same outer turn read the existing binding. A matching foreground
`tool_execution` middleware lookup increments that binding's active-invocation
count and puts its offer ID and fingerprint on `PortalInvocationScope`;
environment launch may read and publish only that entry. A missing, released or
mismatched binding makes generated SDK use unavailable rather than selecting
another profile or epoch.

Each outer turn gets a new private binding to the same profile/epoch fingerprint.
The existing session-once orientation marker may suppress repeated full guidance,
but the turn binding is still recorded for middleware and source delivery.
Superseding a prior turn or ending the session marks that binding's turn closed;
each scope close decrements its active-invocation count. The Python owner releases
the Gateway offer only when the turn is closed and that count reaches zero. Thus
a cold or reused Tool VM receives the source authorized for the current epoch,
and concurrent foreground executions use the same immutable definitions through
separate invocation scopes.

The manifest gives literal absolute imports such as
`/run/agent-vm/tool-portal-sdk/<fingerprint>/google-9a31f7c2.ts`. Generated
modules use the image's existing `/node_modules` ancestor to import
`@agent-vm/agent-portal-sdk`; they require no `NODE_PATH`, custom loader, or
dynamic environment-derived import. They use Node 24 erasable TypeScript only.
The exact path is derived from the binding's complete fingerprint and stable
name map, so orientation can show literal imports before the first Tool VM
publication. “Ready” at that point means the complete trusted bundle is
retained as offered; the foreground launch gate must observe `catalog-ready`
before executing code or injecting its manifest path and scoped Portal socket. A
publication failure returns the bounded generated-SDK unavailable diagnostic;
it never claims the advertised path was usable. The digest-qualified path never
changes during the Gateway epoch. A later managed Gateway restart may publish a
different digest-qualified directory for its new epoch. Generic
Python/TypeScript/CLI discovery remains available through its existing
invocation-scoped connection independently of catalog mode.

```typescript
import { connectToolPortal } from '@agent-vm/agent-portal-sdk';
import { bindGoogleTools } from '/run/agent-vm/tool-portal-sdk/8f3a2c919f1e55d3482d961932e8a3fa6ad27d73d9834f8896aa0b70da8bd083/google-9a31f7c2.ts';

const portal = await connectToolPortal();
const google = bindGoogleTools(portal);
try {
	const result = await google.searchMessages({ query: 'newer_than:1d' });
	// Inspect the complete PortalCallResult before deciding the next call.
} finally {
	await portal.close();
}
```

`bindGoogleTools` stores only the supplied `ToolPortalMcpClient`. Each function
validates arguments, constructs one canonical call item with an internal unique
item ID, awaits `client.call`, and returns the complete `PortalCallResult`.
It does not connect, close, cache a hidden client, resolve OAuth, or call a
provider. Importing `google.ts` loads that namespace's definitions only; it
does not import the manifest or other namespace modules.

The definition fingerprint covers normalized authorized records, original
schemas, stable name mapping, generator version and SDK contract version. It
does not include live OAuth availability, consent, permission, approval or
provider-health observations. Whole-catalog generation during managed Gateway
startup and atomic publication are the first implementation. Cold startup
preparation, same-epoch reuse, changed preparation after restart, namespace
import latency, generated bytes and peak memory are observed at the compiler
and publisher boundaries. Incremental generation is added only if those
measurements show whole-catalog work is material.

## Guest interface

Names below are proposed public additions; existing client methods and payloads
are reused.

```python
from agent_vm_agent_portal_sdk import connect_tool_portal

async with connect_tool_portal() as portal:
    discovered = await portal.search(search_request)
    described = await portal.describe(describe_request)
    result = await portal.call(call_request)
    # Inspect canonical items before constructing the next request.
```

```typescript
import { connectToolPortal } from '@agent-vm/agent-portal-sdk';

const portal = await connectToolPortal();
try {
  const results = await Promise.all([
    portal.call(firstRequest),
    portal.call(secondRequest),
  ]);
} finally {
  await portal.close();
}
```

```sh
tool-portal search --input-json '<canonical Portal search request>'
```

The examples illustrate API shape, not literal valid sample request bodies.
Published examples must use the real portable fixtures. The automatic factory
reads `AGENT_VM_TOOL_PORTAL_SOCKET`, a guest-absolute socket path injected for
the active invocation. It negotiates the relay protocol version and limits.
It never accepts identity or falls back to another transport if this context
fails. Explicit HTTP/stdio clients remain separately selected external use.

Local transport implements the existing `ToolPortalMcpTransport` interface:
`call_tool` accepts only the four Portal tool names; `read_resource` maps only
the canonical Portal artifact URI. It converts canonical results to the
existing `structuredContent` representation. It does not pretend the local
socket is a general MCP server: discovery/calling are Portal operations, not
arbitrary MCP wire methods. Unknown methods or metadata are rejected.

The managed guest path rejects standalone approval-token options. Managed
approval is completed by the trusted bridge, not by a token supplied by code.
CLI stdout/exit codes remain C6; transport diagnostics never contaminate JSON.

## Getting packages into ordinary code execution

The managed Tool VM image overlay explicitly installs the matching Python SDK,
Node SDK/CLI, and guest helper. It does not rely on transitive CLI installation
through `mcp-portal`. Python's managed `python3` environment must include the
SDK. Node's normal package resolution from `/work`, `/workspace`, and temporary
script directories must find it; a global CLI installation alone is insufficient.

Use an image-owned Python venv selected by the managed execution PATH, and an
image-installed Node dependency tree exposed through the root `/node_modules`
ancestor lookup. This avoids custom ESM loaders or provider wrapper commands.
The rootfs remains ordinary writable Tool VM state; package installation is not
an integrity boundary against the agent. A user-created nearer dependency may
shadow a package by ordinary language resolution; diagnostics show resolution
and version rather than silently claiming the managed package was used.

SDKs and helper are release-version locked with the existing package train.
The local protocol handshake rejects mismatch. Image fingerprints already
include package inputs; no new image-version scheme or runtime installer is
introduced. A missing helper makes the scoped Portal interface unavailable;
the adapter does not install from the network during a user turn.

## Capturing the conversation without changing Tool VM identity

Pinned Hermes exposes `PluginContext.register_middleware('tool_execution', …)`
(`hermes_cli/plugins.py:3433–3458`). Its middleware receives `session_id`,
`tool_call_id`, `turn_id`, `api_request_id`, and task ID from the trusted outer
dispatcher. The adapter validates these into a frozen invocation identity:
admitted projection, exact conversation, invocation ID, and deadline. A separate
`PortalInvocationScope` owns that immutable identity and mutable lifecycle on
the adapter's existing asyncio loop. This is process-local correlation, not
durable identity or guest authority.

For `execute_code` and foreground `terminal`, middleware sets an adapter-owned
ContextVar, invokes `next_call` exactly once, and closes/reset the scope in
`finally`. It wraps rather than replaces stock execution, preserving the
whole-script approval guard and existing tool behavior. Nested launch work
inherits the scope; it does not create an unrelated conversation scope.

`_run_bash` captures the immutable scope before scheduling on the adapter
event loop and passes it explicitly to its coroutine. It lazily opens one
bridge per invocation/environment generation, with single-flight ownership in
the scope, then adds only that endpoint to the launched command's environment.
The bridge itself starts through raw sandbox process APIs, not `_run_bash`,
so opening it cannot recursively open another bridge.

The stock remote RPC polling thread already uses `copy_context()` through
`tools/thread_context.py:64–120`. Do not depend on implicit context propagation
across additional threads: capture and pass the scope explicitly at each owned
async/thread boundary.

Never change `HermesGatewayRuntimeEnvironment._trusted_context` per conversation.
It is shared per profile/generation (`managed_gateway_bootstrap.py:686–764`),
and its sandbox correlation is the environment cache identity. Portal calls
instead derive their trusted context from the scope's admitted projection and
real conversation. A missing conversation disables Portal bridge admission;
ordinary direct execution retains its existing behavior.

Detached background work does not retain an invocation's Portal authority after
the foreground call ends. The package host API can be used by another framework
with its own explicitly owned scope; no Hermes import is required. This change
does not create a detached-job lifetime or persistent session service.

## Trusted bridge interface and call flow

The Python bridge's host-facing factory accepts:

- immutable admitted context and deadline supplied by the trusted adapter;
- an existing managed process/stream transport port, bound to the active sandbox
  environment and generation;
- typed async Portal list/search/describe/call and artifact-read callbacks;
- the existing approval presenter and decision callbacks; and
- an explicit cancellation/lifecycle owner.

Guest messages never carry these callbacks or trusted context. The bridge
invokes the normal Portal client and the existing approval helper. No Gateway
Runtime-to-Hermes callback protocol is necessary because presentation remains
beside Hermes. Source `BaseEnvironment._run_bash` closes stdin and waits before
reading; it cannot host this relay. The bridge starts and pumps lower-level
process streams concurrently and independently of process wait.

```text
1. Trusted middleware captures conversation + admitted projection
2. Stock execute_code begins ordinary remote work
3. Launch integration opens scoped relay using sandbox.process.start
4. SDK bridge concurrently reads relay stdout and writes responses to stdin
5. Helper reports ready; launch integration injects guest socket into program
6. Guest SDK sends request ID + operation + canonical public payload
7. Bridge validates; supplies fixed context to managed Portal client
8. Gateway validates authority; Portal chooses backend and executes
9. Canonical result returns through bridge and guest socket to awaiting code
10. Middleware completion cancels unfinished requests and closes helper/scope

Failure at 3–5: no Portal call dispatched; report unavailable interface.
Failure after 7: preserve known outcome, otherwise report uncertain effect.
```

Top-level native Portal calls still use their existing handler; both routes
reuse the same SDK approval algorithm and managed Portal service. Prepared
catalogs described above are immutable presentation artifacts derived from
that service,
not an independent configuration, authority registry, or policy catalog.

## Wire contract and bounds

The local relay protocol is version 1, with canonical JSON bodies using the
existing bounded Content-Length framing primitives. The guest-local socket
supports multiple clients; the helper assigns connection-local IDs to a unique
channel-wide request ID before forwarding. Guest IDs are correlation only.

| Frame | Fields and interpretation |
| --- | --- |
| hello / ready | protocol version and negotiated finite limits; ready only after socket publication and active trusted scope |
| catalog-cache-status | selected fingerprint plus `cache-hit` or `content-required`; startup-only and trusted-side selected |
| catalog-bundle-chunk / catalog-bundle-end | ordered bytes from exact trusted `portal.catalog.read` binding plus final digest; accepted only after `content-required` |
| catalog-ready | exact fingerprint and manifest path after atomic publication; must precede normal relay `ready` |
| request | unique request ID, one of list/search/describe/call/artifact-read, canonical public request |
| result | matching request ID and canonical result; no invented successful outcome |
| artifact-chunk / artifact-end | matching request ID, reference, absolute offset and bounded base64 bytes; end supplies the canonical range metadata and exact received length |
| error | matching ID, bounded transport error code, dispatch certainty; no raw traceback |
| cancel | matching request ID only; idempotent for completed known IDs, no other scope targeting |
| credit | trusted bridge advertises remaining request/result-byte capacity; helper pauses local reads until credit exists |
| close | stops admission; cancels outstanding work; no successor auto-attach |

Strict schemas reject trustedContext, agent/profile overrides, approval decisions,
arbitrary RPC methods, and unknown envelope fields. Schema/authority validation
occurs trusted-side even when the SDK validated locally. A malformed channel
closes only its invocation bridge, not the shared agent environment.

Use 1 MiB maximum encoded message, 8 KiB header, 64 KiB process-stream chunks,
and at most 16 pending Portal requests and 16 guest connections per bridge.
Share a 64 MiB buffered-byte budget across local connections and pending frames;
pause producers at high-water and reject new requests before dispatch when no
credit exists.
Control/cancellation frames have reserved capacity. The host checks actual
encoded bytes before sending a result; oversized results become explicit
transport failures with retained dispatch certainty, never truncation of JSON.

The auxiliary relay process needs an explicit streaming I/O profile on the
existing managed process interface. It bounds retained bytes, records, and
pending work rather than cumulative bytes transferred. Consumed data releases
capacity, so sequential composition can continue within the originating
invocation deadline. This profile is available only on the trusted managed
process surface and does not grant Portal authority. Normal shell/process
defaults remain unchanged.

This is required because current strict SSH closes after 1 MiB cumulative output
and the process stdin runtime retains only 64 writes / 16 MiB. Merely enlarging
a client buffer would not fix those lower-layer limits. The following contract
changes only the auxiliary profile, not ordinary process behavior.

### Auxiliary process/stream contract

`sandbox.process.start` gains the discriminant `ioProfile: standard | portal-relay`;
normalization selects `standard` when omitted. `portal-relay` selects fixed
runtime-owned bounds, not caller-selected unlimited values. Its process handle
records the profile; subsequent stream operations derive behavior from that
handle. The guest Portal protocol exposes no process-start operation.

For relay stdin, the existing `sandbox.stream.write` request additionally carries
`acknowledgedThrough`, initially -1. This is the highest contiguous sequence for
which the bridge actually received `written` or `already-written`. It is the
sole acknowledgment event; merely seeing a higher submitted sequence is not
acknowledgment. The existing write result acknowledges bytes accepted into the
SSH channel, not guest application processing or a Portal effect.

The bridge has exactly one stdin writer and awaits each write result before
submitting the next sequence. Gateway Runtime retains its per-stream `writeTail`
serialization and owns `nextWriteSequence`, `acknowledgedThrough`,
`evictedThrough`, retained bytes, and at most 64 retained records. Within that
serialized operation it validates the entire request before mutation:

- acknowledgment must be monotone, below `nextWriteSequence`, and cover only
  records known written; a future acknowledgment is rejected;
- the next new sequence writes once; it advances the sequence and charges
  retained bytes only on successful channel acceptance;
- an identical retained duplicate returns `already-written` without writing;
  a different digest/content for that sequence is rejected;
- before adding record 65, evict oldest records only through the acknowledged
  watermark, releasing their retained-byte charge; retain the scalar
  `evictedThrough` after deletion;
- any evicted, skipped, or invalid sequence is rejected without writing; a
  concurrent out-of-order arrival is rejected, not queued waiting for a gap;
- a channel write of uncertain completion records ambiguity and stops relay
  admission. It cannot be acknowledged, evicted into retryability, or replayed.

Thus a lost write response cannot advance acknowledgment. A bounded exact
sequence/digest retry may retrieve an existing written receipt while the same
live attachment remains valid; it is not a replay of a Portal call. Connection
loss still closes the scope, without reconnect/replay. An evicted sequence is
never re-executed even if its original response is unavailable.

For relay stdout, `sandbox.stream.read` uses consuming cursor semantics under
this profile and accepts a bounded `waitMs`. The bridge owns exactly one reader
per stream. The first read has no cursor; each subsequent read presents the
previous returned `nextCursor`, acknowledging bytes through that cursor. A
repeat of the last input cursor returns the same unacknowledged chunk. An old,
forged, or concurrent-reader cursor is rejected. The runtime retains only the
acknowledged cursor and current offered cursor; it never evicts unread bytes.
No-data reads await output, process termination, cancellation, or `waitMs`
expiry through the existing scheduler; timeout returns empty data with the same
cursor. The bridge waits again rather than spinning or interpreting it as EOF.

The auxiliary stdout/stderr queue has a 4 MiB hard cap: pause the underlying SSH
channel at 3 MiB and resume below 1 MiB after consumption. Strict SSH's process
channel port gains channel-local pause/resume operations; no shared SSH
connection is paused. At the hard cap, close the auxiliary channel and report
transport ambiguity rather than dropping a byte. Stderr is drained separately
and never parsed as protocol. Ordinary retained snapshot/log cursor behavior
does not change. These read/write/profile variants belong to the canonical
private process schemas and their Python/TS projections, not the guest wire.

Before a guest request enters Portal, the bridge reserves a pending slot,
retained request bytes, and live capacity for one maximum result message;
artifact reservations include the requested range and base64 overhead.
At insufficient live capacity it returns overload without Portal dispatch.
Bytes remain charged while retained; consumption, acknowledged eviction, and
request settlement release the corresponding capacity. Credits advertise this
reusable capacity, not a lifetime allowance. A reserved control budget of 8 KiB
remains available for cancellation/close. Saturation pauses admission while
already-admitted work drains; a peer exceeding its credit closes the scope.
If an already-dispatched response is lost at a hard cap, its effect remains
uncertain. Neither the relay nor its auxiliary process rejects a request merely
because earlier completed requests transferred data.

```text
Request admitted → reserve live capacity → deliver/consume → release capacity
                          ↑                                      │
                          └──── reusable by the next request ────┘

Still bounded: messages, buffers, pending calls, and invocation lifetime.
No cumulative byte quota: completed transfers do not consume future capacity.
```

No automatic relay restart/replay occurs within a scope. The next independently
authorized invocation starts fresh. Bounds are transport/resource guarantees,
not claims that arbitrary Tool VM code is contained.

For artifact reads, retain the public 16 MiB maximum but service it as sequential
64 KiB authorized range reads through the private UDS. Validate reference,
offset, and progress on each chunk; stream framed chunks to the guest transport
and reconstruct the single canonical result there within the advertised bound.
Reserve assembly capacity before admission, including base64 expansion and
canonical result encoding; admit only one maximum-sized artifact assembly at
a time per bridge. Duplicate, missing, overlapping, or out-of-order chunks are
transport errors; they never produce a successful partial artifact.
Do not place a 16 MiB base64 result in a 1 MiB UDS message. Interleaved replies
retain IDs and offsets. Mid-read failure returns no fabricated complete artifact.

## Approval and cancellation sequence

```text
Guest code        SDK bridge          Portal/controller       Human route
   │ call              │                    │                    │
   ├──────────────────►│ call(fixed context) │                    │
   │                   ├───────────────────►│                    │
   │                   │◄─ approval_required┤                    │
   │ awaiting          ├── existing presenter(exact session) ────►│
   │                   │◄──────────────────── approve / deny ────┤
   │                   ├── approval.decide ──►│                   │
   │                   ├── exact item retry ►│                   │
   │◄─ canonical result┤                    │                    │

Decision and retry remain trusted-side; the guest never sends a decision.

Cancellation / scope close
   └── bridge stops admission and cancels request/presentation tasks
       └── managed UDS AbortSignal reaches capability core/backend
           └── completed effect is retained; cancellation is not rollback
```

### Cancelling an admitted controller CLI

R5 requires cancellation to reach the owned call. Cancelling the Gateway's
awaiting promise alone cannot stop a controller-host process. The existing
host executor already kills its child on AbortSignal; the managed-VM executor
already accepts that signal. The missing link is between Gateway control
submission and controller execution, not another guest transport.

Current source separates three facts:

- `gateway-control-command-client.ts` returns only the eventual command result;
  it provides no in-flight cancellation handle.
- `gateway-control-admission-classification.ts` refuses gateway-origin
  `operation_cancel` as `unproven_gateway_cancel`; the domain handler also
  rejects it when reached directly.
- `gateway-control-domain-handler.ts:1088` creates a configured-CLI abort owner
  only after authorization, connected to expiry but not originating cancellation.

The target extends the existing `operation_cancel` gateway variant for
configured-CLI operations. Its target is the original command's UUID, carried
as `activeOperationId`, not a guest request ID, PID, lease, or shared caller
context. It carries the existing authenticated adapter evidence for the
controller-execution principal; validation reuses the caller-registration proof
validator without allocating another caller context. Controller-originated
cancellation retains its existing contract. No guest frame gains this API.

```text
UNCHANGED: guest cancel / relay loss
  └─ SDK scope → private UDS → Portal backend AbortSignal

ADDED: Gateway command lifetime
  ├─ original command → existing control transport → controller admission
  │                                            └─ record exact command owner
  └─ cancellation → same accepted session, existing operation_cancel
                                              │
CHANGED: controller validates proof + session + command ownership
  ├─ queued/authorizing → mark cancelled → no later dispatch
  ├─ running → abort existing executor → observe termination or uncertainty
  └─ completed/unknown → no new effect; never claim rollback

UNCHANGED: original result returns through the original command correlation.
Cancellation acknowledgment is not the command's result or proof of no effect.
```

The controller control-session admission owner registers the operation after
authenticated classification and before queue admission is acknowledged. The
record holds command ID, accepted session/connection and boot/epoch identity,
validated stable principal, operation kind, expiry and cancellation state.
It is one in-memory lifetime record per admitted configured CLI, bounded by
existing queued/active admission budgets. It is neither durable execution
history nor a second approval or replay ledger.

The same owner releases records on admission refusal or actual cleanup
completion. Expiry and session retirement request cancellation; they do not
prove cleanup completion. Session retirement first marks queued work cancelled
and aborts running work. Cleanup retains ownership and capacity charges until
the underlying work settles, independently of caller-response settlement. It never kills a
whole shared Tool VM to cancel one command. Caller-context registration remains
unchanged: those contexts are cached and shared, so releasing one is not a
valid substitute for cancelling an individual command.

Gateway command submission observes the Portal signal before emitting the
original frame. Once emitted, it retains a correlated lifetime handle tied to
that accepted session. Cancellation waits for original admission receipt before
using the existing bounded safety lane; it does not wait for command completion.
If the receipt or session is lost, the original call remains uncertain and is
never replayed. A cancel must never be sent on a replacement session. Controller
session retirement and the original execution deadline remain independent
termination paths when cancellation cannot be delivered.

Only authenticated gateway-origin cancellation of this supported operation
kind enters the safety lane. Both sender and receiver validate direction and
principal; the controller also compares the exact target record. Unknown,
cross-principal, cross-session, expired and unsupported targets cannot abort
anything. The safety lane retains its existing resource limits; authority-lane
saturation must not make a cancellation wait behind the command it cancels.

The domain execution path uses the admission-owned signal, combined with its
existing expiry behavior, instead of a disconnected cancellation owner. It
checks that signal after each awaited authorization/approval step and before
executor dispatch. Cancellation does not change approval records or restore a
consumed grant. Already-running effects may remain uncertain; registered OAuth
and Git actions are not given invented rollback or process-kill semantics.

```text
Controller-owned operation lifetime

  admitted/queued ──► authorizing ──► running ──► settled
       │                  │             │
       └──── cancel ──────┴─────────────┘
                          │
                          ▼
                   cancellation requested
                     ├─ before dispatch: settle without dispatch
                     └─ after dispatch: abort; retain actual certainty

No cancelled-to-running transition. No successor-session adoption.
Duplicate cancellation has no additional effect. A completed result wins
over later cancellation; acknowledgement never rewrites that result.
```

This structure reuses the control session, proof verifier, admission budgets,
safety lane and executor signals. It costs controller/Gateway maintainers an
operation-lifetime handle and authenticated cancellation wiring. A separate
reverse socket would duplicate authority and transport ownership. Waiting only
for command expiry preserves a bound but does not implement caller cancellation.
A persistent job supervisor is unnecessary without a detached-job requirement.

Proof observes both sides of the boundary: unit state transitions and wrong-
owner rejection; real control-session cancellation while authorization is
paused and while authority capacity is full; host child exit before its natural
deadline; unchanged unrelated concurrent command; and real Tool VM relay loss
after an admitted effect, with uncertain caller outcome and no replay. Lost
receipt, session replacement and late cancellation must retain honest certainty.
The live fixture's 10-second observation window is a proof bound, not a new
public latency SLA. Vendor-side effects are not rolled back by local cancellation.

#### Caller response and cleanup have different completion points

At the private UDS request owner, a valid cancellation of a pending Portal
request atomically marks that request's reply settled, aborts its signal, and
sends one request-local JSON-RPC cancellation error. This is a transport-level
cancellation, not a canonical claim of non-dispatch or observed process exit.
It uses the original request ID. A response already emitted wins the race;
otherwise the later dispatch result/error is consumed but not sent again.
Non-Portal private RPC behavior is unchanged.

This immediate terminal reply lets the existing Python cancelled-response
drain complete without waiting for controller authorization, termination, or
the original execution timeout. The shared UDS attachment and unrelated
requests remain live. The UDS pending-dispatch capacity charge stays with the
underlying task until it settles; replying early does not create unlimited
background work. Repeated cancellation is inert while that task remains owned.
Malformed frames and actual connection faults retain their existing behavior.

```text
Portal cancellation at private UDS owner
  ├─ reply open → one cancellation error → Python drains exact reply
  │                                      └─ unrelated callers stay connected
  └─ dispatch still live → abort signal → controller/executor cleanup
                                          └─ release retained charge on settle

Late result: consume, never emit a second reply.
Early reply: never treated as proof of process exit or rollback.
```

#### Retired work remains charged until cleanup finishes

The existing controller process-admission coordinator owns the retained-work
charge across session replacement. It reuses each admission work record rather
than introducing a second command registry or persistent supervisor. For
configured-CLI work, one charge spans queued, authorizing, running and
retired-but-unsettled states. Successor sessions share that process-wide count
and byte budget; unregistering a session cannot erase retained predecessor
charges. Local active-work slots also remain charged while their underlying
execution is unsettled. Cancellation acknowledgments do not release either.

Queued work can release its charge once it is irrevocably fenced from execution.
An authorization already awaiting another owner retains its charge until the
await settles; its cancelled signal prevents subsequent authorization stages or
dispatch. Unresponsive cleanup returns uncertainty to callers within the
existing bounded response path, but retains its charge. At exhaustion, refuse
new configured-CLI admission rather than accumulate unbounded predecessor work.
This bounded fail-closed capacity loss is visible in admission diagnostics;
normal settlement releases it, and controller lifecycle restart resets
in-memory ownership under existing process management. No automatic restart is
introduced to hide a stuck operation.

Running host work has separate kill-requested and exit-observed facts. Sending
SIGKILL or rejecting the executor promise does not prove termination. Its
executor-owned child close/error observation completes resource cleanup; a
bounded unconfirmed-termination response remains uncertain while the child is
still counted. Managed-VM work retains the existing command-group termination
and retirement owner; an unsafe termination cannot release ownership merely
because a caller stopped waiting. No PID becomes cancellation authority.

Proof holds authorization beyond the private UDS drain timeout, cancels that
request, and successfully completes another on the same connection. Releasing
authorization later must produce neither dispatch nor a duplicate reply. A
second proof repeatedly replaces sessions while authorization is held, verifies
retained work remains charged and bounded, then releases it and observes
capacity recovery. Delayed child exit must remain distinct from an accepted
kill request in both result certainty and cleanup accounting.

### Scope-close versus approval-retry ordering

The bridge reuses `execute_portal_call_with_approval`, with scope-owned admission
callbacks around decision submission and exact retry. The scope and its task
registry live on one asyncio loop. `admit(stage, coroutine_factory)` performs,
without awaiting: check `active` and deadline, register the child task with the
scope's cancellation owner, then schedule it. `close()` on that same loop
atomically changes `active` to `closing`, disables admission, and cancels every
registered task before yielding. Calls from middleware threads are marshalled
to that loop; they never mutate scope state themselves. This non-yielding
transition is the linearization gate, not a check followed by an unregistered
future. No lock is held across Portal I/O or human interaction.

The initial call, post-presentation decision, and post-decision exact retry each
require separate admission. Completion of one stage grants no permission for
the next. All successful/failed paths unregister their task in `finally`.

| Race winner | Result and allowed effect |
| --- | --- |
| Closure before decision admission | No approval decision or retry is submitted; canonical non-dispatch cancellation/expiry |
| Decision admission, then closure before retry admission | A decision may be recorded, but no retry is submitted; canonical non-dispatch cancellation for the protected item |
| Retry admission before closure | Retry is already registered/in flight; closure cancels it through UDS and Portal signals. Preserve completed outcome, known non-dispatch, or uncertainty according to actual evidence—never promise rollback |
| Human response after closing | Discard response for execution purposes; the gate rejects decision and retry admission |

An admitted coroutine checks cancellation before its first transport write;
after acquiring the UDS write lock there is no await between that check and
writing the frame. Cancellation while waiting for the lock sends no request.
A frame written before closure may already have reached Portal; propagated
cancellation bounds later work but does not retroactively make it undispatched.
Portal checks the signal before reservation/arming/dispatch where applicable,
while existing controller freshness and consumption checks remain authoritative.

To prevent both successor-scope reuse and collisions between independent calls,
the bridge gives Portal a qualified call ID derived from the trusted-side
invocation nonce, distinct admitted bridge-request identity, and caller item ID.
The existing relay already assigns channel-wide request identities across guest
connections; item IDs need be unique only within their own request. Each new
request has a distinct identity even if another client or function repeats its
item IDs and arguments. No additional authority registry is introduced.
Existing `deterministicOperationId` uses call ID plus principal/revision/surface,
not conversational correlation
(`tool-portal-service.ts:628`), so correlation alone is insufficient. Encoding
`bridge-` plus the SHA-256 hex digest of the canonical tuple produces a fixed-size
valid call ID (the current RequestIdSchema has no length maximum), stable for the
trusted approval retry of that request and distinct for independent requests
and scopes. Arguments, name, namespace, and policy are unchanged. Map result
item IDs back to caller IDs; leave opaque
Portal operation IDs intact. Do not expose the internal call-ID mapping to the
guest or preserve it after closure.

```text
Same invocation, two independent requests using item "call-1"
  request A + call-1 → operation A → approval retry still operation A
  request B + call-1 → operation B → approval retry still operation B

Unchanged: caller-facing item IDs, arguments, Portal policy and approval owner.
Changed: internal qualification includes the request, not only the invocation.
```

If approval was recorded but retry was not admitted, it is not consumed by a
fake execution or reclassified as denied: the controller keeps its existing
record until its normal expiry/retirement, and the bridge returns cancellation.
No successor scope can generate the same scoped call ID. If retry was admitted,
existing reservation/consumption semantics apply. A blocked native presenter
thread may finish later, but its result has no admission authority; the bridge
does not wait indefinitely for it or start a replacement call.

Cancellation must not be swallowed as presenter-unavailable. This ordering
defines 'late approval' precisely: approval after closure cannot start work;
work admitted before closure can have a completed or uncertain effect.

## Lifetime and concurrency

| Scope state | Owner / allowed transition | Behavior |
| --- | --- | --- |
| created | middleware; exact offered binding, lazy open on first managed launch | Immutable projection/conversation/turn/fingerprint, no guest endpoint yet |
| opening | SDK bridge; active environment + helper handshake | One opener for the bound fingerprint per invocation; concurrent launches join it |
| active | bridge; request admission within bounds | Independent calls multiplex; each callback closes over this scope |
| closing | middleware cancellation/completion, authority loss, or transport failure | Reject new work first; cancel/drain owned tasks within bounded cleanup deadline |
| closed | bridge cleanup completes | Endpoint cannot attach to a successor; repeat close is harmless |

There is no closed-to-active transition. Scope close does not close the shared
Gateway SDK client or shared Tool VM; it cancels its own relay process/streams.
Cleanup removes only the invocation's guest socket directory. Gateway/Tool VM
loss causes existing active-use retirement and invalidates the bridge.

Multiple conversations may share one Tool VM but never one mutable conversation
slot. Each invocation has its own socket and frozen callbacks. These paths
prevent accidental cross-routing; they do not isolate malicious processes of
the same agent inside a shared arbitrary-execution VM. Cross-agent isolation
still comes from separate managed projections/VM bindings and Portal checks.

Nested Tool VM capability calls may acquire an additional active use and SSH
channel; the existing controller permits same-process/attachment concurrent
uses (`tool-vm-lease-authority-state.ts:408–447`). Never hold a bridge-wide lock
while awaiting Portal or human approval. Runtime capacity exhaustion rejects
the nested operation; it must not wait for the parent composition to finish.

## Failure ownership

| Failure | Detection and owner | Containment / returned result |
| --- | --- | --- |
| Helper absent or version mismatch | bridge opening | Portal context unavailable; no fallback or runtime install |
| Missing real conversation | middleware/dispatch binding | Portal calls unavailable; ordinary execution not redefined |
| Initial or restarted Gateway epoch has a failed namespace | startup preparation owner | Abort catalog-mode startup before readiness; in compact mode keep the existing generic surface and omit native catalog/generated guidance |
| Static type/Zod conversion widens or is unsupported | catalog compiler | Mark exact tool as widened and/or Portal-only validation; never claim unsupported coverage or disable the generated function, namespace, or generic SDK |
| Schema contains external `$ref` or source-bearing extension | safe compile-input projector | No network/file resolution or verbatim custom type; preserve original schema and widen affected declarations before publication |
| Offered fingerprint differs from the ready epoch catalog | instruction/middleware binding owner | Refuse generated-SDK use; never substitute another profile, epoch or fingerprint at launch |
| Prepared-source cache is full | Gateway Runtime cache owner | Refuse catalog-mode new-epoch startup or a new private offer without evicting the ready epoch or in-use bytes; compact remains on its generic surface without generated guidance |
| Private catalog read misses or crosses identity | Gateway Runtime cache owner | Bounded unavailable/denied result; no artifact fallback, host path, alternate profile or regeneration inside the read |
| Module publication is interrupted or mismatched | guest publisher | Temporary tree is never selected; reject an incomplete final tree and leave any existing complete directory unchanged |
| Forged envelope or cross-agent reference | bridge parser / Portal artifact authority | Reject before effect; guest identity fields never used |
| One provider fails | existing Portal backend | Preserve item-level partial result; other independent calls continue |
| Approval route absent/expired/denied | existing presenter/controller | Canonical non-dispatch outcome |
| Caller cancels | guest transport and bridge task | Propagate cancellation; retain completed effects and exact known outcome |
| Helper/SSH/UDS lost | respective transport, bridge owner | Close scope; outstanding calls may be uncertain; no replay |
| Buffer or channel capacity exhausted | bridge/runtime | Reject undispatched work; never silently truncate protocol frames |
| Cleanup cannot confirm process exit | managed process runtime | Preserve ambiguity and existing liveness handling; do not claim successful cancellation or create successor automatically |

Diagnostics contain version, bounded error class, operation IDs, generation,
and timing—not argument/result bodies, credentials, socket tokens, or raw
provider errors. Results remain with the caller and existing artifact store;
the bridge adds no durable request log or result database.

## Agent instructions

Extend the existing orientation renderer with a compact explanation of the
automatic SDK/CLI interface, the ready epoch's exact namespace imports and a
pointer to packaged local examples. Preserve its existing `pre_llm_call` hook,
session-once behavior and byte budget; the private profile/session/turn binding
connects foreground execution to the same epoch manifest without becoming a
freshness trigger. This reads prepared state and performs no provider discovery
or regeneration on the model turn. Reduce displayed namespace entries to fit
rather than grow the prompt or add a second pipeline. Startup checks validate
package/bridge feature compatibility; invocation readiness is checked against
the epoch binding when the bridge opens.

The local runtime guide states: composition runs in Tool VM; discover/describe
through Portal; use ordinary Python/TS control flow; check each result; await
required human approval; do not replay uncertain effects; the endpoint expires
with the invocation. Describe what is installed separately from what is live.

## How each obligation is proved

| Requirement / contract | Realization | Proof seam |
| --- | --- | --- |
| R1 / C1–C2, C6 | Existing clients, local transports, CLI | Portable schema parity; real guest Python/TS/CLI calls and result-dependent composition |
| R2 / C4 | Image overlay, middleware scope, launch injection | Both architectures' imports from work/tmp directories; helper mismatch and missing context |
| R3 / C1 | Fixed-context trusted dispatch to existing Portal | Real MCP and host/credentialed/Tool VM destination effects; forged identity and hidden/denied calls |
| R4 / C3 | Existing approval helper + scope admission gate and request-qualified call IDs | Independent clients using identical item IDs and payloads receive distinct approvals/outcomes; each exact retry retains its identity; barriers after presentation/before decision/after decision/before backend dispatch; both close-race winners; no successor approval reuse; real native approval while guest awaits |
| R5 / C2, C4–C5 | Bounded framing, reusable live-capacity credits, explicit write acknowledgments/consuming reads, operation-owned controller cancellation, artifact chunks | Sequential transfers beyond 64 MiB with bounded live occupancy and working cancellation; more than 64 writes; lost/duplicate acknowledgment; evicted/skipped sequence rejection with byte-order inspection; stalled-reader pause/resume; reordered replies; saturation; post-effect disconnect; multi-chunk artifacts; queued/running cancellation over the real control channel, wrong-owner rejection, independent-call preservation and host process exit before natural timeout |
| R6 / C4 | Existing orientation and isolation boundaries | Model-request inspection, package-only consumer without Hermes, no secret/authority leakage |
| R7 / C7 | Startup catalog mode, complete prepared snapshot, existing standalone MCP or managed native projection | Real client enumeration/call in both modes; distinct profile catalogs; incomplete initial or restarted-epoch preparation prevents catalog-mode readiness while compact retains only its generic surface; one managed epoch never changes prepared definitions; standalone metadata approval and managed native approval |
| R8 / C8 | Safe preparation-only TS compiler, digest-qualified namespace modules, epoch-stable private turn binding and explicit client binding | Foreground Hermes terminal imports the ready epoch's fingerprint for its exact profile/session/turn on cold and reused VMs; a changed definition appears only after a successful restart; dependent/concurrent calls, approval/OAuth, whole envelopes and scope close remain real; nested `tsType`/`tsEnumNames`, hostile names/descriptions and local/external refs add no declaration runtime statements or host/network reads |
| R9 / C9 | Bounded complete-source cache and atomic digest publication | Cold-start/same-epoch reuse/new-epoch changed preparation measurements; first cold read after five minutes; wrong-principal/retired-epoch reads; offered/in-use retention under capacity pressure; small/large catalogs; namespace-only import bytes/latency; peak memory; interrupted publication never becomes selectable or generated-SDK ready |

```text
Real-VM proof driver
  └─ real Hermes invocation/middleware (for identity and approvals)
      └─ real Tool VM program + installed SDK / CLI
          └─ real guest socket + relay + SSH + Gateway UDS
              └─ real managed Tool Portal and controller
                  ├─ local deterministic MCP server (real protocol, fake vendor)
                  ├─ real configured CLI with observable side effect
                  └─ real human approval adapter/channel

Catalog proof also drives the existing standalone mcp-proxy HTTP session and
the private managed UDS separately. The generated-TS production path is the
real Hermes foreground terminal, not the existing execute_code-only fixture.

Observe: returned program data, destination effect, exact approval recipient,
denied/no-effect cases, cancellation certainty, and absence of leaked authority.
```

Unit proof covers codecs, scope state, write-window guards, and canonical
projections. Integration proof covers real local sockets/stream adapters with
substituted VM boundaries. Neither replaces the real-VM path above. A local
deterministic MCP server proves MCP transport, not vendor availability. Beta
remains separate deployment evidence. Tool VM destination proof exercises the
existing configured-CLI target through Portal, not a substitute execution path.
