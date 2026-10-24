# Build obligations per product

What each product must build to realize [concepts.md](concepts.md), plus the cross-product proof cases a future build must pass. This is input for each product's 🦁 Lead, not a plan or a schedule.

Marks:
- ✅ rests on an owner decision;
- 🟡 proposed;
- ❓ waits on a call or a T-n question in [decisions-and-open-questions.md](decisions-and-open-questions.md).

**Adoption is separate from status.** A ✅ means the obligation rests on an owner decision, not that a product Lead has adopted it. Only the agent-vm Lead has adopted items: V-4 (P16) and V-9 (P12, P14, P15) are in its four spec documents. **None of the backbone (B-), Router (R-) or AgentStudio daemon (A-) rows are adopted by their Leads**; the daemon Lead holds T2, D-5 and personas as unverified second-hand context (daemon Advisor 8353).

## 1. agent-collaboration: the fleet backbone (central)

| # | Obligation | Status | Source |
|---|---|---|---|
| B-1 | **Identity registry.** Records persons, devices, machines/installations, services, personas, agents and external agents, with enrollment, credential bindings and status. Holds no permissions. | ✅ D-1, D-6, D-7 · 🟡 | concepts §3, §6.2 |
| B-2 | **Machine enrollment** via an enrollment sign-in. Keeps the current one-core custody (caller-generated credential, central stores a hash, returns a PeerId) unless a change is proposed; assigns each unit to one boundary. | ✅ D-8, D-15 · ❓ T-10 | concepts §6.3 |
| B-3 | **Launcher authorization and agent credentials.** A launcher proves itself and enrolls agents under a persona, within its launch rule. Short-lived agent credentials are issued, renewed and revoked. Consent never widens silently when a persona changes. | ✅ D-6 · ❓ T-5, T-1, T-2 | concepts §6.3; council C-c |
| B-4 | **Persons and workspaces.** A personal workspace per person; shared workspaces with members; membership and grant lifecycle; a person can leave with an export of their data (🟡 proposal, no owner line). | 🟡 call D · ❓ call A | concepts §5.1–§5.2 |
| B-5 | **Interaction inbox.** Records and projects the five kinds. Shows "settled" only on the settlement owner's receipt. Push is a redacted wake. Offline projection contract. | ✅ D-8 · 🟡 · ❓ T-12 | concepts §8.1, §8.5 |
| B-6 | **Authenticated human answers.** Replace today's **trust in a supplied identity** with a verified principal mapped to its allowed actor, then **keep** the existing approver-authorization checks: `record.approver()` equals the mapped actor, pending/current binding, offered choice and the other family checks (`interaction_history_store.rs:548-585`). An authenticated person who is not this request's approver still fails (WrongActor). Device keys and Access sessions; optional fresh gesture for critical approvals. | 🟡 · ❓ T-9 | concepts §8.3 |
| B-7 | **Revocation** of devices, agents, personas, machines, with freshness at each checkpoint. | 🟡 · ❓ T-6 | concepts §6.5 |
| B-8 | **Clone fencing**: a copied image must not act as the original. | ❓ T-7 | council C-e |
| B-9 | **Leases and mail** as designed (FL-9 pause), plus a check that the holder's boundary matches the store's for the daemon's owning Host database. | ✅ D-5 · 🟡 | concepts §9; council C-d |

## 2. agent-collaboration: Router installation

| # | Obligation | Status | Source |
|---|---|---|---|
| R-1 | **Verified principal → allowed actor/session binding**, then **both** the collaboration access policy **and** the existing subject/domain gates (E11 roles, RL-1…RL-8, WS-1). A SessionRef stays an actor identity (Router E10, RC-8). Being the authenticated instance does not make it a lead. | 🟡 | concepts §6.1 |
| R-2 | **Collaboration permission profiles per persona:** workspaces, boards, messaging, and **requestable actions** (separate from messaging). Enforced on reads and writes: directory, search, ID reads, aggregates, hooks, watches, inboxes, excerpts, read copies, counts, errors, cursors. | 🟡 · ❓ call F | concepts §7.5; council |
| R-3 | **Fixed authority binding persisted through wakes, schedules, restarts and retries.** Current permissions and output audience are re-checked; the timer is a trigger, not a new requester. | 🟡 | council point 3 (narrowed) |
| R-4 | **Private-to-shared publication check.** Content derived from private data needs explicit authorization before it reaches a shared board or memory. | 🟡 | council point 4 |
| R-5 | **Router host as launcher** for headless harnesses, under B-3. | 🟡 · ❓ call E | concepts §5.4 |
| R-6 | **Placement rules** for replicas, automation stores, transcripts and artifacts, by boundary. | 🟡 | council C-d |
| R-7 | **Preserve the existing E11 role contract** during principal integration: role assignments stay on concrete actors and confer domain authority; a persona, profile or share never appoints a role or merges role histories. | existing Router contract | concepts §7.1; 8299, 8347 |

