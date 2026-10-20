# Portable Tool Portal: design handoff

Prepared 2026-10-15; updated after networking research and the first design
correction pass. **Ready for another agent to resume research and discussion.
Library-host design review is ready; fleet selection remains open. No implementation.**

## Role handoff

The owner directed: “ok goign forwrad you are the advisor for this. ill start
the new lead”. This conversation is now the 🦉 Advisor, previously the design
Lead. The owner will start the new 🦁 Lead; its name/SessionRef has not yet been
provided. The Advisor's verified contact identity is below.

The new 🦁 Lead takes the continuing owner discussion and delivery coordination
when commissioned. It should record its SessionRef and this owner direction in
its own work record. The intended authoring transfer covers Requirements,
Specification and Program Design for the portable portal work; recipient
identification is pending. This packet alone does not appoint an unknown reader.
The Advisor answers questions and challenges proposals; it is not a second
approval gate. The reviewed baseline and **do not implement yet** remain in force.

The owner wants a reusable Tool Portal, reachable from any supported agent
harness, with local and cloud resource servers connected through a shared
private authenticated network. Cloudflare Worker and Node/Mac hosts should use
the same policy and approval library. Choosing the network and proving how Fly
and Railway attach to it are still open.

## Start here

| Item | Location / status |
| --- | --- |
| Workspace | `/Users/shravansunder/code/projects/agent-vm.design-portable-tool-portal-hosts` |
| Design branch | `design/portable-tool-portal-hosts` |
| Governing needs | [requirements.md](../../specs/2026-10-14-portable-tool-portal-hosts/requirements.md), U1–U9 |
| Observable contract | [Specification](../../specs/2026-10-14-portable-tool-portal-hosts/2026-10-14-portable-tool-portal-hosts.md), E1–E9 / R1–R14 / C1–C5 / V1–V11 |
| Structural proposal | [Program Design](../../specs/2026-10-14-portable-tool-portal-hosts/program-design.md) plus [boundary contracts](../../specs/2026-10-14-portable-tool-portal-hosts/public-host-contracts.md), corrected draft |
| Independent baseline review | [Original report](reviews/three-artifact-review.md), historical needs-revision |
| Current verification | [Same-reviewer closure report](reviews/three-artifact-verification-1.md), three-artifact-design ready, TA1–TA4 closed |
| Acceptance/proof receipt | [review-receipt.md](review-receipt.md), source/manifest match and remaining runtime boundary |
| Network facts and gaps | [networking-research.md](networking-research.md) |
| Follow-up evidence | [networking-evidence-ledger.md](networking-evidence-ledger.md), exact platform searches and claim dispositions |
| Lead finding disposition | [review-disposition.md](review-disposition.md), TA1–TA4 corrected and independently verified closed |
| Receiving-agent prompt | [copy-paste-prompt.md](copy-paste-prompt.md) |
| Earlier explanations | [Markdown and HTML collection](../2026-10-14-tool-portal-explainers/README.md); useful background, predates latest network clarification |

This is the Agent Studio copy-on-write worktree the owner requested. Work stays
here. Its source baseline is `8535fdd433dc90fed627ee7a05f63e59d58cf8ee`;
the three design documents are drafts, not an implemented or released feature.
Leave the unrelated `docs/wip/work-trails/` directory alone.

## What the owner is trying to build

```text
Any admitted agent / harness
  Hermes · Codex · Claude Code · Cursor · Pi
  possible OpenCode / custom bots
                 |
        authenticated MCP endpoint
                 |
     Tool Portal: caller → profile → capability policy
                 |                 |
        exact-call approval    known operation lookup
                 |
       operator-configured upstream MCPs
                 |
   +-------------+----------------+----------------+
   |             |                |                |
 Mac resources   cloud services   controlled CLI    execution service
 / local VMs     Worker/Fly/etc.   / API backend    VM provider / future
                                                   Codex exec server

       Private connectivity is a separate layer.
       Reachability does not grant tool permission.
```

- Tool identity, execution location, harness and VM provider are independent.
  Gondolin is one backend; Tool Portal must not depend on it.
- A Mac can expose its own resource server. A cloud portal can compose that
  server and other upstreams. Agent-coordination is a separate consumer/service.
- Provider credentials stay with trusted services. Multiple controlled CLIs can
  share a configured execution VM; there is no Google-specific credential VM.
- Network disconnection must not erase known work. Stable operation identity
  and observed status survive a replacement transport. The harness owns its
  conversation; the portal does not become a conversation engine.
- Full tools versus compact search/describe/call is an explicit presentation
  choice. A harness with its own code mode need not nest another code runtime.
- The owner wants **one private authenticated network across owned machines
  and services**, including Mac, Fly, Railway and cloud VMs. Do not reduce this
  to a collection of unrelated public MCP URLs.

## Settled intent versus structural proposals

The needs above are owner direction. The following are the current design's
proposed realization, subject to the review findings and network correction:

