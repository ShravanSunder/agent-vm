# How your agents get access to your tools

You want agents on different harnesses and machines to use your allowed tools through MCP: ordinary remote resources, sensitive cloud services and configured computer tools. Provider credentials stay with the resource backend. Identity, permissions and approval must remain meaningful across every connection.

The walkthrough follows the concepts needed to understand that system. It moves between the existing source pages; a page can be revisited when a later concept needs it. The four design documents remain the detailed references.

## Choose the question you want to follow

Open **Walkthroughs** in the page controls and choose one of these paths:

- **Understand the system:** your goal → identity → permissions → routing → tool and credential placement → approval → recovery → package changes → cutover and proof.
- **Identity and permissions:** why a session is insufficient, what an agent identity means, how login proof maps to it, and how that becomes scoped access.
- **Approvals across products:** how the same protected request can appear in Hermes, Router or the IDE while one authority records the human decision and the resource controls its effect.

**Next** continues the same story across pages. **Previous** returns within that story. The narration explains why the current concept follows from your requirement, what the diagram or text adds, and what question comes next. You can close the player and read any page normally.

## The main through-line

| Concept | Why the story needs it | Your requirements |
| --- | --- | --- |
| The connected system | Agents need one understandable MCP experience over independently hosted resources. | U2, U4, U8, U10, U11 |
| Identity | We cannot isolate agents if a display name, session or copied credential is treated as the agent itself. | U3, U13, U15 |
| Permissions | Knowing the agent does not determine which tools and targets it may use. Each call names its admitted workspace. | U3, U7, U13, U16 |
| Administration | Workspace managers see what each agent can use in one view and change it by asking; nothing changes until a manager accepts the proposal, and backend owners enforce it. | U16, U17, U19–U22 |
| Audit | Security changes need an authoritative attributable occurrence, not only a toast or webhook receipt. | U18 |
| Routing | An allowed request must reach its registered resource with the caller's bounded authority intact. | U4, U10 |
| Tool and credential placement | The resource needs useful authority without handing its provider grant or machine privileges to the agent. | U1, U5, U8, U9 |
| Approval | A protected action needs an exact decision, independent of which product presents it. | U3, U14, U15 |
| Recovery | A lost connection must not erase work or turn an uncertain effect into a new action. | U6, U9 |
| Shared packages | These responsibilities need independent consumers and host adapters rather than one local runtime owning everything. | U1, U8, U12 |
| Contract cutover | New approval authority cannot be inferred from an old token or missing standalone history. | U3, U6, U9, U12 |
| Proof and remaining choices | The design must distinguish a correct build from a wrong one and make its unselected policies visible. | U1–U22 |

The main walkthrough visits the requirement behind each concept before following its consequences into definitions, component ownership, current code and planned proof. It does not march through document types as chapters.

## Keep these distinctions as you read

A **package** is reusable code. A **service** is a running owner. An **endpoint** is a network address. An **authority** owns a particular decision or record. Their counts do not need to match.

An **agent** is a logical subject acting for you. A **credential** proves an admitted issuance. A **machine** hosts resources or agent deployments. A **session** identifies a conversation. None of those names alone grants tool permission.

Cloudflare's managed **MCP Portal** and our proposed **MCP Gateway** are different. The managed Portal's unattended identity behavior is a deployment constraint, not something the walkthrough can assume away. The identity path shows why it matters.

## Reference pages

| Source | Its job |
| --- | --- |
| [Requirements](requirements.html) · [Markdown](requirements.md) | Your authorized needs, limits and open decisions. |
| [Specification](2026-10-14-portable-tool-portal-hosts.html) · [Markdown](2026-10-14-portable-tool-portal-hosts.md) | Identity meanings and observable obligations. |
| [Program Design](program-design.html) · [Markdown](program-design.md) | Owners, contracts, package boundaries and code changes. |
| [Verification Design](verification-design.html) · [Markdown](verification-design.md) | What would prove each need and catch a wrong build. |
| [Core and split](core-and-split.html) | What Tool Portal's core does, the five packages, and where today's code goes. |
| [Port inventory](../../wip/2026-10-19-tool-portal-port-inventory/port-inventory.md) | Evidence: every current file's recommended destination and port kind. |
| [MCP Gateway explained](mcp-portal-explainer.html) | A compact view of composition and caller-specific resource groups. |
| [Identity and approvals explained](tool-portal-explainer.html) | A compact explanation of identities, custody and protected actions. |

## Review the control screens

The screens are one access view, a request bar at the top, the proposal card with Accept and Deny, connections, the audit log and, if D7 is confirmed, approvals. Their behavior is specified in [C11](2026-10-14-portable-tool-portal-hosts.html#specification--c11-inspecting-access-connections-and-the-audit-log) and [C12](2026-10-14-portable-tool-portal-hosts.html#specification--c12-chat-request-to-accepted-change), and their structure in [Program Design](program-design.html#program--the-access-foundation-chat-led-change-and-the-control-surface). A console service that talks to both Tool Portal and the fleet will most likely host them (F-57). The experimental mock showed the request router can work; its visual design is not accepted and is aligned later (F-56). The earlier [React review](../../wip/2026-10-18-agent-vm-review/review.html#react-evidence) and its Tools → Agents → Accounts → Audit fixture are superseded.

## What remains a proposal

The shared fleet backbone is the intended identity home and human-interaction route. Its issuer/enrollment contract, persona relationships, Cloudflare ingress identity path, approval settlement and continuation, source-machine policy and finite freshness/retention values remain open. D1–D6 in Requirements identify those gaps, including audit ownership, persistence and trusted team/personal-account classification. No walkthrough step establishes implementation or hosted proof.

## Reading and source

Content stays in its source page. [The agent entry](index.md) links the four governing documents and concept paths. The three walkthrough definitions reference selected headings and diagrams across those pages; their narration is maintained in [walkthroughs.md](walkthroughs.md). The HTML snapshots embed their matching Markdown and load the shared Demistify runtime/theme from the public v1 binding. Internet access is required for those assets; loading them does not publish these local files.

Recorded authoring binding: Demistify `1.5.0`, source `ae26faf6dd3905c6c05440104ff943ec1653154f`. The public v1 URL is experimental and may change. Browser proof is performed through loopback HTTP; direct-file viewing is a separate boundary. Code links are editor references, not files hosted by this document server.