## 3. AgentStudio daemon (fleet proposal; not adopted by the daemon Lead)

| # | Obligation | Status | Source |
|---|---|---|---|
| A-1 | **Host as launcher.** The E10 binding carries persona, agent instance and a fixed acts-for (person or workspace). | ✅ D-6 (launcher enrollment) · 🟡 call D (fixed acts-for) | daemon Advisor 8304 |
| A-2 | **One Host per boundary.** A boundary attribute on E23; workspace personas launch only on workspace Hosts. | ✅ D-15 · 🟡 | concepts §5.4 |
| A-3 | **iPhone and Mac apps carry two principals:** owner device (answers approvals) and Gateway (pairs with Hosts). Neither credential does the other's job. | ✅ D-4 · 🟡 | concepts §6.1 |
| A-4 | **Inbox clients** for the five kinds: device enrollment, signed answers, browser for resource sign-in, optional fresh gesture. **New daemon product scope**: the daemon Requirements have no fleet-interaction inbox and no approval or sign-in surfaces. | ❓ call M (owner or daemon Lead must adopt) | concepts §8.5; 8353 |
| A-5 | **Person dimension** (under F2): layout and read marks per person; a person audience on replication (R15); Gateway attach per person; per-person routing of asks, notifications and push. | 🟡 · ❓ call A | council deltas |
| A-6 | **Lease gating as data placement.** Offline-needed local state lives outside the leased database (G13). | 🟡 daemon Advisor recommendation (8279) · ❓ G13 / T-13 (D-5 sets only cadence and maximum) | concepts §9 |
| A-7 | **E11 notices and asks are a may-message channel**, never a request-action grant. | 🟡 | 8304 |
| A-8 | **Rename E25** if call B agrees. Not "layout": inside the daemon "layout" already means split geometry within an arrangement (`arrangement_layout_pane`, `arrangement_layout_divider`). Use E25's own noun, "composition" ("Shared workspace composition"), or "arrangement set" (daemon Advisor 8353). | ❓ call B | concepts §5.2 |

## 4. agent-vm

| # | Obligation | Status | Source |
|---|---|---|---|
| V-1 | **Verify backbone agent credentials at the gateway.** Map the Access assertion to its enrollment; ignore names in tool calls. | 🟡 · ❓ T-1, T-2 (D2) | concepts §6.4; agent-vm PD |
| V-2 | **Persona-level tool profiles**, with the consent rules: a grant to agent A never carries to agent B through a shared persona; a persona-wide grant needs explicit consent; the instance stays caller and history owner. | 🟡 call D, H | concepts §5.3; agent-vm Spec C3/C8, VD U13/J8 |
| V-3 | **Approvers from the resource owner's policy**; the approval flow with stable operation IDs; the decision delivered to the resource; single use. | ✅ D-3, D-9 · 🟡 · ❓ T-3 (D3) | concepts §8.2–§8.3 |
| V-4 | **Routed operations:** inner key `(computer, caller, K)`; target recorded before forwarding; recovery without dispatch. | 🟡 (P16, accepted) | concepts §8.4 |
| V-5 | **Approval composition:** floor; one challenge; unresolved compositions rejected. | ❓ call I (D3) | concepts §8.4 |
| V-6 | **Credential broker partitioned by owner** (person or shared workspace); **shares** with ceilings; the credential never leaves the owner's broker. | 🟡 · ❓ call G | concepts §5.3, §5.5 |
| V-7 | **Auto judge** inside deterministic limits; critical tools always go to a human. | ✅ D-9 · 🟡 · ❓ T-16 | concepts §7.4 |
| V-8 | **External agents:** no approval-gated tools until per-call correlation is proven; "talk only" means no portal credential. | ✅ D-11 · 🟡 · ❓ T-8 | concepts §7.6 |
| V-9 | **Hard cutover of legacy standalone approvals** (P12) and **one shared `@agent-vm/tool-access` package** with one contract artifact (P14, P15). | 🟡 (Lead accepted) | agent-vm PD |
| V-10 | **Approval UI moves to the inbox clients**; agent-vm's current web pages stay scratch. | ✅ D-12 | concepts §8.5 |

