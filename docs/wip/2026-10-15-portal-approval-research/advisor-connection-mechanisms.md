# Connecting the cloud Tool Portal to a Mac resource service

2026-10-15. Research by the Advisor for the portable Tool Portal Lead.

**Research complete with explicit documentation and runtime gaps.** This is a
source-based mechanism comparison, not an accepted deployment decision,
implementation plan, account configuration, or runtime qualification. The owner
paused the discussion while research finishes; no new owner decision is requested.

The inspected Agent VM source is the dedicated
`agent-vm.design-portable-tool-portal-hosts` fork at
`8535fdd433dc90fed627ee7a05f63e59d58cf8ee`. The reviewed design files are uncommitted
working artifacts. Nothing in this report proves the installed services or actual
Cloudflare account currently have the proposed bindings or policies.

The completed [identity report](r1-cloudflare-mcp-identity.md) and
[runtime/network report](r2-cloudflare-runtime-storage.md) have been read in full.
Their relevant findings are integrated below. Decisive credential, Managed OAuth,
VPC, localhost, streaming and Worker-limit claims were independently checked
against primary sources. The [broker report](r3-oauth-broker-domain.md) and
[approval/Mac inventory](r4-approvals-identity-mac-tools.md) provide adjacent detail;
their current broker/ingress foundations were also inspected directly during this
Advisor's preceding commission. This report does not accept or reproduce every
finding in those separate reports.

## Direct answer

**FACT / INFERENCE:** the managed Cloudflare MCP Portal connects to the cloud
Tool Portal Worker by normal **HTTPS MCP** to its registered URL. The Worker then
connects to the Mac through either **Workers VPC → cloudflared → loopback**, or
**HTTPS hostname → Access → cloudflared → loopback**. VPC supplies private
reachability; Access supplies an application admission gate. Neither replaces our
tool policy, exact-call approval or resource execution authorization. Both Mac
arrangements use an outbound connector; neither requires opening a public inbound
port on the Mac. Sources and the qualifications of each arrangement follow.

Durable Object SQLite or D1 stores application state; neither is the connection
to the Mac. Database administration, authentication, tool authorization and private
HTTP routing are separate responsibilities. Changing a database adapter does not
enroll a machine or grant permission to execute there.

## The two connections are different

```text
Agent
  │ MCP and caller authentication
  ▼
Cloudflare managed MCP Portal
  │ HOP 1: HTTPS MCP + configured upstream authentication
  ▼
Cloud Tool Portal Worker
  │ Own capability policy, exact-call approvals and operation records
  │ HOP 2: configured HTTP dispatch to the Mac
  ▼
Mac resource MCP listener on loopback
  │ Own delegated capability ceiling and execution authorization
  ▼
Permitted local tool / executor / credential broker
```

