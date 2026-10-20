# Decisions, owner calls and open questions

Companion to [concepts.md](concepts.md), the design reference, and [inventory.md](inventory.md), which traces every owner message. Reconciled on 2026-10-18 with the agent-vm 🦁 Lead's spec and the Router/board and AgentStudio daemon Advisors' board posts up to activity 8338.

Owner words are quoted verbatim, typos kept.

## 1. Owner decisions

| # | Decision | Owner's words | Status |
|---|---|---|---|
| D-1 | **Topology T2:** one fleet backbone shared by agent-collaboration, AgentStudio and agent-vm. Each product keeps its own records, live traffic and permissions. | "t3 is a stupid idea so is t1, else i woant be talkign to you about htis" / "t2 eneds fleshign out not a fecisous answer" / "yes i agree." | decided (direction); contracts not written |
| D-2 | **Fleet scope:** identities are machines, agents and services for one administrator; leases too. | "fleet is the backbone, and is single user? the identites you are talkiab about is amchiens agents and servers for one user right? same with leases" | decided; refined by D-7 and call A |
| D-3 | **Approvals are distributed and routed through agent-collaboration.** | "i will buidl codex-ruter (soon teob e called agent-collaboration) we need to have approval system thats distributed remote friendly." / "and this needs to be routed see latest work in codex-router.collab-improvements" | direction; the protocol is D3 in the agent-vm spec (open) |
| D-4 | **The iPhone runs its own AgentStudio Gateway.** | "no ios phone has its own gateway" | decided |
| D-5 | **Leases:** renew every 15 min, maximum about 4 h; offline past expiry pauses. | "we establisedh alreayd lease systems have duration" / "then renew eveyr 15min, but with a max tiem of x hours maybe 4. this is fien because agents dont work if they not online" / "its fallacy to think they can work with llm if they are not lonline" | decided (exact maximum not final) |
| D-6 | **Agents are never enrolled by hand.** | "no the agent cant be enrolled by me thers gonna be a lot of them" | decided; launchers enroll under personas |
| D-7 | **Persona** is a primitive above agent: a kind of agent, with on-behalf-of. | "we need a primitvie above agent to enrole a type of agent. examp0el my wife agent has acces to her stuff. or all the codex agents have a persona. so role persona or behalf of. this is very important" / "persona is gkood lets do that" | decided. One owning workspace per persona is a separate proposal (call D) |
| D-8 | **Five interaction kinds:** approval, ask, notification/status, resource sign-in, enrollment sign-in. | "1. approval ... blockign ask or blockign ask with time limit to allwo agent ot progress with reaosn / 2. ask i lie agen studio mdoel ... non blcoigk ask / 3. notifciaonts or status / 4. sign in for toosl like roesroucse / 5. sign in for enole ment of a machien or agents" / "2. make sense" | decided (shape) |
| D-9 | **Four tool modes:** auto, approved, requires approval, blocked, with a judge for auto. | "i think tools need to chagne for 1. auto, approved, requers approval, blocked. autOwe can use jev and classifier for approval" | decided (modes); judge rules proposed (concepts §7.4) |
| D-10 | **"Role" is the wrong word** for access. | "role word conflicts with my world for roel in skills not sure what it emans too lets rethink" | decided; replacement vocabulary is call H |
| D-11 | **External agents** (Dot, Muse) are registered by hand; they message through collaboration and use tools through MCP portal, with board/workspace permissions. | "some agents may only be communicated with as they run their own harness say dot, muse (meta) and they need to have permsision on what htye can access or board" / "external agents are manually resitered to talk and communciate or messagte only" / "they can sue my mcp thorugh my mcp protal too sorry" | decided |
| D-12 | agent-vm's current web approval UI is scratch, not the target. | "we ahve some jany web ui for appovals in agent-vm which is a good scratch but not what we shoud lend kup with" | decided |
| D-13 | Delegation belongs with the MCP portal design work already done. | "delgation is realted to mcp protal sysktem i think we have spent time designed it" / "5. delegation depends on that" | direction |
| D-14 | **agent-vm's scope is resources and credentialed runtimes**, not running agents (except managed Hermes, which may not stay). | "agent-vm is kinda chagned its conept has chagned it saobut the resoruces and credentailled runtimes, not agents running kothe rthan hermes, which im nto sure ill use you knwo what i eman" | decided |
| D-15 | **Machines are private per boundary** (a person, or a shared workspace). | "the machiens ahve to be private per boudnariy in f2, isoaltion by person or shared resrouces else filespaces and stuff will leak." | decided |
| D-16 | Grok execution model as reference: personal bots in the person's VM; a team bot runs in the asking person's VM; a channel bot in a dedicated shared VM. | "seems this is how they do it. i hink we really need to think onthis" | reference; its team-bot rows are superseded by D-17 |
| D-17 | **No cross-person use of agents.** No runtime "requester" switching; no team bot serving several people's accounts; nobody uses another person's agent. (The positive model, where an agent acts for one fixed person or for one workspace with only its resources, is a proposal under call D.) | "what is reqeutser mode?" then "ah i think they use session, yeah i dont want to get into that terrotry and use other peopels agents for this" | decided |