| Responsibility | Proposed home / boundary |
| --- | --- |
| Capability policy and routing | Shared `@agent-vm/tool-portal` core; Node and Worker host adapters |
| MCP provider discovery / invocation | `@agent-vm/mcp-portal`; separate HTTP imports from Node stdio/process imports |
| Public identity, status and versioned results | `@agent-vm/agent-portal-sdk`; matching TS/Python authored schemas |
| Caller/profile assignment and host config | `@agent-vm/config-contracts`; complete profiles, explicit activation |
| Public-host approvals and operation records | One durable operation authority per authorization domain; Worker private Durable Object SQLite or protected Node SQLite |
| Existing managed approvals / execution | Existing controller ledger, epochs and trusted managed context remain authoritative |
| Provider secrets | Host-owned resolver or remote credential-owning resource server; never public caller data |

There is no common Rust crate containing all approvals. The current standalone
Tool Portal coordinator and managed controller ledger are distinct owners.
The proposed shared semantics do not move managed approvals into the public
host's database. Read the actual binding table before changing ownership.

The proposed operation key is `(authority, verified caller, item ID)`. Batch
request IDs and logical-session IDs are correlation. Approval binds exact work
and current revisions. An owner decision changes approval state; the original
caller resubmits the same approved, previously undispatched item to trigger its
first dispatch. Lookup never dispatches. Ambiguous external work is not replayed.

The Worker library host is distinct from Cloudflare's managed MCP Portals
product. That product can be an optional outer aggregator. A Worker does not
receive shell, VM or controller-admin authority by importing our library.
Publishing privileged Mac/controller operations still needs a narrow
resource-server contract.

## Corrections and questions still open

### Independent review and current corrections

The Lead read the full baseline report and decisive source anchors, accepted
TA1–TA4, and authored a bounded correction pass. The original report remains
unmodified. **The same reviewer has verified TA1–TA4 closed and returned ready.**

| Finding | Baseline defect | Draft correction |
| --- | --- | --- |
| TA1 | Admission lacked work needed by the record/challenge | Full canonical invocation plus protected intent and association; authority-derived stable metadata |
| TA2 | Reserved approval could expire before arm/send | Final required-approval expiry guards; proven no-send versus ambiguity; no recycled authority |
| TA3 | Portable artifact authorization/storage lacked a usable binding | Shared-service artifact owner, existing byte interface, public provenance, quotas/epochs and Node/Worker realization; managed resolver preserved |
| TA4 | New states lacked public result mapping | One versioned invoke/get/cancel view, ordered batch items, terminal-only completion payload and explicit version checks |

Read [Lead disposition](review-disposition.md) and the current
[contract chapter](../../specs/2026-10-14-portable-tool-portal-hosts/public-host-contracts.md).
Requirements and Specification remain unchanged. The corrected root and chapter
are covered by the linked verification report.
The Lead matched the frozen manifest and inspected closure anchors before
accepting this bounded result. Runtime/deployment readiness is not established.

### Network and host HTTP correction

The baseline Program Design selected a public authenticated HTTPS Tunnel
endpoint for the Mac and deferred private routing. The current draft replaces
that assumption with operator-selected confidential HTTP or Workers VPC
Service/Network dispatch. No overlay has been adopted. Old report line numbers
refer to its original baseline.

The new host HTTP boundary has a strict provider/route binding, an SDK-compatible
fetch callable, and separated resource versus issuer/discovery/token routing and
credentials. Current source still lacks this hook: see
[upstream-mcp-client-runtime.ts](../../../packages/mcp-portal/src/upstream-mcp-client-runtime.ts).
The published SDK v2 client supplies custom fetch, but this is authored design,
not implemented VPC support or runtime interoperability proof. The current
verification result explicitly covers these new contracts.

Follow-up primary docs establish Railway's Tailscale Forwarder and outbound
application-proxy bridge, a Tailscale-published Fly integration, Tunnel replica
semantics and exact storage/lifecycle caveats. A Cloudflare connector using
Railway-private DNS is a documented-contract composition inference, not a
verified deployment. Full Mesh in either hosted platform remains unproven.

The [network research](networking-research.md) and
[evidence ledger](networking-evidence-ledger.md) separate facts from inference.
They distinguish full participation from selected-service access, connector
failover from replicated services/data, and reconnection from effectful replay.

The owner has now answered: “i dunno yet we need to caht about it”. Keep both
network candidates open and discuss them; do not require a selection to use this
handoff. The Cloudflare recommendation is a proposal, not an adopted decision.
The receiving agent should build understanding from the owner's deployment
information rather than presenting the same selection menu again.

Further deployment information must identify which services initiate private
connections, which only receive MCP, and which data can actually replicate.
Two connectors cannot reproduce Mac-local resources or silently replay another
portal authority's uncertain operations.

## How the receiving agent can contact this conversation

Current 🦉 Advisor SessionRef, verified with `agent-collaboration whoami --json` on
2026-10-15. Router discovery returned the same service and `codex-local` endpoint.

```json
{
  "endpoint": {
    "serviceId": "0ff962c5-7fa3-4c18-a5ca-1bbe8db09e89",
    "endpointId": "codex-local"
  },
  "sessionId": "01a13a63-0fbf-7f31-9e98-f0fec712b1c1"
}
```

