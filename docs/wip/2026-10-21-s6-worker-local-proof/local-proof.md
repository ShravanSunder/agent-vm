# S6 Worker local proof

This is Implementer evidence, not acceptance or a deployed result. The governing
portable-host design and subsequent Lead decisions own the contract. All runtime
proof here uses local workerd; no deploy, login, remote Cloudflare resource, or VM
execution was performed.

## Reproduce

Run from the workspace root, after installing dependencies. Every Node/pnpm
command uses Node 24.7.0 through mise. Run the quality gate before the suites:
`pnpm check` rebuilds workspace outputs and must not race test imports.

| Command, preceded by `mise exec node@24.7.0 --` | Result | Exit |
| --- | --- | --- |
| `pnpm check` | 16 gates passed: build, architecture/exports/contracts/taxonomy/version guards, lint, format, type-aware lint, all package typechecks | 0 |
| `pnpm vitest run --project unit packages/tool-host-cloudflare packages/tool-access packages/tool-engine` | 451 tests, 39 files passed | 0 |
| `pnpm vitest run --project integration packages/tool-host-cloudflare packages/tool-access packages/tool-engine` | 35 tests, 3 files passed | 0 |
| `pnpm vitest run --project e2e-host --fileParallelism=false packages/tool-host-cloudflare/src` | 49 tests, 12 files passed, no skips | 0 |

The quality gate includes `pnpm typecheck`, `pnpm lint`, `pnpm lint:types` and
`pnpm fmt:check`; each exited 0. Lint warnings remain; no lint errors remain.
The root TypeScript project excludes the Worker package's different runtime
globals; recursive `pnpm -r typecheck` still checks that package, including tests,
with its Cloudflare types.

Versions: Node v24.7.0, pnpm 10.33.0, Wrangler 4.124.0,
Miniflare 5.20260815.0-alpha, workerd 1.20260815.1 (`workerd 2026-08-15`),
inbound MCP SDK 2.3.1 and unchanged outbound SDK 1.29.0.
Wrangler's exact pin was published 2026-08-18, more than two weeks before this run.

Wrangler local mode is the main harness because the repository's permanent host
E2E lane already owns real subprocess proofs. The separate-heap test uses
Miniflare's local workerd composition to bind two distinct Worker heaps to the
same actual Durable Object in a third heap. This does not use a mocked DO.

## Observable checks

- Row 13: a real machine proxy whose source is checked against 08f9e426 and the
  Worker share one controlled MCP server and configuration. Both address modes
  compare tool definitions, list/search/describe/call results, helper text bytes,
  policy refusals, missing approval, provider isError, broken streams and refused
  connections. Direct native calls also match. Expected additions are checked
  separately: four search tools in direct, modern resultType/serverInfo, private
  list caching and TTL. DO failure and an explicitly stalled token recording
  produce zero upstream effects before recording succeeds.
- Row 14: two organizations, matching server/agent names, different credentials,
  two agents each. Missing, forged, expired, wrong-audience and organization-less
  tokens have no effect. Sending another organization, agent and session in the
  address/headers retains the token sender's credential and policy. A second
  agent's denied call has no effect. A warm removed agent's next request is 401. Distinct organization approval keys
  refuse an A-signed approval in B with zero effects; identical B-signed claims
  succeed, using both input/address modes and native-direct metadata.
  A live test issuer serves a real JWKS; tokens are really signed and verified.
- Row 15: independent literal oracles test request and upstream responses at
  4 MiB minus one, exactly 4 MiB and plus one. Exact successful upstream output
  is checked. A secret-heavy oversized response is refused before redaction.
  Batches of 50 succeed and 51 refuse before effects. Twelve slow responses send
  headers early and hold bodies: only six enter until a response completes.
  Whole serialized replies just below and exactly 16 MiB succeed; adding one byte
  to the JSON-RPC ID crosses the budget and replaces a call with too_large_result.
  Three overlapping eight-call requests with 3 MiB outputs remain bounded in one
  observed isolate.
- Row 16: a capturing analytics binding observes ran/refused/needs-approval/failed
  points with UUID index, eight strings, three numbers. Long multibyte names are
  cut to at most 256 UTF-8 bytes on character boundaries. Argument, result, secret
  and token canaries are absent from captured points and structured logs. A
  failing analytics binding drops its point and logs only a safe fixed event.