## 2. Owner calls waiting

One call at a time is fine. Each has a recommendation, and none blocks the others.

| Call | Question | Recommendation | Gain / cost | What waits on it |
|---|---|---|---|---|
| **A** | One fleet run by you (F2), or a fleet per person (F1)? | **F2 now**; reopen if a member needs privacy from the admin. | F2: one infrastructure, no federation. Cost: you and the backbone can see and forge everything. | Persons/workspaces contract; household setup |
| **B** | "Workspace" means two things: agent-collaboration's ownership area vs AgentStudio daemon E25's UI layout. Which is renamed? | The daemon's E25 becomes **"composition"** (its own noun, "Shared workspace composition"), or "arrangement set". Not "layout": inside the daemon that already means split geometry (daemon Advisor 8353). | Keeps the word where ownership lives; one daemon rename. | Every cross-product contract that says "workspace" |
| **C** | Household approvals: either of you, or both? | **Either of you**; "both" only for named actions. | Simple; no deadlock if one is away. | Household approval policy |
| **D** | Confirm the proposed core: each person has a personal workspace; each resource has one owner (a person or a shared workspace), registered once, sliced per persona; access sits on the persona (agents are narrowed, never widened); a persona has one owning workspace; the household agent acts for the household only. | **Confirm.** | Everything in concepts §5 and §7 rests on it. | Concepts §5, §7 adoption into product specs |
| **E** | Who provisions each boundary's execution unit (VM or machine) plus an authorized launcher? | No recommendation yet. Not AgentStudio or agent-vm by default (D-14). | — | Any workspace-owned agent (the household agent); not external agents |
| **F** | Agents asking agents: which actions may one agent request from another? | **Grant each requestable action explicitly**, separately from permission to message; check the result's audience separately. | Stops a weak agent laundering through a strong one. Cost: grants to maintain. | Agent-to-agent contract in agent-collaboration |
| **G** | A share into another workspace: to named personas only, or to any persona that workspace chooses? | **Named personas** (immutable references). | You choose who touches your data; cost: re-share for new personas. | Share contract |
| **H** | Vocabulary, in your words: **capabilities** compose (each a bundle of tools with modes, skills and instructions) → a **persona** is the definition (composed capabilities + on behalf of whom + home workspace) → what runs is an **agent session** or a **bot**. Conflicting tool modes are rejected when the persona is saved. A single tool is a "tool". "Role" keeps the skills meaning; "seat" is board participation. | **Yes.** | Your model; one vocabulary across products; runtime still checks one complete profile. Cost: agent-vm's Spec E3 "capability" (single tool) needs a rename or a note. | Names in every contract |
| **I** | Approval modes for calls routed cloud → Mac: set centrally, with each machine able only to make them stricter (a verified floor), or set separately per machine? The agent-vm Lead asked the same question; answer once. | **Central floor**, one prompt per action, the stricter mode wins. | One place to set approvals; one prompt. Cost: one field in the delegation contract. The floor is only as trustworthy as the gateway carrying it. | agent-vm D3 composition; unresolved configurations are rejected |
| **J** | Do harness-native permission prompts (Codex / Claude Code shell and file permissions) stay governed by each harness's own settings, outside this system? Your words: "teh rest goes thorugh harness auto approval". | **Yes**, outside, unless a hook adapter is designed later. | Keeps scope bounded. | Interaction kinds coverage |
| **K** | Is Grok (chief of staff) xAI-hosted, or a Grok model running in your own harness? | Ask only; it decides the path. | xAI-hosted = external agent (unproven per-call correlation, approval-gated tools unavailable at first). Own harness = launched agent with its own credential. | Journey J4 |
| **L** | A **bot** is a long-lived **agent**: the same identity across its sessions, with memory and an execution environment (Hermes, a Grok bot, the household bot). A **worker** is a short-lived agent. One bot per persona; many workers per persona. | **Yes.** | Hermes and Grok-style assistants fit; continuity across sessions; one home for memory rules. Cost: memory audience rules; long-lived compute per bot (call E). | concepts §7.1, §7.3a |
| **M** | Are your AgentStudio Mac and iPhone apps (plus a web client) the inbox for all five interaction kinds: approvals, asks, notifications, resource sign-in, enrollment sign-in? This is new daemon product scope, not implied by D-8. You asked "the client for approvals / logins / aqctual asks and notficiaions where shoukd they live /  agent-studio ios/desktop?" (O22). | **Yes**, AgentStudio apps plus a web client for browser sign-ins. | One inbox where you already work. Cost: new daemon scope (inbox, device enrollment, signed answers). | daemon A-4; inbox client contract |
| **N** | Where a capability gets bound to concrete resources: when it is **installed into a workspace** (your Gmail, pinned version), or separately in each persona? | **At install into the workspace.** | Bound once; personas only pick from what the workspace has; the catalog is the ceiling. Cost: re-install to change a binding. | concepts §7.1a; capability catalog contract |

## 3. Open technical questions

These are for the product Leads; they don't need the owner unless a tradeoff surfaces.

