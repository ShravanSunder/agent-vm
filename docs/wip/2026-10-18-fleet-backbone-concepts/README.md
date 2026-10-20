# Fleet backbone: design reference set (WIP)

The cross-product design for a future build of the fleet backbone shared by **agent-collaboration** (formerly codex-router), the **AgentStudio daemon** and **agent-vm**. It covers identity, persons and workspaces, personas and agents, access, approvals and other human interactions, leases, and compute boundaries.

It was worked out with the owner on 2026-10-18 by the 🦉 tool-portal Advisor, and checked by the Router/board and AgentStudio daemon Advisors and an independent Sol reviewer. It is **not a governing specification**: each product's 🦁 Lead adopts what applies into its own Requirements, Specification and Program Design.

Marks used everywhere: ✅ decided by the owner · 🟡 proposed · ❓ open.

## Read in this order

| # | File | What it gives you |
|---|---|---|
| 1 | [decisions-and-open-questions.md](decisions-and-open-questions.md) | The owner's decisions D-1 to D-17 (verbatim), the calls waiting on the owner (A–N, each with a recommendation), the technical questions (T-1 to T-17) and what was superseded |
| 2 | [concepts.md](concepts.md) | The design reference: scope and goals, glossary, who owns what, topology, ownership, identity, access, approvals, leases, failures, today vs target, evidence |
| 3 | [journeys.md](journeys.md) / [journeys.html](journeys.html) | Ten end-to-end journeys (enroll a VM, start agents, approve an email, Grok as chief of staff, Muse talk-only, a shared calendar, a lost cloud→Mac reply, refusals, revocation, lease expiry) |
| 4 | [identity.html](identity.html) | Identity with diagrams: who has one, how each joins, what every hop proves, lifecycle, today vs target |
| 5 | [fleet-model.html](fleet-model.html) | Access with diagrams and test situations: workspaces, personas, resources, sharing, agents asking agents |
| 6 | [build-obligations.md](build-obligations.md) | What each product must build (B-, R-, A-, V- items), 19 cross-product proof cases, and the agent-vm spec findings P1–P17 with dispositions |
| 7 | [inventory.md](inventory.md) | Every owner message from the session, traced to its decision or answer and where it is documented |

The HTML pages share a Pages menu. Open them by double-clicking; they need internet for the Demistify library.

## History

- [council-summary-2026-10-18.md](council-summary-2026-10-18.md) and [council-sol-reviewer-2026-10-18.md](council-sol-reviewer-2026-10-18.md) record the three-Advisor council and the independent Sol review. Points superseded by D-17 are marked; the live corrections are folded into concepts.md.
- concepts.md was rebuilt on 2026-10-18 from an accreted draft. Section numbers cited in board posts before activity 8338 refer to the old layout.

## Where the work lives

- **Concept board:** "Fleet backbone and human interactions" › thread `01a14f55-20c1-753e-823c-6120b2c429b4`.
- **agent-vm work thread:** `01a14e9e-ba87-7605-bc7b-7e6eff6ec101`.
- **Advisor trace:** `~/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-18-tool-portal-identity-advisor-claude-2febb449.md`.