- Row 2 and raw-wire row 10: authenticated discover initializes servers; concurrent
  direct/default clients remain independent; a real SDK 2.3.1 client makes repeated
  calls. SDK 1.29 initialize, metadata/header errors (including resources/read
  name controls), GET and DELETE refuse with their specified codes/statuses.
  Arbitrary session IDs are ignored and not echoed. Discover/list work without
  Mcp-Name. The Worker has no resource/artifact implementation in this slice.
- Pagination: 170 large-schema tools plus four search tools produce five serialized
  engine pages: 1031722, 1031725, 1031690, 1031687 and 492255 bytes, each within
  the 1 MiB engine result budget. Protocol-added metadata is checked separately.
- Outage: both healthy providers are listed and called with one of three startup
  servers down; incomplete
  direct catalog returns 503; the failed server is retried on access. A complete
  catalog is reused for 60 s and retained after a failed refresh, including direct.
- Replay across heaps: two named copy heaps have distinct observed isolate IDs,
  share the authority DO and produce exactly one effect for a concurrent approval
  token. Removal through one copy immediately refuses the other copy's request.
- Socket cleanup: the same live PIDs 45597 and 45598 return from warm ESTABLISHED
  counts 12 and 7 to 12 and 7, with zero CLOSE_WAIT and zero upstream background
  streams after sequential/concurrent success, failure, abort and stream workloads.
  An observing factory forwards all protocol/transport operations to native SDK
  clients and checks every created client closes exactly once.

A production browser-target esbuild bundle of `src/index.ts` also passes, with
no agent-vm or tool-host-node input and no node:* external import. A scan of all
35 non-test tool-engine source files finds no node:* imports.

## Wrong-build controls

Each changed source was restored after its run. Raw logs and patches remain in
checkout-local `tmp/s6-worker-evidence/`; they are disposable artifacts, not
published secret-bearing captures.

| Wrong build | Intended observed failure | Exit |
| --- | --- | --- |
| Worker-memory used-token map | Two actual effects from independent copy heaps; expected one | 1 |
| Organization read from caller header | Other organization's credential used; expected token organization's credential | 1 |
| Cached agent admission | Removed warm agent returns 200; expected 401 | 1 |
| Removed six-call scheduler | Twelve body-held calls enter; expected six | 1 |
| Analytics text left over 256 bytes | Captured field exceeds independent 256-byte bound | 1 |
| Native client close skipped | Observed native close count zero; expected exactly one | 1 |

Two initial controls were insensitive and are not counted as red proof: holding
response headers hid the missing scheduler behind workerd's pending-header limit;
request-end socket reclamation hid skipped explicit close. The retained controls
instead hold bodies after headers and observe actual native close calls. Both
then fail for their intended assertions. The final restored suite above passes.

Wrangler 4.40.2's proxy workerd exceeded 2,000 ESTABLISHED sockets under the heavy
reply workload while the application workerd had eight; the guard killed only
this run's processes. The same product/workload passed with the new pinned pair.
This comparison identifies a runtime-sensitive failure, not an upstream root cause.
Every local workerd harness now checks its own child PIDs and aborts if either
ESTABLISHED or CLOSE_WAIT exceeds 2,000. All long proof commands have outer timeouts.

## Decisions, stand-ins and remaining boundaries

The Lead approved request-scoped outbound clients after native workerd rejected
cross-request transport IO. Organization catalogs contain reusable plain data;
connections are reused only within the request and its organization/agent/server.
No fetch or transport shim changes the connector. Shared catalog and typed
upstream failure policy come from accepted R-S3b. The separately committed
missing-approval parity repair (266ff58f) was carried onto S3b as d5c0bd1b.

Stand-ins: the issuer/JWKS uses test keys and assumes the E10 claim contract; the
controlled MCP server supplies deterministic protocol, credentials, stalls and
failures; analytics uses an unsampled capture binding instead of the real service;
test-only control routes admit/remove agents and observe clocks/closures. Production
exports contain none of these control routes. Deployed configuration is supplied
through the configuration-source interface and Worker secret bindings; a versioned
database source is deferred.

Deferred: agent-management HTTP route, sign-in agent-client route, owner/manager
list, per-user consents and the later database configuration source. Still
unverified: real sign-in integration, deployed Worker, separate deployed copies
sharing objects, real Analytics Engine, third-party client/model deferral context,
and CI-only VM/Hermes proof. Deployment remains blocked by B4. Local distinct heaps
sharing actual DO storage are observed; they do not establish deployed behavior.