| # | Question | Owner (product) | Source |
|---|---|---|---|
| T-1 | How the agent's credential reaches the cloud MCP gateway through Cloudflare Access: service token plus agent credential, or a local proxy that attaches it | agent-vm (D2) with the backbone | agent-vm PD "Identity, login and revocation" |
| T-2 | Agent credential issuer and format; the trust boundary of gateway-signed delegation vs an agent-bound grant | agent-vm D2 + backbone | agent-vm PD |
| T-3 | Approval decision record, continuation (automatic first dispatch vs retry), resource audience, revocation freshness | agent-vm D3 | agent-vm PD "The approval boundary inside that call" |
| T-4 | Approval composition for routed calls (floor) | agent-vm D3; call I | Lead 8326/8329 |
| T-5 | Who authorizes a launcher for a persona; what the enrollment consent covers when a persona changes (council C-c) | backbone (agent-collaboration) | council summary |
| T-6 | Revocation freshness at each checkpoint (council C-f) | each product | council summary |
| T-7 | Clone fencing: a copied VM must not act as the original machine or its agents (council C-e) | backbone + daemon | council summary |
| T-8 | Per-platform authentication and per-call correlation for external agents (council C-g) | agent-vm + agent-collaboration | council summary |
| T-9 | A fresh human gesture (e.g. Face ID) vs a device key for critical approvals; signed-answer protocol | backbone + AgentStudio clients | concepts §8.5 |
| T-10 | Machine credential custody: current one-core central keeps only a hash of a caller-generated credential; any change is a new proposal | agent-collaboration | Router/board Advisor 8338 |
| T-11 | Private route for live lanes, including iOS (Tailscale vs Cloudflare Tunnel/WARP); push credential home | daemon + backbone | concepts §4 |
| T-12 | Offline projection and admission contract for the interaction store | backbone | concepts §8.5 |
| T-13 | Which AgentStudio capabilities are lease-gated (daemon G13) | daemon | concepts §9 |
| T-14 | How asks generalize off a pane (owner of a non-pane ask); notification vs status as separate channels | daemon + backbone | concepts §8.1 |
| T-15 | D1: independent computer admission during cloud loss vs fresh cloud admission per call | agent-vm | agent-vm Requirements D1 |
| T-16 | Auto-judge placement and limits (who runs the judge for an effective "auto" at the target) | agent-vm | concepts §7.4 |
| T-17 | How a launcher gives each session only its persona's skills and instructions in Claude Code, Codex and Cursor (today skills are installed per OS user per machine) | launchers (Router host, AgentStudio Host) | concepts §7.1a |

## 4. Owner corrections to the Advisor

- MCP portal approvals were described abstractly and wrongly: "you don tudnetand hwo approvasl work in mcp protal so your asnwer is kidna slop". Rewritten from source in concepts §8.7.
- Lease durations already existed: "we establisedh alreayd lease systems have duration".
- Per-agent enrollment by hand: "no the agent cant be enrolled by me thers gonna be a lot of them".
- Helpers: "Don't burn tokens with Opus Agents, please. use luna or sol" / "i told you to use sol for all workers?" / "sol or luna or sidkeicks?".
- "you need to be proactive".
- Documentation: "man i see no diagrasm or epxlanaiton …", "where is any of htis correated stuff", "ivnentory adn proeprly docuetn".

## 5. Superseded

- Identity options A/B/C from the first brief (per-service maps; Router registry with a Cloudflare service token per agent; Router as OAuth issuer). D-6 removes per-agent service tokens; the model is the backbone registry plus launcher-enrolled agents.
- "Single user" (D-2), refined to one administrator with several persons (call A).
- Runtime "requester" mode and per-person instances of a shared team persona (council point 2): superseded by D-17.
- "Approvals go to whoever the agent acts for": replaced by "approvers come from the resource owner's policy" (council C-a).
- "The registry's duplicate-claim refusal covers clones": removed (council C-e); clone fencing is T-7.
- "Outer domain may only allow, hide or deny": withdrawn for the floor recommendation (call I).
- "A session is never an identity": corrected to "not a registry principal or proof" (Router/board Advisor 8338).

## 6. Where the work lives

- Concept board: project "Agent Studio IDE and harnesses" › board "Fleet backbone and human interactions" (`01a14f55-207e-7428-a05a-a058cb8adf15`) › topic "Shared concepts" › thread `01a14f55-20c1-753e-823c-6120b2c429b4`.
- agent-vm work thread: project "Agent VM and Tool Access" › thread `01a14e9e-ba87-7605-bc7b-7e6eff6ec101` (Advisor findings P1–P17 and the Lead's dispositions).
- Sessions:
  - tool-portal Advisor: claude-local/2febb449;
  - daemon Advisor: claude-local/1436a6c8;
  - Router/board Advisor: codex-local/01a140ac;
  - agent-vm Lead: codex-local/01a13a63.
- Advisor trace: `~/dev/session-logs/projects/2026/2026-10-agent-vm/planbooks/2026-10-18-tool-portal-identity-advisor-claude-2febb449.md`.
