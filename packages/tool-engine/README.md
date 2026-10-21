# Tool engine

`@agent-collaboration/tool-engine/capability-dispatch` admits capabilities through the shared
access assessor, an operation authority, an approval authority and an injected
resource backend. It has no Node or managed-VM imports.

The public operation key is authority, stable principal and the caller's original
item. Intent is separately versioned and hashed; changing a connection or admission
revision does not create a new key. Resource-owned context and receipt references
are selectors, never permissions. The resource must validate them before effects.

Every admitted call enters `OperationPort.createOrRead`. Only calls needing no
approval may use any host authority's explicit `untracked` (not recorded) result.
Such calls carry no reuse or recovery guarantee. Calls requiring approval must
have an operation record and a matching, current receipt before dispatch.
An unavailable store, invalid facts or an approval mismatch never invokes a backend.

The managed adapter currently lives in gateway-runtime's new `managed-tool-engine`
module. The existing production composition remains on the previous engine until
the separately planned cutover. Managed public lookup returns `unsupported-version`;
no stable-key index or public durable store is implemented by this slice.

Shared TypeScript aliases support the managed parity and integration tests.
Production source may not import them: the architecture and package-export gates
check source imports, and the packed closure checks emitted declarations as well
as runtime dependencies. All three alias controls remain in the packed proof.

`mcp-gateway` uses `direct` for native tools plus the four search tools, and
`indirect` for the four search tools alone. Hosts choose per client with
`toolLoadingMode(resolveToolLoading(address))`: `?tools=direct` selects direct;
the plain address selects indirect. The host owns startup discovery and protocol
serving; this package does not infer client behavior from its name.

`listTools(mode, cursor?)` returns an MCP result page (`tools`, `nextCursor?`).
Direct pages contain whole tools and are at most 1 MiB of serialized UTF-8 JSON,
including the cursor, `cacheScope: "private"` and `ttlMs: 60000`. JSON-RPC framing is outside this result budget. An indivisible tool over that budget is refused. Hosts
return the page and pass the next request's cursor back unchanged. Indirect lists
remain four tools; list and search retain their existing bounded result pages.

`callDirect` routes the search names to their handlers and native names to the
same dispatcher as `call`. Native approval metadata uses
`_meta['agent-vm/tool-portal-approval-token']`; indirect calls use
`portalApprovalToken`. Neither changes the upstream tool's arguments. Configure
`approvalTokens` with the caller's signing key and an awaited `consumeTokenId`
port. It must atomically record first use before answering `ok: true`; refusal,
an error or no answer runs no token-approved calls. Machines can use one
`createInMemoryApprovalTokenUse` instance per agent/signing-key scope, retained
for the process lifetime. Its default capacity remains 4,096 live token IDs.
Worker hosts must supply their shared authority instead.

Bearer derivation, token signing/verification and the per-tool TypeScript helper
are asynchronous Web Crypto APIs. Their bytes match the legacy implementations.
`describe` builds its helper from the live authorized tool record; it does not
invoke the host's full catalog compiler. That compiler remains outside this package.

`projectProxyMcpResult({ operation, input, result })` preserves the MCP proxy's
text-wrapped core result for both hosts. Scalar and malformed calls retain their
wrapper; valid calls produce ordered items, with `catalog-call` as the direct
call's public item ID. Protocol response metadata is supplied by the host SDK.

Proxy backends map known connector errors with `proxyUpstreamFailureFromError`
(or `proxyUpstreamFailureResult` after a host's nominal error extractor). The
optional `mcp-upstream-failure` detail retains redacted legacy diagnostics;
transport addresses and raw causes are excluded. Provider `isError` responses
and connect failures are `failed`; losing a response during `call_tool` remains
`ambiguous`. The gateway exposes the legacy `upstream_call_failed` item error
for either outcome. Managed adapters keep their existing certainty and retry
policy when this optional detail is present.

`createOrganizationToolCatalog` owns shared startup discovery and its request-driven
lifetime. Incomplete discovery keeps healthy providers and retries failed ones on
the next read. Complete catalogs refresh after the configured lifetime; failed
refreshes retain the previous complete snapshot with diagnostics. Passing this
source to `createPortalSessionManager` builds caller views from the organization
snapshot without owning another discovery cache. Hosts perform the first read
before accepting clients and keep protocol-specific refusals at their ingress.

A complete organization snapshot can carry refresh-failure diagnostics. Its
completeness is passed to catalog preparation separately from those diagnostics,
so both addresses keep serving its tools while the failed namespace is retried.
Only a snapshot that has never completed refuses direct listing. This deliberately
changes the old new-session refusal after a failed refresh: stateless clients now
retain the availability that connected clients previously kept.