## Permanent-proof correction after independent verification

The paired Verifier independently observed the original e0a1767a target passing
16 quality gates, 447 unit tests, 35 integration tests and 46 host tests, and ran
ten red/restored wrong builds. It found no product bug, but identified four
missing permanent assertions. The Lead required all four before acceptance.
The four-gap correction f43f7a4e changes only tests, fixture configuration and this proof report;
production Worker, tool-engine and tool-access sources are unchanged from that
observed target. The original runtime, version and bundle evidence is retained
with that explicit dependency comparison.

The corrected permanent suite:

1. Captures the actual SDK 1.29 fetch response and asserts HTTP 400, exact error
   -32022, supported versions [2026-07-28] and zero effects, without replacing
   any SDK or HTTP behavior. Discover also pins the supported version.
2. Compares malformed empty calls, duplicate-ID batch errors and mixed requests
   in both modes against the original proxy. Independent assertions require
   scalar wrappers for both error branches, literal mixed item order 2/1/0,
   success/failure/success statuses and two actual effects on each host.
3. Uses three configured providers. During one outage, the compact list contains
   both healthy namespaces and both produce effects; direct list reports exactly
   the failed namespace with 503. Recovery exposes all ten tools, and the recovered
   provider itself executes before the existing TTL/retained-complete controls.
4. Gives organizations distinct approval key bindings and values. A's token works
   in A, cannot produce any B effect, and B's own token then works with identical
   claims/call/token ID. The invalid signature does not consume B's valid token.
   This covers input tokens on both addresses and metadata on native direct calls,
   matching the two existing carrier contracts.

Seven additional wrong builds each exit 1 for the intended assertion: one global
organization approval key (foreign call produces an extra effect); wrong legacy
HTTP status; wrong legacy error code; wrong supported-version list; operation-only
item mapping; sorting numeric request IDs; and keeping only the first healthy
provider. Exact sources are restored in finally and hash-checked. The supervisor
uses 40-second per-mutant deadlines and the unmodified 2,000-socket guard.
The selected red runs skip unrelated cases intentionally; the restored full host
suite has no skips. Artifacts: `correction-mutation-status.json`, seven matching
`*-red.log` / `.diff` files and `run-correction-wrong-builds.py` under the local
evidence directory. Ordered rerun logs are `correction-check.log`,
`correction-unit.log`, `correction-integration.log` and `correction-host.log`.
The earlier final-* logs refer to the original freeze and are retained separately.

## Awaited response cleanup correction

A subsequent PR comment identified response cleanup concerns. A permanent unit
case reproduced the actual bodyless-response defect: the returned response
settled while its asynchronous cleanup was held behind an explicit barrier
(`bodyless-cleanup-pre-fix-red.log`, 1 failure, exit 1). The existing helper now
awaits bodyless cleanup. Stream EOF/error/cancel paths share a single pending
cleanup promise, so cancellation also waits when EOF has already started closing.
Four permanent deterministic tests cover bodyless completion, EOF completion,
concurrent cancellation/EOF and stream error; no provider or SDK behavior is
mocked or claimed by these unit tests. Existing local workerd native-client and
socket proofs cover the real provider path separately.

Two restored wrong builds fail: fire-and-forget bodyless cleanup and replacing
the pending promise with the former boolean. The first attempt at the cancellation
control was insensitive; draining promise work under a fake clock while cleanup
remained explicitly blocked made the boolean mutant fail its intended early-settle
assertion. The corrected red logs are `bodyless-cleanup-fire-forget-red.log` and
`cleanup-pending-boolean-red.log`; corresponding diffs and the passing four-test
`request-cleanup-unit-green.log` are retained locally.

The comment's separate ordinary throwing-fetch claim was not reproduced. In the
pinned SDK 2.3.1, `fetchFace` catches `handle` and factory failures and returns a
JSON error response. Its earlier `closed` throw does not apply to this fresh,
request-local handler, which is never closed before fetch. No speculative request
wrapper or new public contract was added. The helper's internal export is absent
from the package's public index. Final logs after this production correction are
`final-correction-check.log`, `final-correction-unit.log`,
`final-correction-integration.log` and `final-correction-host.log`.
