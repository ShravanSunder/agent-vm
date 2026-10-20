# Portal approval and connectivity: paused design state

Paused 2026-10-15 at the owner's request ("let all the agents finish their
current research, we can continue this later"). **Design mode. Nothing is
implemented, no governing document changed, and no owner decision below is
final unless marked owner-stated.**

Resume here. The Lead's full running account (evidence, corrections, Advisor
dispositions) is the session log
`~/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-15-portal-network-choice-lead-6852afea.md`.
The earlier reviewed library design and handoff are in
[docs/specs/2026-10-14-portable-tool-portal-hosts/](../../specs/2026-10-14-portable-tool-portal-hosts/)
and [docs/wip/2026-10-15-portable-tool-portal-handoff/](../2026-10-15-portable-tool-portal-handoff/handoff.md).

## What the owner said (verbatim, typos kept)

1. "the goal is that tool portal can be part of cloudflare mcp portal -> connected to any tools and ally took execution kind"
2. "clodufalre portal -> cloud tool pro9tal (hostclodkuflare) -> cloud / tool portal runnign in mac expsoed to cloduare to hwo do we deisgn this is what im asking"
3. "all goes thorugh my access contorl ssytem andp protected protal so any of my agents can access it auth i configh sytsmte and approvals"
4. "we update and deslopify the current apprlvoal page too thats part of it but we nee dto deisng this out well"
5. "all approval config need to be configs but in a database"
6. "so this means we3 can use a druable object database or d1 dastabase abstracted away we need to have a clould managealbe system that i can easly edit with agents as well. in addition, approval and control is per agent, or on behalf o f suer so we need to rethink thisn veyr very careuflly"
7. "you shoudl [not] assume anytnhgin go reserach with sol anytnign yo dont ukdnteand"
8. "how would clodu conenct to the worker? clodufalre vpc or and cloduflare acces whats the mechsim?" and "get adivsor to look itno this in detail"
9. "kuse a sol to reivew and plan the state we want to get to for approval and then you plan the user experience"
10. Earlier, about networking: Tailscale is for the owner's own machines. Agent coordination does not need Tailscale or Mesh. The Gondolin 0.13 upgrade is the base branch for later work.

## Where things stand

| Topic | State | Notes |
| --- | --- | --- |
| Goal | Owner-stated (1) | Cloudflare's MCP Portal is a supported *optional* outer door ("can be part of"), not the only way in. |
| First build is the Tool Portal, not agent coordination | Lead read, unconfirmed | |
| Two portal instances: cloud (Worker) and Mac (Node) | Owner-stated (2) | |
| How the Mac connects | **Open** | A: side by side. B: cloud portal → Mac *service* (Lead recommendation). C: cloud portal → full Mac portal (C has a source-level gap: `packages/mcp-portal/src/mcp-provider-backend/mcp-provider-capability-backend.ts:607–632` turns an inner "waiting for approval" into an outer "completed"). |
| Connection mechanism per hop (VPC versus Access versus bearer) | **Researching**: Advisor | Owner question (8). |
| Config and approvals live in a database | Owner-stated (5, 6) | Durable Object or D1 behind an abstraction. Cloud-editable by the owner *and by agents*. |
| Approval and control per agent **or on behalf of a user** | Owner-stated (6), model **open** | "Rethink very carefully." |
| Caller identity: separate per agent or shared | **Open** | Lead and Advisor recommend separate callers that can share a rule set. A shared profile is not a shared caller (spec E2/E4/E6). |
| Controller-run CLIs/VMs reachable from the cloud | **Open**, owner security decision | Needs a resource-service contract (spec C5) and an explicit decision to open a door into the controller. |
| Approval page | Owner-stated in scope (4) | Today's web UI (`packages/oauth-approval-ui`) handles Google-account approvals only. Tool-call approvals happen in Hermes chat. |
| Tailscale in the tool path | Lead inference only | The owner said the Mac is "exposed to cloudflare". |

## Lead's draft model (unverified; the Sol Sidekick is reviewing it)

Grounded in the existing Google broker, which already models people,
accounts, per-agent authorizations and Deny/Ask/Allow policy in SQLite through
Drizzle (`packages/oauth-broker/src/catalog-schema.ts`). Owners and policy
editors live in `packages/config-contracts/src/oauth-config.ts:112–146`.

