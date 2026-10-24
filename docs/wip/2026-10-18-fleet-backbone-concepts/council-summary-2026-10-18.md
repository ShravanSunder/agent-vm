# Council summary: fleet, persons, execution (2026-10-18)

Inputs:

- daemon Advisor: concepts thread 8278 (council) and 8284 (validation baseline);
- Router/board Advisor: 8281 (council) and 8283 (installation/lease addendum);
- independent Sol reviewer: [council-sol-reviewer-2026-10-18.md](council-sol-reviewer-2026-10-18.md).

Synthesis by the tool-portal Advisor. Owner decisions are still needed where marked.

> **Superseded in part by D-17** (owner: no cross-person use of agents; no runtime requester switching). Point 2 and the household team-bot proof case are historical, not recommendations. Point 3 is narrowed to its D-17 minimum: preserve the fixed execution-owner binding through wake, schedule, restart and retry, then check current permissions and output audience. Points 5–6 are narrowed per Router/board Advisor post 8286, below. (Router/board Advisor 8289; Lead 8292.)

## Where all three agree

1. **F2 is credible only with explicitly trusted infrastructure.** A shared admin and backbone can forge identities, change personas or launchers, and process plaintext. VM isolation and encryption at rest do not change that. If a member's privacy must survive admin or backbone compromise, F1 (personal authorities with explicit sharing edges) is the stronger model, and its federation need not start general: it can begin as a few chosen sharing links. **Owner decision.**
2. *(Superseded by D-17; historical.)* **Replace the runtime "requester" mode with acts-for bound per instance or invocation.** A team persona is a template:
   - each person who uses it gets their **own instance**, launched in their own environment with acts-for fixed at launch;
   - shared contexts (a channel, a board) get a **workspace-only instance** with only workspace credentials and state;
   - a "front door" may route a request to the right person's instance, but never switches one live worker between people.

   This keeps Grok's user experience: shared setup and workspace memory, with every conversation private.
3. **Every work item carries its authority binding: beneficiary, delegation and output audience.** That binding persists through wakes, schedules, forwards, retries and notification handoffs.
   - A schedule inherits the binding admitted when it was created.
   - A board post's author is not proof of a person; a post or mention is not a grant over the author's accounts.
   - Agent-to-agent work needs an explicit narrowed delegation chain, or else runs as workspace-only.
   - Work items for different persons are never coalesced.
   - Router's current `SavedMessage`/`WakeSendRequest`/schedule contracts carry no such binding.
4. **Private-derived content defaults to private.** Moving it into a shared board, memory, file or message needs explicit authorization. Correct credentials and correct approval routing don't prove a result's audience.
5. **Execution identity belongs to one boundary.** Each Host (and Router installation) runs as one OS account per person or workspace boundary. Ambient credentials (git/gh credential helpers, ssh agent, cloud CLIs, provider logins) belong to exactly that boundary. A "stateless shared unit fetching each person's data" is valid only for request-scoped bots whose every credential is fetched per call through the broker or portal, never for terminal or long-lived harness agents.
6. **Nothing crosses at rest from a shared-bot environment into a person's environment.** Only three things do:
   - the persona definition, via the registry;
   - workspace memory, read as a resource through Tool Portal;
   - board or channel messages, via mail, as untrusted data.

   There is no Host-to-Host path (daemon R15, fleet-sync-consumer-fit:38).

   *Narrowed (8286):* "nothing at rest" means no copying of ambient execution or credential state, or of a workspace Host's filesystem, into a personal Host. Authorized mail is durable at the recipient (Router PD4:125–137 persists bodies, notifications and inbox rows), so authorized shared content may cross and be kept, retaining its source scope and permitted audience. Boundary equality in point 5 applies to the daemon's owning Host database, not as a universal rule that a recipient's personal unit must own the source workspace.

## Corrections to the WIP model

