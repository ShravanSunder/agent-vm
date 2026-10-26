# Organization model: back to basics (pathfinding handoff, 2026-10-26)

The owner stopped the page work: "you completely forgot about the rooms, how that works, how the organization structure works ... full of inconsistencies. Let's go back to the basics." The next session restarts with `discuss-pathfinding` to rebuild the shared model **before** any page, diagram or design edit.

## Destination

- **What to extract:** the owner's model of the basics: organizations, workspaces, rooms (isolation), Fleet machines, and how they relate. It is a shared mental model and decisions, not a page.
- **Depth:** standard. Every judgment that shapes the identity design's revision.
- **Out of scope until the model is agreed:**
  - new HTML pages or diagrams;
  - edits to the identity, sign-in, remediation or orchestration designs;
  - storage topology design (that is program-design's job afterwards).
- **Returns to:** spec-design for the identity design (Requirements and Specification), then program-design for storage.

## Settled in chat today (owner's words, treat as decided)

1. Fleet central is shared by several organizations; "organization registry -> each organization has its own fleet -> workspaces".
2. A machine knows only the workspaces it is allowed in, or can communicate with.
3. "a single router only belongs to one organization; we can enforce login; a router needs to be logged in".
4. Communication is only within an organization, between workspaces. A communication allowance shows only the other workspace's ID and name.
5. "i dont want cross organization any sharing stuff or comm".
6. "person can belong to any orgs but not agents".

Also today, the five stale codex-router PRs (#131, #133, #135, #153, #154) were closed and their branches deleted at the owner's direction.

## Page answers and comments (review export 23c239a3, page revision 2026-10-26.1)

The owner selected these on the Organization hierarchy page, then said the page "make no sense". Re-confirm both in the restart; don't build on them silently.

- **placement-choice:** "The host or VM too: one organization per host or VM we run". The owner's comment on that option: "how is this proven? how can we prove this? i dont understand, explain how this works".
- **portal-deployment-choice:** "No: one Tool Portal deployment per organization" (with "very sloppy you did").
- **organization-store-choice:** not answered. Comment: "unclean, not good diagrams, entity relations not clear".

## What the Lead got wrong (so it isn't repeated)

- **Invented nouns** where agreed ones exist: "Router" as an entity, "agent session", "person admission", "Router allowance". The agreed nouns are E6 Fleet machine, E7 Fleet harness session, E15 Machine allowance, and people sign-in E8 Allowlist entry.
- **Called a machine "a computer"** and argued about hardware uniqueness, against F-34 ("no identity or boundary may be derived from hardware").
- **Ignored rooms (isolation) and the boundary vocabulary:** D-15, F-34, Q-B13 "owner scope" versus "isolation unit".
- **Built diagrams without hierarchy, or mixed containment with cross-references** until unreadable. Demistify erDiagram attribute columns also overlap.
- **Claimed the old `workspace_create` path stays open.** The identity design already refuses it (R28, Program Design 335/536).
- **Presented an inference as a conclusion:** "a host or VM we run serves one organization".

## Every mistake, in order

1. **Wrong owner for "workspace belongs to organization".** I first framed it as "a column on Fleet's table or the organization authority" without having read how workspaces are created and seen.
2. **"Router" as an entity.** I renamed Machine to Router on the page, inventing a new entity where E6 Fleet machine already exists.
3. **"A machine is a computer."** I told you a machine is "your laptop, a VM or a server", which contradicts F-34.
4. **A "level 3: physical computer" enforcement layer.** I proposed one and talked about hardware attestation. Nothing is derived from hardware.
5. **"A second Router on the same laptop logging in to O2 is allowed".** I said this; it doesn't follow from anything, and it conflicts with the boundary rules.
6. **Three invented nouns:** "agent session" instead of Fleet harness session; "person admission" with `is_owner` instead of the existing allowlist entry and owner; "Router allowance" instead of Machine allowance.
7. **"The Router's workspace_create stays open"** in the identity design. False: R28 and Program Design 335/536 already refuse it.
8. **"Enrollment opens a browser"** stated as today's flow. Today it uses the operator's token.
9. **erDiagrams with fields** that rendered as overlapping text; then flat boxes with no hierarchy.
10. **One picture mixing containment and five cross-references**, which turned into a tangle with labels hidden and arrows ending nowhere.
11. **An inference presented as a conclusion:** "a host or VM we run therefore serves one organization".
12. **The token path drawn wrong:** issuer straight to the machine, skipping Fleet central.
13. **A shared-Portal option that hid the RD7 shared-isolate risk.**
14. **Rooms forgotten entirely** in the first pages. When I did add them, I treated a room only as E13 (a per-session record), without checking what you mean by a room.
15. **Pages before a shared model.** I kept producing pages and diagrams instead of rebuilding the shared model with you first.

## What I don't understand

1. **What a "room" is in your model.**
   - Is it the isolation unit (one host or VM, F-34)?
   - The per-session isolation record (E13, aliased "room")?
   - An AgentStudio Host (E23, one per isolation unit)?
   - Or something at workspace level?
   - And who creates rooms, and what belongs to one?
2. **How rooms, workspaces and Fleet machines relate.** F-39 says "workspaces map to machines or VMs" and Q-B11 says "machines map to one workspace". But in the identity design you turned down one machine per workspace ("your machines serve several workspaces at once", U6). I don't know which holds now, or whether both are true at different levels (room versus Fleet machine).
3. **"Owner scope".** Q-B13 proposes it as "a person or a workspace". Is it now the organization, or still a person or workspace, with the organization above it?
4. **How a room or host restriction could be proven at all.** The identity design chose "the connection a machine already has" over keys or attestation (alternatives #7), and rooms are asserted, not proven (R23). I don't know what level of proof you expect: enforced, or declared and shown.
5. **How AgentStudio daemon Hosts and Gateways (E23, E24) relate to Fleet machines (E6).** Q-E9, "register a machine once with the Host as a service under it", is the Daemon Advisor's advice and still open.
6. **Where bots fit.** Bots on VMs we don't control (F-11) and bots registered in an organization: which room or organization do their VMs belong to?
7. **Personal machines** (owner scope "a person") versus workspace machines: how they fit once a person can be in several organizations.
8. **What lives at organization level versus workspace level** in your own words: tools, rooms, machines, bots, people.
9. **Whether your two page answers still stand,** since you said the page made no sense: one organization per host or VM; one Tool Portal deployment per organization.

## Recovered while writing this (the room model I lost)

From the Lead's trace (`~/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-18-tool-portal-identity-advisor-claude-2febb449.md`):
- **The 10-22 workspace design** (the Fleet Lead's, at `codex-router.collab-improvements/tmp/design-workflows/2026-10-22-workspace-boundary/what-is-a-workspace.html`): **workspace = members + resources**; an environment isolates; tiers **Open / Fenced / Walled**; tokens scoped to **(workspace, environment)**. The Advisor validated and pressure-tested it (the `2026-10-22-workspace-design-validation` ledger).
- **The owner on the name** (relayed by the Fleet Lead): "ok room good". **Room** replaces "environment": **open room = a whole machine; walled-off corner = a read-fenced sandbox; locked room = a VM**.
- **Also from the owner:** "environment is a generic name too. how can we setup attribution or login for an agent? and scope identity in a fence?"; "im gonna change zone ideas dont confuse tool portal concepts" (no mapping onto agent-vm zones).

The Advisor is researching the full room and organization model from these, the code and the Fleet framework (commission 3, result `tmp/practices-research/2026-10-26-storage-model-advisor/rooms-and-organizations.md`).

## Read first, before asking anything (established abstractions)

All paths are under `docs/specs/` in this worktree.

- **Fleet framework** (`2026-10-18-fleet-framework/`):
  - F-11 (bots on VMs we don't control);
  - F-34 / D-15 (machines we run serve exactly one boundary; each host or VM is its own boundary; nothing from hardware);
  - F-38, F-39 (workspaces map to machines or VMs);
  - Q-B10, Q-B11 (moving a machine needs a wipe or handover?), Q-B12, Q-B13 ("boundary" = owner scope versus isolation unit);
  - Hosts and Gateways, the AgentStudio daemon, the who-owns-what page.
- **Identity** (`2026-10-24-agent-identity/`):
  - Specification entity table E1–E18, especially E6, E7, E13 Isolation record ("room"), E14 Shared bucket, E15;
  - R7, R23, R28;
  - Alternatives row B ("by machine", turned down: "your machines serve several workspaces at once") and #13 (shared bucket shown, not enforced);
  - Requirements U6.
- **People sign-in** (`2026-10-20-people-sign-in/2026-10-20-people-sign-in.md`): E1 Deployment, E2 Person, E8 Allowlist entry, E12 Organization, R19.
- **The Advisor's independent model check and review:** `tmp/practices-research/2026-10-26-storage-model-advisor/report.md` and `review.md`.
- **codex-router facts** are pinned at `f465808f`, readable with `git show` in `~/code/projects/codex-router`. The integration checkout is gone.

## Open questions for the owner (judgment only, take in order of leverage)

1. **Rooms:** what a room is in the owner's model, and how rooms relate to organizations, workspaces and Fleet machines. Today's designs: a room is E13, asserted at session launch, never proven; F-34 says each host or VM is a boundary.
2. **Organization structure basics:** what lives at organization level versus workspace level, and the owner's own words for each level.
3. **Proof:** "how is this proven?" For "one organization per host or VM we run", what proof does the owner expect? The current design records rooms but cannot attest them.
4. Re-confirm one Tool Portal deployment per organization.
5. One organization database, or two objects (only after 1–3).

## Lead's current read, to state at the restart (low-to-medium confidence)

The owner thinks in rooms (isolation units: a host or a VM) as the physical boundary that an organization's work runs inside. Each room serves one owner scope. "One Router, one organization" plus "one organization per host or VM" means a room belongs to exactly one organization, and workspaces of that organization run in it. The Lead does not yet know whether the owner wants rooms to be **enforced and proven** (which needs a way to attest where a Fleet machine runs) or **declared and shown**. That is the first thing to ask.