Use the connected `agent-router` MCP `message_send` tool with that exact target,
`delivery: auto`, and an agent message attributed to **your own** SessionRef.
Obtain your identity using `agent-collaboration whoami --json`. Read the running
tool schema before calling it. For a local CLI with this service configured,
the installed `message send --help` confirms this form:

```sh
agent-collaboration message send \
  --to '{"endpoint":{"serviceId":"0ff962c5-7fa3-4c18-a5ca-1bbe8db09e89","endpointId":"codex-local"},"sessionId":"01a13a63-0fbf-7f31-9e98-f0fec712b1c1"}' \
  --delivery auto \
  --text 'I am continuing the portable portal design handoff. My question is: ...' \
  --json
```

This example is documented from installed help and was not executed.
A delivery receipt is not a reply. This service ID is not an Internet URL:
an agent on another machine needs an authorized connection to the same Router
service, or must return its question through the owner. Do not restart or
reconfigure the Router to manufacture reachability.

The existing 🔎 Review Sidekick is `gpt-6.1-sol`, high, target:

```json
{
  "endpoint": {
    "serviceId": "0ff962c5-7fa3-4c18-a5ca-1bbe8db09e89",
    "endpointId": "codex-local"
  },
  "sessionId": "01a13c4d-1d74-7f01-a354-58c02e2ef464"
}
```

The reviewer retains its original main-checkout cwd in Router metadata; all
source reads must use **absolute fork targets**. The correction prompt failed
at load with effect unknown. Receipt recovery established that it was absent;
the reviewer was active from an earlier authorized wake. The Lead then sent the
explicit bounded commission through Router push
`01a140af-5905-7390-9f58-145c3dda76e3`. Its receipt was `steered`, not completion.
The same read-only reviewer owns verification; do not create a duplicate.

The reviewer returned the complete report through Router push
`01a140b2-a879-7fc0-9038-49ef8bdd0526` under its read-only delivery fallback. It did
not write the optional OS-temporary report. The Lead preserved that returned
text in [reviews/three-artifact-verification-1.md](reviews/three-artifact-verification-1.md)
and checked it against the received body (only a terminal newline was added).
The review dependency is complete; no replacement reviewer, listener or wake
is needed for it. The earlier root continuation wake is not a new work grant.

## Work record, proof boundary and receiving scope

The existing trace is
[/Users/shravansunder/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-14-tool-and-mcp-portals-codex-8535fdd.md](/Users/shravansunder/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-14-tool-and-mcp-portals-codex-8535fdd.md).
Its original header predates identity discovery; use the verified SessionRef
above. Board status: `no-home` — repository-filtered discovery found no Agent VM
project. That historical trace remains owned by this session, now the 🦉 Advisor.
The new 🦁 Lead uses its own authorized work record and links back rather than
editing another writer's file.

Coverage: original 120/194/600-line design and 220-line report read in full;
corrected 624-line Program Design and 316-line contract chapter read in full.
The Lead inspected decisive HTTP/SDK, approval, result and artifact sources,
rendered/inspected four changed/new diagrams, and checked all fourteen trace
rows, local links and SVG XML. These establish document integrity, not product
behavior. No VM, provider account, deployed Worker, Access chain or Fly/Railway
configuration has been exercised. V1–V11 still require real host, storage,
protocol, client and managed-controller proof when implemented.

**Receiving task for the owner-commissioned 🦁 Lead:** take over networking
discussion and deployment-inventory intake, preserve the reviewed design and
proof boundaries, and use the 🦉 Advisor contact for questions and tradeoffs.
Authoring transfer: owner-directed to the new Lead, recipient identification
pending. Record the new Lead's identity when available; do not infer an extra
Advisor approval requirement. This packet preserves the original review and
current draft so research and verification can be reconciled.
The owner's latest explicit constraint is **do not implement yet**.

Library design phase result: `ready-for-planning`. Its next design-workflow
route is `plan-implementation` if the owner commissions planning. The current
receiving task remains networking discussion and deployment-inventory intake;
no implementation plan or deployment was created by this handoff.

Research helpers, if commissioned, follow `manage-agents`. The owner's selected
models are `gpt-6.1-sol` at high and `gpt-6-luna` at xhigh as appropriate; no
Opus. Use current primary evidence through the installed research tools and
inspect decisive source before presenting a material claim.

Useful owner information to add in a new receiving-agent WIP note:

- Exact Mac/cloud services and where each process runs; distinguish the
  deployment names `shravan-claw`, `shravan-claw-beta` and conversational
  “sunclaw” names rather than guessing they identify the same deployment.
- Existing Cloudflare enrollment/Tunnel/Access setup and existing tailnet
  membership, stated without tokens or private keys.
- Which Fly/Railway services must initiate connections, versus only receive MCP
  calls, plus their plan/runtime/capability constraints.
- Required availability when the Mac sleeps or one connector is unavailable,
  and which data/backend services are actually replicable.

Do not collect secrets into this packet. Use the existing secret-management and
1Password procedures if a later authorized runtime task needs credentials.