```text
 Person ─ owns ─► Account (Gmail, ...)
   │                 │  Grant: "agent may act for this person through this
   │ owns / edits    ▼         account" + Deny/Ask/Allow (versioned)
 Agent ── own policy: Deny/Ask/Allow for its own tools
   └── call ─► lane decides the approver
         agent's own tool       → the agent's owner approves "Ask"
         on behalf of a person  → that account's owner approves "Ask"
```

- Agents may **propose** config changes. A person with edit rights over that agent approves them, and an agent never raises its own permissions.
- Config, approvals and call records sit in **one transactional store**, so a policy change cannot race a pending approval (`program-design.md:498`).
- Storage is one Drizzle schema behind repository ports:
  - **Durable Object SQLite** for the cloud authority. It is transactional and strongly consistent, with `transactionSync` (Cloudflare docs).
  - **SQLite** on the Mac and in tests.
  - **D1** only where batch atomicity is enough. D1 documents only atomic `batch()`.
  - Drizzle documents both `drizzle-orm/durable-sqlite` and `drizzle-orm/d1`.
- Open storage-boundary decision: move policy and grant truth from the Mac broker database to the cloud while credentials stay on the Mac (Lead recommendation), or keep Google policy on the Mac.

### Corrections already received (read these before trusting the draft above)

From the Advisor ([advisor-domain-pressure-test.md](advisor-domain-pressure-test.md)) and the Sol Sidekick's interim note (Router push `01a14133-30b1`):

- **Two exclusive lanes are too simple.** A delegated call identifies the calling agent *and* the represented person, account and grant; it does not replace the agent. Admission should be **conjunctive**: portal/agent policy AND delegated resource authority AND consent/scope AND execution ceiling AND exact-call approval. An account owner's approval never waives a portal "Ask".
- **"Agent's owner approves / account owner approves" is a Lead proposal**, not something the owner said. Requester, account owner, editor, administrator and actual approver are distinct roles. A missing approver mapping must fail closed, never fall back to the requesting agent or any logged-in user.
- **"Agents only propose changes" is a Lead proposal.** Reuse the reviewed design's desired → validated → active snapshots and scoped `configuration:activate` authority before inventing a separate proposal system. Agents edit through an authenticated management API with bounded authority, never raw SQL that could rewrite their own ceiling or approver.
- **Identity details:**
  - A person is `(issuer, subject)`, not an email address, and multiple issuers need an explicit linking rule.
  - `owners.allowedAgentIds` is an admission list, not one-owner-per-agent.
  - A generic agent→person delegation is not the same as a Google OAuth authorization (account × agent × application with client binding, generation and credential identity).
  - A grant has several independent states: access, lifecycle, material version and policy applying/active.
- **Moving Google policy truth to the cloud is an authority migration, not a storage swap.** The broker couples a revision cohort, an applying → containment → active protocol, *encrypted* policy rows and credential AAD bindings. A smaller arrangement exists: the cloud owns portal caller policy, approvals and the management UI; the Mac broker keeps Google consent, encrypted material, actual-scope truth and its own ceiling, managed through a protected versioned API with no second writable copy. **The Lead's earlier recommendation (move policy and grants to the cloud) is withdrawn until this comparison is made.**
- **The D1 claim was overstated.** D1 `batch()` is transactional, and conditional SQL can encode an atomic one-use gate, but that needs a different, proven authority implementation. Durable Object SQLite matches the current synchronous transaction model directly. One Drizzle schema does not guarantee equivalent transaction semantics across the two.

## Research in flight (results land in this folder)

All run as OpenAI Sol through agent-router (`codex-local`). Each writes one report here and messages the Lead.

**Landed so far:**
- `r1-cloudflare-mcp-identity.md`: complete.
- `r3-oauth-broker-domain.md`: complete. Return token `program-design-gap`: grant and credential are one row today; local synchronous authority and containment gates.
- `advisor-connection-mechanisms.md`: complete (Advisor). Hop 1, Cloudflare portal → cloud Worker, is ordinary HTTPS MCP. Worker → Mac is either a VPC Service through the same Mac's cloudflared to loopback (beta, needs QUIC; timers undocumented) or a published HTTPS Tunnel plus Access. #231's browser verifier is not machine MCP ingress. Includes a six-step smallest real qualification.
- `advisor-domain-pressure-test.md`: complete.

