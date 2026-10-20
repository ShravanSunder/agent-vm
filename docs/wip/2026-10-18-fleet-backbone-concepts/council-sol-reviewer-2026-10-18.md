# Council: independent Sol reviewer (2026-10-18)

Reviewer: 🔎 Reviewer Sidekick · fleet concepts adversarial, codex-local/01a14f7f-d586-7593-a440-b00ac55fb0f5 (gpt-6.1-sol, xhigh), with no authoring history. Read-only. It reviewed concepts.md (hash prefix `2daec71c57b9`, including the compute-isolation addition) and decisions-and-open-questions.md. The handback is preserved below as returned, lightly condensed. The Advisor re-opened two anchors: program-design.md:328 (separate credentials do not compartmentalize history) and the Router wake `SavedMessage` shape (target, content, delivery, generation guard; no authenticated human delegation).

**Headline:** private compute does not create independent authority. A shared administrator and backbone can still control the identities trusted by every person's resources.

| # | Severity | Finding | Suggested change |
|---|---|---|---|
| 1 | Blocking | F2's privacy promise exceeds its trust boundary. A malicious admin can change a persona or launcher; a compromised backbone can impersonate an authorized agent or human. VM isolation and encryption at rest don't protect plaintext on admin-controlled infrastructure. | State that the admin/backbone is trusted for every member's confidentiality and authority, or keep independently controlled personal authorities. |
| 2 | Blocking | "Requester" has no authenticated origin for background work. Alice starts a bot, Bob posts to its board, a schedule wakes it: who is the requester? The wake shape carries no authenticated human delegation. | Bind each job to independently authenticated subject authority. Automation keeps explicit delegation or uses workspace-only authority. |
| 3 | Blocking | Separate credentials and VMs don't isolate shared agent history. Bob's run of logical agent X can retrieve Alice's result. | Requester isolation must include logical agent/assignment identity, operation lookup, artifacts, conversation summaries and remote caches, not only compute placement. |
| 4 | Major | Private reads can become authorized shared writes: a prompt-injected email tells the bot to publish to workspace memory, and both resource checks pass. | Define when private-derived content may enter shared stores. Default private; publishing needs explicit authorization. |
| 5 | Blocking | Approval routing contradicts resource ownership: §5.5 routes to whoever the agent acts for, but shared-data deletion needs workspace approvers. | Derive eligible approvers from the exact target's approval policy. The requester supplies context. Bind the policy to the operation and to every target in a batch. |
| 6 | Major | "Treat arguments as untrusted" doesn't contain the auto judge. An injected email makes the judge confidently approve. | Deterministic limits outside the judge (eligible tools, recipients, accounts, effect bounds). Critical classification is outside model control. The judge acts only inside those limits. |
| 7 | Major | Automatic enrollment needs an authorization owner. A compromised launcher could request another person's persona or mass-enroll. | Name the enrollment authorization owner. Bind issuance to launcher, boundary, persona revision, limits and current delegation. Persona widening never silently widens consent. |
| 8 | Major | Revocation lacks an observation deadline (credentials, delegations, queued signed answers). | Specify freshness at discovery, lookup, renewal and first dispatch, plus handling of queued answers. Keep this separate from writer leases. |
| 9 | Major | Duplicate registration doesn't fence cloned writers: a snapshot with credentials and a valid lease resumes offline in two places. | Remove the claim. Define restore/incarnation handling, writer fencing, and quarantine when identity is ambiguous. |
| 10 | Major | Infrastructure authentication can't identify a hosted bot's human requester: one Dot/Muse connector serves several humans. | Require verified end-to-end agent and subject binding. Until proven per platform, external registrations get fixed-person or workspace-only authority. |
| 11 | Major | Direct approval delivery doesn't close external operation identity. | Protected effects are unavailable to a harness until it has a proven correlation/continuation contract. |
| 12 | Minor | The comparison overbuilds F1. | Compare the smallest topology for the concrete journeys. Defer general federation and person-to-person approval delegation. |

The reviewer confirmed the doc correctly forbids treating hand-back, timeout or delivery as a grant. D3 settlement and consumption remain the acknowledged gap.

## Alternatives

| Model | Gain | Cost / who pays |
|---|---|---|
| F1: personal authorities with explicit sharing edges | Compromise and exit stay bounded to one person, if credentials and execution are independently controlled. | Operators maintain separate authorities and chosen sharing links; users sometimes approve cross-person work. General federation need not come first. |
| F2: shared infrastructure, fixed-person execution instances | Shared backbone, common persona templates, separate per-person agent identities, workspace-only bots. Removes requester switching from long-running sessions. | More instances and explicit routing. Admin trust remains; this does not solve malicious-admin exposure. |

"F2 is credible if members accept that administrator trust. F1 is stronger when private ownership must survive administrator or backbone compromise."

**Not verified:** Cloudflare runtime behavior, Dot/Muse authentication and correlation, deployed enrollment/revocation, external minters.