## 5. Cross-product proof cases

These are for future verification; none has been run. Each one fails a build that gets the rule wrong.

| # | Case | Must observe | Products |
|---|---|---|---|
| X-1 | A-private and household work run at the same time | neither sees the other's data; no shared execution state | all |
| X-2 | A wake or restart of an agent's scheduled work | the same fixed acts-for; no replay of an unknown effect | Router, agent-vm |
| X-3 | Membership revoked while an excerpt is queued | the excerpt isn't delivered | Router |
| X-4 | Direct-ID, aggregate, cursor and cache probes from a non-member | nothing disclosed, including counts and errors | Router |
| X-5 | A replica placed on another boundary's unit: (a) a private, out-of-audience export; (b) an explicitly permitted shared export; (c) a daemon-owned Host database on a unit of a different boundary | (a) refused; (b) allowed without moving ownership or writer authority, and only if the whole export's audience is allowed; (c) refused (holder boundary must equal the owning Host database's boundary) | backbone, daemon |
| X-6 | A persona created after a named share | no access | agent-vm |
| X-7 | A workspace-managed share and a new persona | only the delegated ceiling | agent-vm |
| X-8 | A persona widened or rebound after a grant | old consent unchanged | agent-vm, backbone |
| X-9 | A shared-resource reader tries to take a board role | refused | Router |
| X-10 | Data read before revocation | not reported as recalled | agent-vm |
| X-11 | Agent B enrolled with the same profile as A | can't use A-only consent or read A's operations | agent-vm |
| X-12 | The Mac's reply is lost after create/effect, before the gateway saves the reference | the same inner operation; one effect; a late reply can't regress the result | agent-vm |
| X-13 | Cloud "requires approval" plus Mac "requires approval" | one challenge (under call I's floor) | agent-vm |
| X-14 | A managed-family decision at the public approval boundary | rejected | agent-vm |
| X-15 | A presenter claims the owner approved; an answer from a revoked device | both refused | backbone, agent-vm |
| X-16 | An agent that may only message asks another to send outside | refused (no request grant; audience not allowed) | Router, agent-vm |
| X-17 | A copied enrolled VM | can't act as the original | backbone (after T-7) |
| X-18 | A Host offline beyond its lease | lease-gated writes pause; resume on same-epoch renewal | backbone, daemon |
| X-19 | Same persona and profile, but no E11 role, attempts a role-gated operation (e.g. create a workstream) | refused (roleRequired) | Router |

## 6. agent-vm spec findings (Advisor P1–P17)

Posted on the agent-vm work thread `01a14e9e…ec101`; the dispositions are the agent-vm Lead's.

| # | Finding | Disposition |
|---|---|---|
| P1 | Cloudflare managed MCP Portal uses one admin credential upstream for service-token sessions, so per-agent identity is lost | accepted: ingress options in PD |
| P2 | Operation identity mixed with changing admission fields | accepted: stable lookup key separated from the admission fingerprint |
| P3 | Missing revocation rows (agent, deployment credential, machine key, service credential, assignment) | accepted |
| P4 | The identity authority had no deployed owner | accepted: external configured authority, sole record writer |
| P5–P6 | Router identity and approval integration | accepted as integration constraints; no issuer chosen |
| P7 | Collision-resistant item IDs; caller-scoped history | incorporated |
| P8 | Human-approver authentication at the authority | accepted |
| P9 | Approval consumption bound to the requesting issuance | accepted |
| P10 | An agent-readable credential is the baseline threat for cloud runtimes | accepted, narrowed |
| P11 | Language-neutral contract home | closed |
| P12 | Legacy HMAC approval cutover | closed at design level (hard cutover) |
| P13 | Standards and cost in Requirements | closed (U15) |
| P14 | Packages without an independent consumer | closed: one shared `@agent-vm/tool-access` (U12) |
| P15 | Two language-neutral contract homes | closed: one generator, one artifact |
| P16 | Inner operation key and the lost-reply window | closed |
| P17 | Approval composition for routed calls | open: call I / D3 |