- `r2-cloudflare-runtime-storage.md`: complete. VPC needs the QUIC tunnel transport (the website's working HTTP/2 tunnel doesn't prove VPC); VPC idle timers UNKNOWN; DO has a dashboard SQL editor; D1 has batch-level transactions; Drizzle runs on all three but with different execution contracts.
- `r4-approvals-identity-mac-tools.md`: complete. The managed ledger records the configured `approverId` and the agent principal, not the human who tapped. Telegram prompts accept any authorized participant. Three approval contracts coexist (managed ledger, standalone batch HMAC, MCP Portal proxy HMAC). The credentialed "ephemeral" VM is reused. Hosting the portal in a Worker does not by itself expose Mac CLI or Things authority.

- `s1-approval-target-state.md`: complete (Sol Sidekick proposal; 333 lines). Distinguishes agent, represented person, resource delegation, provider consent, standing policy and exact-call approval, with **conjunctive** gates. Cloud-manageable config does not force cloud-owned Google grants: it recommends keeping Mac custody and policy authority behind a protected management API at first. DO SQLite is the initial candidate. **Section 8 lists ten owner decisions (D1–D10)** and section 9 lists seven phases, with the irreversible boundaries marked.

**All research has landed. Every agent has stopped.**

| Report | Agent | Purpose |
| --- | --- | --- |
| `r1-cloudflare-mcp-identity.md` | 🛠️ Worker, Sol high, session `01a14131-2679-7562-ab1b-24c5e0a45f68` | What Cloudflare's MCP portal sends upstream (identity, bearer, per-user OAuth, Access JWT); per-agent multi-registration; `_meta` and streaming pass-through; catalog sync; client Managed OAuth support |
| `r2-cloudflare-runtime-storage.md` | 🛠️ Worker, Sol high, session `01a14131-5652-7653-8d07-9881b70fbd9a` | Workers VPC → Tunnel → Mac loopback; sharing one cloudflared; Worker limits for long MCP calls; DO SQLite versus D1; Drizzle on all three; atomic approval consumption |
| `r3-oauth-broker-domain.md` | 🛠️ Worker, Sol high, session `01a14131-59aa-7dc0-b201-3bea8a1f7aa3` | Broker domain map, how a Google call resolves, credential custody, what breaks if policy moves to the cloud while credentials stay on the Mac |
| `r4-approvals-identity-mac-tools.md` | 🛠️ Worker, Sol high, session `01a14131-5ce7-7b93-b9da-ca361344092a` | Today's approval flow end to end, who counts as approver, agent identity per path, Mac-side tool inventory, where the reviewed design doesn't model on-behalf-of approvals |
| `s1-approval-target-state.md` | 🐒 Sidekick, Sol xhigh, session `01a14131-603a-7f91-ab93-132d645ba450` | Owner-requested proposal for the target approval and control state: nouns, identities, states, lanes, config-as-data, ownership, mapping to code, owner decisions, phases |
| `advisor-connection-mechanisms.md` | 🦉 Advisor, session `01a13a63-0fbf-7f31-9e98-f0fec712b1c1` | Owner question (8): mechanism per hop (VPC, Access, bearer), identity, limits, sleep behaviour, recommendation. If the Advisor cannot write files, it returns by Router and the Lead saves it here. |

Reports are evidence to verify, not decisions. The Lead reads decisive
anchors before relaying any claim to the owner.

## When resuming

The Sol proposal's ten decisions (s1 §8) supersede the shorter list in step 2
below as the agenda:
- D1 what "on behalf of a user" means
- D2 who controls an agent
- D3 shared accounts
- D4 owner override
- D5 revocation versus in-flight work
- D6 how agents edit config
- D7 where Google policy truth lives
- D8 Mac service versus full portal
- D9 which database
- D10 per-agent identity through Cloudflare

D1–D3 settle the domain first; D7 is the biggest storage decision. The Lead
verifies the decisive anchors, then brings them one at a time, then plans the
user experience (owner request 9). Old step list:

1. Read the reports above. Spot-check their decisive anchors.
2. Bring the owner **one** decision at a time, in this order: how the Mac connects (A/B/C, with the per-hop mechanism); the approval model (lanes, on-behalf-of, agents proposing); caller identity; where policy truth lives (cloud versus Mac broker); the controller door.
3. The Lead then plans the user experience (owner request 9): approval page, policy editing, agent proposals, notifications.
4. Then run a full design round (requirements → specification → program design → independent review), building on the Gondolin 0.13 PR: [#236](https://github.com/ShravanSunder/agent-vm/pull/236), branch `chore/gondolin-013-design` at `5901feee` (pushed 2026-10-15, unmerged, CI pending at last report). Its Lead reports zero changes to Tool Portal, MCP Portal, config-contracts or the approval ledger.

Board: `no-home` (no collaboration project exists for agent-vm).