| # | Correction | Source |
|---|---|---|
| C-a | Eligible approvers derive from the **target resource's approval policy**; the requester supplies context. Bind the policy to the operation and to every target in a batch. Fixes §5.5. | Sol 5 |
| C-b | The auto judge acts only inside **deterministic limits** set outside the model: eligible tools, recipients, accounts, effect bounds. Critical classification is outside model control. | Sol 6 |
| C-c | **Enrollment authorization owner** named. Issuance is bound to launcher, boundary, persona revision, limits and current delegation; widening a persona never silently widens consent. The AgentStudio **Host is a launcher** (records persona, instance and acts-for on E10). | Sol 7, daemon d3 |
| C-d | A typed, enforced relation **installation/isolation unit → boundary (person or workspace)**. Replica placement, writer registration, copy reads and move/takeover destinations are authorized against the data's boundary. Leases stay per database, held by a PeerId, and the backbone checks holder boundary = store boundary. | Router addendum, daemon 4 |
| C-e | Remove "duplicate-claim refusal covers clones". Cloned images must not clone a usable enrollment. The Host singleton lock is local only. Restore/incarnation handling, writer fencing and quarantine need their own contract. | Sol 9, Router addendum |
| C-f | Revocation freshness at discovery, lookup, renewal and first dispatch, plus cached reads and queued disclosures. This is separate from writer leases. | Sol 8, Router d5 |
| C-g | External agents get **fixed-person or workspace-only authority** until end-to-end agent and subject binding is proven per platform. Protected effects are unavailable to a harness until it has a proven call-correlation contract. | Sol 10–11 |
| C-h | Fleet, workspace and person are **kinds of ownership scope, not a containment ladder**: a person belongs to several workspaces, and their private accounts never become workspace-owned. Router workspaces are an organizational home, **not yet a confidentiality boundary**. Membership, privacy and delegation must be designed. | Router a |
| C-i | **Naming:** "workspace" collides with daemon E25 "Shared workspace composition". Either rename daemon E25 (arrangement/layout) or choose another fleet-level word. **Owner decision.** | daemon d6 |
| C-j | Compare F1 by its **smallest topology** for the concrete journeys. Defer general federation and person-to-person approval delegation until an outcome needs them. | Sol 12 |

## What F2 forces each product to add (not written anywhere yet)

- **AgentStudio daemon:**
  - a person dimension on shared state (E25/E26 layout and read marks per person);
  - a person audience on replication (filtered export or per-person export units; R15);
  - Gateway attach per person (other boundaries only by explicit grant);
  - per-person routing of asks, notifications and push;
  - the Host as launcher;
  - a boundary attribute on E23;
  - lease gating as a data-placement question: offline-needed local state (session registry, worktree topology) belongs outside the leased database, so a laptop on a plane can still open terminals after the lease pauses (G13).
- **agent-collaboration:**
  - membership and grant lifecycle;
  - the verified principal → allowed actor/session binding;
  - read **and** write enforcement across directory, search, ID reads, aggregates, hooks, watches, inboxes, excerpts and read copies, including names, counts, errors and cursors;
  - placement rules for replicas, automation stores, transcripts and artifacts;
  - persisted per-invocation binding through wakes and schedules;
  - authenticated approval answering (today `interaction_history_store.rs:548-565` compares a supplied identity).
- **agent-vm** (resources and credentialed runtimes): broker partitioning by person and workspace; credentialed runtimes that keep shared secrets out of environments; eligible approvers from resource policy; deterministic auto-approval limits.

## Proof cases named by the council (for future owning lanes)

- A-private and B-shared work running simultaneously.
- A wake or restart preserving A's binding without replaying unknown effects.
- Membership revoked while an excerpt is queued.
- Direct-ID, aggregate, cursor and cache probes from a non-member.
- Denied cross-boundary replica placement.
- *(Superseded by D-17; historical.)* The household team-bot scenario: a terminal agent in requester mode pushing with the owner's ambient credentials.