**FACT — vendor contract:** Cloudflare's managed MCP Portal registers remote HTTP
MCP servers and proxies calls to their configured URL. A Worker can provide that
HTTP MCP endpoint. Workers VPC is an outbound private-resource connection mechanism
for the Worker; it is not needed merely because the first upstream is a Worker.
[MCP Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/),
[VPC binding API](https://developers.cloudflare.com/workers-vpc/api/).

**FACT — repository contract:** the proposed HTTP dispatcher separates the provider
resource route from OAuth issuer/discovery/token routes and preserves streaming,
cancellation and protocol metadata. Being able to reach a private endpoint does
not select a caller profile or confer managed execution authority.
[Public-host HTTP contract](../../specs/2026-10-14-portable-tool-portal-hosts/public-host-contracts.md#host-http-dispatch-is-configured-with-the-provider).

## Hop 1: managed MCP Portal to cloud Tool Portal Worker

The physical connection is HTTPS to the Worker's configured MCP URL. The following
are authentication arrangements on that connection, not alternative private meshes.

**FACT / INFERENCE:** a server-registration Access policy controls who may use
that registration through the managed portal. That is not evidence that an
arbitrary direct origin URL is protected. Cloudflare explicitly warns that direct
upstream URLs can bypass the registration policy unless the origin is separately
secured. The chosen Worker origin and any alternate routes therefore need their
own intended authentication boundary.
[Register an upstream](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#add-an-mcp-server).

| Arrangement | What is authenticated | Identity the Worker may safely use | Remaining boundary |
| --- | --- | --- | --- |
| Configured upstream bearer/custom headers | The configured upstream integration credential | The principal our verifier maps from that credential | A single shared credential does not identify each original agent. |
| Per-user upstream OAuth | The user associated with the selected upstream OAuth grant | The subject actually verified by the upstream auth adapter | One human using several harnesses is not automatically several agents. |
| Access MCP application with Managed OAuth | Access authenticates a user for that application and supplies an origin assertion in its documented flow | Verified issuer/subject for that application's audience | Do not assume the outer portal's original JWT is automatically forwarded to another upstream. |

**FACT — vendor contract:** upstream `auth_type: bearer` sends the configured static
bearer or custom headers. With `Require user auth` enabled, OAuth upstreams use
the user's own grant. Autonomous service-token sessions require that setting off
and use the upstream admin credential on every request. Admission is checked for
the portal and each linked server. These are documented separate checks, not
proof of original-agent identity propagation.
[Upstream bearer configuration](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#bearer-authentication-credentials),
[Service-token sessions](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#connect-with-a-service-token).

**FACT — vendor contract:** Managed OAuth tokens are opaque. In the documented
Access application flow, Access resolves the token and forwards a signed
`Cf-Access-Jwt-Assertion` to the origin. The MCP origin must validate its assertion.
An explicit Linked App Token pattern exists for downstream applications; token
forwarding/delegation is not automatic.
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

**UNKNOWN:** the exact configured authentication arrangement that preserves the
owner's required agent/user context through the managed portal has not been
qualified. Shared profile, shared caller and represented user are different
concepts. Separate origin registrations/paths with separate static credentials
are a possible composition to investigate, not proven support: duplicate URL
acceptance and per-registration policy/credential/catalog isolation remain open.

**FACT / UNKNOWN:** the documented per-server Service Auth authorization includes
the ability to see and call tools. That is not runtime proof of denial through
every guessed alias or Code Mode path. The origin's own complete profile policy
must still reject a direct call to a hidden capability.

## Hop 2A: a Workers VPC Service through the Mac's Tunnel

```text
Worker's configured service binding
  │ private HTTP fetch to one registered service
  ▼
Cloudflare Tunnel connection
  │ connector runs on the Mac
  ▼
Dedicated Mac resource listener
```

**FACT — vendor contract:** a VPC Service registers a tunnel ID, destination
hostname/IP and port. Its binding's `fetch` always uses that registered destination.
The URL hostname supplies HTTP Host and HTTPS SNI; it does not replace the service's
actual route. Both HTTP and HTTPS are supported. Traffic is encrypted until it
reaches the tunnel's network; choosing HTTP makes the connector-to-origin leg
plaintext. On this design that leg must stay on the same Mac's loopback interface.
[VPC Services](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/).

**FACT — vendor contract:** the Mac's `cloudflared` initiates persistent outbound
connections. Workers VPC requires a supported connector version and QUIC over
outbound UDP port 7844. The same connector instance can serve Zero Trust/public
hostname and Workers VPC use cases, but public ingress rules are not the VPC
Service routing configuration. Tunnel replicas are availability mechanisms and
do not make Mac-local data available on another machine.
[VPC Tunnel setup](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/).

**FACT / INFERENCE:** the current VPC setup guide explicitly lists `localhost` as
an internal-service address. A same-Mac connector can therefore target an IPv4
loopback listener under the documented service model. Use the actual IPv4 target
for a listener bound only to `127.0.0.1`; `localhost` can resolve to IPv6, and a
connector in a container, VM or other host has a different loopback namespace.
This is documented configuration plus a network-namespace inference, not a live
connection receipt.
[VPC service setup](https://developers.cloudflare.com/workers-vpc/get-started/#3-create-a-vpc-service).

**INFERENCE:** for one fixed Mac MCP service, Service binding scope is a smaller
network grant than a whole VPC Network binding. It also avoids publishing an
additional public application hostname for this particular Worker-to-Mac hop.

**FACT / LIMIT:** the VPC binding grants infrastructure reachability. It does not
document a per-agent/user assertion delivered to the Mac. The resource service
still needs an explicit authenticated caller/delegation contract and its own
capability ceiling. Private packets are not proof of caller permission.

The Worker must construct its upstream authentication from the configured resource
binding rather than blindly forwarding the incoming agent's Authorization header.
The public-host dispatch contract separately restricts OAuth issuer/token routes;
resource credentials must not be reused for a provider-supplied arbitrary URL.

**UNKNOWN:** the exact production connector and loopback target, permitted Host,
MCP streaming behavior and origin authentication have not been exercised here.
The generic vendor service contract is not itself an end-to-end proof that the
owner's current Mac listener is ready for this route.

Even a functioning public website over an HTTP/2 connector would not prove the
VPC requirement. General Tunnel can fall back to HTTP/2 over TCP when QUIC is
blocked; VPC explicitly requires QUIC. The actual negotiated connector transport,
not merely an `auto` setting, belongs in qualification evidence.
[Tunnel fallback](https://developers.cloudflare.com/tunnel/troubleshooting/#quic-connection-fails).

## Hop 2B: a VPC Network binding

**FACT — vendor contract:** a Network binding can reach services through a bound
Tunnel or Cloudflare Mesh and their advertised routes. The URL passed to `fetch`
selects the actual destination; Network bindings additionally offer raw TCP
`connect`. Service bindings pin one target. Both have HTTP `fetch`.
[VPC API](https://developers.cloudflare.com/workers-vpc/api/).

**INFERENCE:** use Network scope only when the Worker has a real requirement for
several explicitly configured destinations that cannot reasonably be represented
by individual Service bindings. Arbitrary agent arguments must never become URLs
or raw socket destinations. The HTTP dispatcher already names the appropriate
resource/issuer allowlist boundary; adding broader network scope must preserve it.

**UNKNOWN:** Access origin identity and application grants are not automatically
added just because the route uses the account network. No assumption of per-user
or per-agent identity is made for this mechanism.

## Hop 2C: published Tunnel hostname protected by Access

```text
Worker fetch to configured HTTPS hostname
  │ Access service credential + independent resource authorization
  ▼
Cloudflare Access gate
  │ Cloudflare Tunnel
  ▼
cloudflared on Mac → loopback-only resource MCP listener
```

**FACT — vendor/repository distinction:** a published Tunnel hostname routes an
HTTPS application through the connector to its configured local origin. Access
protects admission to that application; the Mac service applies its own capability
authorization. The existing browser setup uses this transport pattern, but its
human identity adapter is not the machine path.
[Existing browser ingress design](../../specs/2026-09-20-cloudflare-browser-identity/program-design.md#structure),
[Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

**INFERENCE — machine integration arrangement:** an independently configured
Service Auth policy can admit the Worker's service credential. A separate resource
bearer can authorize its bounded actions at the Mac; using separate Access
client-ID/secret headers avoids treating the resource's Authorization bearer as
the same authority. The exact header combination and origin verification require
real qualification. This authenticates the cloud integration, not an original
agent or represented human by implication.

**FACT — user arrangement:** Managed OAuth can instead establish a user subject
for the protected application. That requires its documented OAuth/verification
flow. A headless Worker fetch is not a browser login, and the existing website
login cookie must not be borrowed as a service credential.
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

**FACT / LIMIT:** Access's documented service-token origin assertion identifies
the service token and has an empty human subject. Its identity is not the original
agent or a human resource-account owner. The existing human verifier requires a
nonempty subject and must not be reused to relabel that machine identity as a
human.
[Application-token payloads](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/#service-token-authentication),
[Human verifier](../../../packages/agent-vm/src/controller/oauth/cloudflare-access-identity-verifier.ts#L20).

**FACT / INFERENCE:** if a cloud origin actually receives a verified user's Access
assertion, the documented self-hosted Linked App Token arrangement lets that
origin explicitly forward it to a cooperating self-hosted Mac application as
`Cf-Access-Token`. Access then issues a new Mac-application-audience assertion.
The downstream selector is restricted to self-hosted applications. It is not an
automatic property of managed MCP server registrations, does not create an agent
identity, and cannot manufacture a human from a machine-only session.
[Linked App Token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/linked-app-token/).

**INFERENCE — tradeoff:** this reuses the existing published-hostname pattern and
can be useful when non-Worker clients also need an explicitly authorized route.
It adds a public hostname and an Access application/policy/credential lifecycle;
the private VPC Service arrangement avoids those parts for Worker-only access.
Neither route creates the resource-service authorization contract.

## Hop 2D: plain HTTPS with a resource bearer

**FACT:** the portable HTTP connector contract can call configured HTTPS resource
endpoints with protected credentials. Access is not the only possible application
authenticator. [Dispatcher contract](../../specs/2026-10-14-portable-tool-portal-hosts/public-host-contracts.md#host-http-dispatch-is-configured-with-the-provider).

**INFERENCE:** this is the simplest application request shape if an independently
secured reachable HTTPS endpoint already exists. It does not itself provide the
Mac's network reachability. If a public Tunnel is still the connector, omitting
Access means the origin bearer is the application's admission boundary. This is
not described as equivalent to an owner requirement that traffic pass Access.

## Streaming, deadlines and sizes

**FACT:** managed MCP Portals accepts the documented current stateless MCP and
earlier Streamable HTTP clients. Upstream HTTP/SSE support differs from the
optional Gateway-inspection path, which supports Streamable HTTP only. Protocol
sessions or authorization grants are not durable execution jobs.
[MCP transport](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#transport),
[Gateway transport limits](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#supported-transports).

**FACT / UNKNOWN — outer portal limits:** the completed identity report found no
published portal-specific maximum tool-call duration, response-idle/heartbeat rule,
request/response/stream-frame bound or end-to-end cancellation contract. The
documented **24-hour** value is legacy MCP-session inactivity, not an allowed tool
runtime. General Worker or proxy limits must not be relabeled as the managed
portal's own undocumented deadline.
[Session lifecycle](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#session-lifecycle),
[Parallel forwarding evidence](r1-cloudflare-mcp-identity.md#3-mcp-forwarding-streaming-timeouts-and-sizes).

**UNKNOWN:** unchanged forwarding of arbitrary request `_meta`, tool-result
`structuredContent`/`isError`, progress notifications, upstream elicitation and
cancellation was not established by the inspected portal contract. The portal
selects client and upstream protocol versions independently, so this is protocol
mediation rather than a byte-for-byte tunnel. The new server-held approval design
avoids relying on private HMAC `_meta`, but the public operation envelope/results,
status tools and artifact access still need the actual chain proof.

**FACT / INFERENCE:** optional Gateway DLP may block a response after the upstream
has processed the request. A resulting portal error is not evidence that a tool
had no effect and does not authorize replay.
[Gateway response blocking](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#what-happens-when-a-request-is-blocked).

**FACT:** VPC `fetch` accepts ordinary HTTP methods, request headers/body and an
AbortSignal and returns a standard Response. Standard Workers request-size,
timeout and subrequest limits apply. These API shapes do not prove that a
particular MCP stream, authentication chain or origin stays alive end to end.
[Binding API](https://developers.cloudflare.com/workers-vpc/api/),
[VPC limits](https://developers.cloudflare.com/workers-vpc/platform/limits/).

**FACT — Worker platform limits, checked 2026-10-15:** these apply to the Worker
hop. They are not documented managed-MCP-Portal limits or a supported end-to-end
MCP deadline. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

| Resource | Documented Worker boundary | Consequence for this path |
| --- | --- | --- |
| CPU per HTTP invocation | Free 10 ms; Paid default 30 s, configurable to 300 s | Network waiting does not consume CPU; JWT checks, parsing and buffering do. |
| HTTP wall time | No hard limit while the client remains connected | An earlier portal/client/VPC deadline can still end the call. |
| After response/disconnect | Request work may be cancelled; `waitUntil` extends it by at most 30 s | This is not durable detached execution or proof the Mac stopped. |
| Memory | 128 MB per isolate, shared by concurrent invocations | Stream bounded output instead of buffering arbitrary bodies. |
| Incoming request body | Zone/account plan: Free/Pro 100 MB, Business 200 MB, Enterprise configurable up to 5 GB self-serve | Our finite application bound should be much smaller; upstream portal bounds remain unknown. |
| URL and headers | URL 16 KB; request and response headers each 128 KB total | Authentication/protocol envelopes must fit every hop. |
| Response body | No enforced Worker response-body maximum | This does not waive app, memory, storage, client or outer-portal limits. |
| Subrequests | Free 50; Paid default 10,000, configurable | Discovery, authentication and redirects also consume request budget. |
| Initial outbound connections | Six simultaneously waiting for response headers | A sleeping origin can occupy admission capacity; a fetch stops counting after headers arrive. |

**FACT / UNKNOWN — published Tunnel settings:** origin parameters document TCP
connect 30 s, TLS handshake 10 s and idle keepalive expiration 90 s as defaults.
The 90 s value is an idle pooled-connection lifetime, not a tool-call or active
SSE deadline. Published origins use HTTP/1.1 by default; `http2Origin` requires
HTTPS and attempts HTTP/2. These settings do not establish the private VPC path's
numeric timers or complete HTTP-version matrix.
[Published-origin settings](https://developers.cloudflare.com/tunnel/reference/origin-parameters/).

**FACT / UNKNOWN — streaming:** general Tunnel documentation requires the origin
to identify SSE with `Content-Type: text/event-stream` to avoid its default
buffering. The VPC API returns a standard Response, but the complete VPC-specific
SSE/backpressure/upgrade matrix is not documented by those facts. Neither a
buffered success nor a connected socket proves timely streaming.
[Tunnel streaming](https://developers.cloudflare.com/tunnel/troubleshooting/#cloudflare-tunnel-is-buffering-my-streaming-response-instead-of-streaming-it-live),
[Runtime report](r2-cloudflare-runtime-storage.md#1-workers-vpc--tunnel--loopback-origin).

**UNKNOWN — VPC timers:** no numeric VPC connection/read-idle/write-idle/stream
maximum was established in the inspected API/limits/Tunnel sources. Named timeout
errors exist. Do not substitute the published-origin defaults or unlimited Worker
wall time for that missing contract. [VPC errors](https://developers.cloudflare.com/workers-vpc/reference/troubleshooting/).

The effective bound is the smallest relevant client, managed portal, Worker,
Access/proxy, Tunnel, Node listener and executor bound. CPU time, response idle
time, total request duration and job lifetime are different measurements.

**FACT — source:** the existing #231 browser app has a 16 KiB body limit and a
human assertion-verification middleware. That is a browser operating contract,
not a new MCP payload limit. The existing standalone projection's bounded output
is likewise not a vendor transport limit. Reusing either listener without its
actual protocol/bounds contract would be incorrect.

## What #231 can and cannot supply

**FACT — current source:** the OAuth website is a distinct loopback listener in
the controller process. Its ingress verifies RS256 signature, configured issuer
and application audience, bounded claims and human subject. The current verifier
requires `nbf` and returns an authenticated human. It is not a general machine
credential-to-agent mapper.
[Verifier source](../../../packages/agent-vm/src/controller/oauth/cloudflare-access-identity-verifier.ts#L163),
[Website middleware](../../../packages/agent-vm/src/controller/oauth/oauth-https-server.ts#L167).

**FACT — preserved boundary:** the public website origin is configured separately
from its internal port; Tunnel must not expose the controller administration
listener. Website identity, Google resource consent and tool-call approval remain
different checks.
[Browser requirements](../../specs/2026-09-20-cloudflare-browser-identity/requirements.md).

The drawings do not assert that the proposed Mac resource endpoint is deployed.
An already-configured, independently secured MCP service can be used. Exposing
privileged controller operations is a separate governed resource-service contract;
publishing the website or controller administration URL does not provide it.
[Existing public/managed boundary](../../specs/2026-10-14-portable-tool-portal-hosts/2026-10-14-portable-tool-portal-hosts.md#c5--configuration-and-existing-managed-behavior).

**INFERENCE:** reuse the existing connector installation/supervision and the
loopback-origin pattern, subject to inventory/qualification. Add the explicitly
selected MCP route and its own verifier, audience and resource policy. Reusing
the connector does not require reusing a human website's Access policy or sending
machine traffic through its 16 KiB browser form handler.

**UNKNOWN:** the installed connector's version, transport, exact published routes,
DNS/Access account state and actual listener bindings were not inspected. Existing
code or a prior PR does not certify that deployment state.

## When the Mac sleeps or disconnects

| Observation | Required interpretation |
| --- | --- |
| Connection cannot be established before dispatch | Unavailable/not dispatched only when no-send is established. |
| Mac disappears after a request may have reached execution | Preserve ambiguous or already-known operation state; do not infer failure without effect. |
| A stream closes | The stream ended; that does not prove the process stopped or the external action failed. |
| A response is blocked by Gateway inspection | The upstream may already have acted; preserve the original operation and obtain authorized status rather than creating another effect. |
| Mac returns | Reauthenticate and query the original operation/receipt where supported; do not issue a replacement effect under a new key automatically. |
| Another connector remains connected | It helps only if it can reach the same authorized origin and data. A connector on another host does not reproduce this Mac's local applications. |

**INFERENCE:** a sleeping Mac makes its connector/local execution unavailable;
neither Access nor a Worker VPC binding is a wake-on-LAN mechanism or a job queue.
Exact errors and timeout timing depend on which component notices the loss first.
The selected path must be tested before and after an observable side effect.

**FACT — product contract:** uncertainty and no automatic effectful replay are
already specified. Long-running work belongs to a resource service with its own
accepted-job/receipt guarantee; keeping a Worker request or protocol session open
does not supply that guarantee.
[Failure contract](../../specs/2026-10-14-portable-tool-portal-hosts/program-design.md#state-concurrency-and-failures).

## Recommendation to qualify, not a selected deployment

**INFERENCE:** keep Hop 1 as ordinary HTTPS MCP to the cloud Worker, with an
explicit verified caller arrangement. Do not call a shared static upstream token
per-agent authentication. Per-user OAuth is appropriate only for the user identity
and client flow it actually verifies; the unattended agent case needs its own
proven arrangement.

**INFERENCE:** for a fixed Worker-to-Mac resource endpoint, qualify a **VPC Service
binding through the same Mac's cloudflared**, with an independent bounded resource
credential/delegation contract. It pins one destination and keeps this hop private.
Its beta status, connector requirements and exact loopback/MCP interoperability
remain costs and qualification gates. Prefer Service over Network scope for that
single resource.

This hop does not require Tailscale. That is not a recommendation to remove the
owner's existing Tailnet or its separate administration paths; no fleet-network
migration is selected here. A VPC Service is one controlled application route,
not general membership for every host in a replacement mesh.

**INFERENCE:** retain **HTTPS published Tunnel plus Access Service Auth** as an
explicit alternative when the deployment needs that public application route or
cannot qualify VPC. It reuses more of the current ingress pattern but adds
hostname/policy/credential administration. It must not become automatic failover
for a request with an uncertain effect.

This report does not select the pending exact origin-identity mapping, approval
ownership or a transport change. The owner has stated per-agent/on-behalf-user
control requirements; this report does not silently resolve their credential and
delegation realization. The recommendations do not move Google policy or
credentials, expose controller administration, or authorize account mutations.

## Smallest real qualification

1. Observe the actual origin identity for each selected caller kind; test wrong
   issuer/audience, wrong resource credentials and cross-caller operation access.
2. Through the selected path, exercise real MCP discovery and an allowed call,
   streaming, cancellation and actual configured size/deadline bounds.
3. Prove pending approval sends no action, approved resubmission sends once, and
   concurrent retries/restarts do not duplicate it.
4. Drop the connection before delivery and after an observable side effect.
   Reconnect and obtain honest original status/ambiguity without another effect.
5. Disconnect or sleep the actual Mac, observe the connector/origin failure, and
   recover against its original operation identity. A fake Mac is not this proof.
6. Verify that the chosen Tunnel/VPC route reaches only the dedicated resource
   listener and never the controller administration surface.

No such runtime, installed-client, account, VM, provider or deployment proof was
performed in this research. No secret values or private deployment identifiers
were read or recorded.

## Related policy/custody findings from the preceding commission

**FACT — current source:** Google authorization and encrypted token material are
currently in one authorization row. Account override policy is a separate encrypted
companion. Policy edits transition active → applying, contain old runtime material,
then activate. Consequently a cloud-policy/Mac-credential split must replace the
current joined revisions and containment/activation protocol, not merely move SQL
rows. Cloud-manageable configuration does not, by itself, select that migration.
[Schema](../../../packages/oauth-broker/src/catalog-schema.ts#L30),
[Policy transition](../../../packages/agent-vm/src/controller/oauth/google-account-policy-editor.ts#L308),
[Broker domain report](r3-oauth-broker-domain.md).

**FACT / INFERENCE:** user identity is issuer plus subject, distinct from the
provider resource subject and from the calling agent. Generic delegation, provider
OAuth consent, Ask/Allow policy and exact-call approval are separate truths. A
cloud Allow never increases authenticated scopes or a backend's activity ceiling.
Existing native approval presentation does not automatically establish a verified
Access resource-account owner as its approver.
[Policy evaluator](../../../packages/tool-portal/src/google-account-policy.ts#L33),
[Approval and identity report](r4-approvals-identity-mac-tools.md).

**FACT / INFERENCE:** D1 has atomic statements/batches; DO SQLite has a synchronous
transaction callback. A conditional SQL authority could implement a one-use gate,
but ordinary JavaScript SELECT/check/UPDATE calls or a shared Drizzle table schema
do not establish equivalent serialization. No cross-store transaction includes
the Mac execution effect. Database tooling must not let an ordinary agent bypass
the protected configuration/approval API by editing its own authority with raw SQL.
[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[DO transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transactionsync),
[Runtime atomicity comparison](r2-cloudflare-runtime-storage.md#7-atomic-approval-validity-check-and-consumption).

## Evidence coverage and remaining unknowns

- **FACT — inspected:** r1 and r2 complete reports; the named source baseline;
  the #231 requirements/design and decisive current verifier/middleware; the
  public-host provider dispatcher; direct primary MCP Portal, Managed OAuth,
  application-token, Linked App Token, VPC API/Services/Tunnel/get-started/limits,
  Worker limits and published Tunnel origin/streaming pages. Adjacent r3/r4 are
  linked for the Lead's separate domain/approval review; their complete findings
  are not accepted wholesale by this connection report.
- **Source route:** current local source and docs, completed parallel reports,
  then narrow primary-source verification. Tavily extraction returned no failed
  URLs for the decisive verification batches. Perplexity was used for discovery
  and challenge of identity/transaction hypotheses, not as final product evidence.
- **Verbatim bounded queries:** the identity lookup asked whether an upstream
  Access MCP application plus one shared bearer authenticates each original agent;
  the registration lookup asked whether duplicate endpoints with separate server
  credentials/policies are explicitly supported, prohibited, or an inference;
  the database lookup challenged "D1 cannot implement read-check-write approval
  consumption" against batch, conditional SQL and DO transaction semantics.
  Search gaps from the parallel reports remain attributed to their actual scopes.
- **UNKNOWN:** actual installed connector version/transport/routes and Access
  policies; the selected original-agent/user credential chain; duplicate-endpoint
  registration and per-registration isolation; portal-specific call/body/frame
  limits and exact field forwarding; VPC numeric timers and complete streaming
  matrix; actual client/Worker/Mac MCP interoperability; Mac outage recovery and
  controller/resource authorization integration. No absence of documentation is
  presented as product prohibition or unlimited support.
- **Not searched or performed:** account/API mutation, login, private credential
  resolution, installed client execution, UI operation, live HTTP/VM/provider
  calls, network migration, D1/DO schema migration, or new implementation. Those
  are outside this research commission and the owner's pause.
- **Validation:** document navigation/fences and authored-file readback only.
  No fake integration, test discovery or source inspection is called runtime
  evidence. The recommendations are design input; unresolved identity/resource
  and stream contracts return to the Lead, not an implementation-ready verdict.
