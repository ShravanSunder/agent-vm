# Fleet backbone: design reference

**Status.** Reference for a future build; reconciled 2026-10-18 with board activity up to 8338. Written by the 🦉 tool-portal Advisor from the owner conversation and the agent-collaboration (Router/board) and AgentStudio daemon Advisors. **Not a governing specification:** each product's 🦁 Lead adopts what applies into its own Requirements, Specification and Program Design.

**Marks.** ✅ decided by the owner (D-n in [decisions-and-open-questions.md](decisions-and-open-questions.md)) · 🟡 proposed, needing owner confirmation or a product contract · ❓ open (a call letter, or a T-n technical question).

**Traceability.** [inventory.md](inventory.md) maps every owner message to the section here that answers it.

**Companions:**
- [identity.html](identity.html): identity, with diagrams;
- [fleet-model.html](fleet-model.html): access, with test situations;
- [journeys.md](journeys.md) and [journeys.html](journeys.html): end-to-end journeys;
- [build-obligations.md](build-obligations.md): what each product must build, and proof cases.

---

## 1. Scope and goals

### 1.1 Products

| Product | Role in this design | Design home |
|---|---|---|
| **agent-collaboration** (formerly codex-router) | Hosts the **fleet backbone** (central). One **Router installation** per execution unit: agent sessions, boards, messaging, launching. | `codex-router.collab-improvements` (design); `codex-router.feat-central-one-core` (central, unmerged) |
| **AgentStudio daemon** (replacement for today's AgentStudio) | **Host** per execution unit (terminals, files, pane asks; a launcher). **Gateway** on Mac and iPhone (your client view). | `agentstudio.feat-daemon`, `docs/specs/2026-10-15-agentstudio-daemon/` |
| **agent-vm** | **Resources and credentialed runtimes** (✅ D-14): cloud MCP gateway, Tool Portal, computer MCP services, credential broker. It does not run agents, except managed Hermes, which may not stay. | this worktree, `docs/specs/2026-10-14-portable-tool-portal-hosts/` |

**Out of scope:**
- cross-person use of agents and runtime requester switching (✅ D-17);
- general cross-fleet federation (only if call A picks F1);
- harness-native permission prompts (🟡 call J);
- a new identity-provider product.

### 1.2 Owner goals

From O7, O16, O17 and O83; see [inventory.md](inventory.md).

| # | Goal | Owner's words (excerpt) | Where met |
|---|---|---|---|
| G1 | Agents of different types (cloud Codex, local harnesses, external) each have an identity | "I want agents of different types of cloud Codex with my Codex router, and I also want an identity for them" | §6 |
| G2 | Identity is separate from authorization | "Maybe we're separating identity and authorization" | §3, §6, §7 |
| G3 | No extra spend for identity: one Cloudflare login, no per-agent paid seats | "I only have my Cloudflare login … I don't want to pay beyond what I need" | §6.3, §6.4 |
| G4 | Approvals are a distributed, remote-friendly service routed through agent-collaboration | "we need to have approval system thats distributed remote friendly" / "this needs to be routed" | §8 |
| G5 | Approvals decoupled from Hermes; event or webhook style; reachable from the IDE (AgentStudio) or Router | "not to couple things; right now our pros are just coupled to Hermes. Make it like a webhook" | §8.3, §8.5 |
| G6 | Follow standards | "We want to follow the standards" | §12 |
| G7 | Everything secure | "Everything has to be secure." | throughout |
| G8 | Documented as a build reference | "it5s future build" | this set |

## 2. Glossary

| Term | Meaning | Status |
|---|---|---|
| **Fleet** | Your infrastructure: one backbone plus every enrolled machine, VM and service. | ✅ D-1, D-2 · ❓ call A |
| **Backbone** | One logical central service (agent-collaboration central): identity registry, leases, mail, interaction inbox, human sign-in, push. | ✅ D-1 · 🟡 contents |
| **Person** | Someone who signs in, owns devices, owns personal resources and approves. | 🟡 |
| **Workspace** | Where things are registered: resources, personas, execution units. A **shared** workspace owns its resources. In a **personal** workspace, resources stay the person's. | 🟡 · ❓ call B (name) |
| **Resource** | Something agents use: an account, MCP server or tool, board, file set, VM. It has **one owner**, a person or a shared workspace, and is registered and signed in once. | 🟡 call D |
| **Execution unit** | A machine or VM assigned to exactly one boundary (a person, or a shared workspace). | ✅ D-15 |
| **Launcher** | A trusted component on an execution unit that starts agents and enrolls them under a persona: an AgentStudio Host (terminal agents) or the Router's host (headless harnesses). | ✅ D-6 · 🟡 who |
| **Tool** | One action: one qualified tool in one authority. (agent-vm Spec E3 calls this a "capability".) | 🟡 call H |
| **Capabilities** | Composable building blocks. Each is a named bundle of **tools (each with a mode), skills and instructions**, e.g. "email triage" or "coding". Several compose into a persona. Generic: no identity, no concrete resources. | 🟡 call H |
| **Mode** | approved · auto · requires approval · blocked, per tool. | ✅ D-9 |
| **Persona** | **A definition**: composed capabilities + on behalf of whom + home workspace, which decides which concrete resources it can reach (your Gmail, the family calendar). Saved as one flattened, complete profile per revision, so agent-vm Spec E4 "complete, no inheritance" still holds at runtime. Never a caller; nothing runs until an agent session or a bot starts. | ✅ D-7 · 🟡 call D, H |
| **Agent** | What runs from a persona and proves who it is (attested by the local Router). Either an **agent session** (short-lived; many per persona; context only) or a **bot** (long-lived; one per persona; memory and an execution environment across its sessions). | ✅ D-6 · 🟡 call L |
| **Bot** | A long-lived agent: the same identity across sessions, with memory and an execution environment. Hermes, a Grok bot, the household bot. | 🟡 call L |
| **External agent** | An agent on another platform (Dot, Muse, possibly Grok), registered by hand: one persona, one agent. | ✅ D-11 |
| **Role** | Two meanings, neither of them an access profile. A **skill role** (lead, implementer, chief of staff) describes purpose. A **Router role assignment** (agent-collaboration spec 1 E11: project/workstream lead, implementer) confers specified **domain authority** on a concrete actor; for example, only a project lead may create a workstream (WS-1). | ✅ D-10 · existing Router contract |
| **Seat** | How a session participates in a board thread. Not access. | 🟡 |
| **Share** | An explicit grant of one resource by its owner into another workspace, with a ceiling. | 🟡 call G |
| **Approval floor** | The outer domain's mode carried with a routed call; the target applies the stricter of the floor and its own mode. | 🟡 call I |
| **Lease** | Writer authority over a replicated store: renew every 15 min, maximum about 4 h. | ✅ D-5 |
| **Interaction** | One of five kinds that reach a human (§8.1). | ✅ D-8 |

## 3. Separation of concerns: one owner per truth

| Truth | Owner | Product |
|---|---|---|
| Who exists (persons, devices, machines, services, personas, agents), their enrollment and status | **Identity registry** | backbone |
| Who may write a replicated store right now | **Lease registry** | backbone |
| Delivery custody between installations | **Mail** (outbox → central → inbox) | backbone |
| Record and projection of interactions (your inbox) | **Interaction store** | backbone |
| That a person's client answered (sign-in, device key) | **Human authentication** | backbone |
| Waking a sleeping device | **Push** | backbone |
| What a persona may do with tools and accounts | **Tool permission profiles** | agent-vm |
| What a persona may do on boards, messaging and requests | **Collaboration permission profiles** | agent-collaboration |
| What may happen on a Host (terminals, files) | **Host grants** | AgentStudio daemon |
| Final admission, single-use approval consumption, running a tool call, the operation record | **Resource** (Tool Portal / computer service) | agent-vm |
| Provider accounts and OAuth credentials | **Credential broker** | agent-vm |
| Pane asks, terminals, repositories, files | **Host** | AgentStudio daemon |
| Agent sessions, boards, coordination asks | **Router installation** | agent-collaboration |
| Live terminal and content streams | **Host → Gateway lanes** | AgentStudio daemon (peer to peer) |

Rules:
- **Identity never implies permission.** The registry holds no permissions; each product keys its own profiles by registry IDs. 🟡
- **The backbone records and delivers but never decides another owner's interaction and never runs an effect.** Co-deployment merges no truths. 🟡
- **Declared is not authenticated.** A board actor, a session ID or a name in a tool call is never proof (§6.6, §6.7). 🟡

## 4. Topology: two planes

✅ D-1: the owner chose **T2**, one shared backbone (registry, leases, mail, inbox and push) while each product keeps its own records and live traffic. Rejected: **T1**, separate per-product stacks, each with its own central identity and approval service; and **T3**, one merged node daemon on each machine replacing the products' own services. 🟡 the plane split below

```text
CONTROL PLANE: each service and device keeps ONE outbound connection to the backbone
   Router installation --+
   AgentStudio Host -----+
   computer MCP service -+--> FLEET BACKBONE (one logical service)
   cloud MCP gateway ----+       registry · leases · mail · interaction inbox · human sign-in · push
   Gateway on Mac -------+
   Gateway on iPhone ----+   (only while the app is awake; push wakes it)

DATA PLANE: live and bulky traffic goes PEER TO PEER over a private route (route not chosen, T-11)
   Host  --terminals, files, replication-->  Gateway (Mac or iPhone)
   cloud MCP gateway  --tool calls with bounded delegation-->  computer MCP service
```

- The iPhone runs its own Gateway (✅ D-4).
- A Gateway attaches to many Hosts, and a Host serves several Gateways. Broadcast details belong to the daemon spec (O25).
- Nothing live or bulky passes through the backbone.

## 5. Ownership: fleet, persons, workspaces, resources, compute

### 5.1 Fleet (❓ call A)

| Option | What it is | Gain | Cost |
|---|---|---|---|
| **F2 (recommended)** | One fleet, one admin (you); persons are members; workspaces partition ownership | one infrastructure; household sharing needs no federation | you and the backbone are trusted with everyone's data; one compromise affects all; every product must check workspace and person scope, including reads; 🟡 a person leaving needs an export path |
| **F1** | A fleet per person; sharing needs cross-fleet links (trust link approved by both admins; messages hop backbone to backbone; token exchange, RFC 8693 `act`) | privacy from the admin | links, revocation across fleets, two admins per link |

Reopen F2 only if a member needs privacy from the admin. Today's central admits exactly one admin: `email == policy.owner_identity` (`codex-router.feat-central-one-core`, `access_rules.rs:149-155`, unmerged). Fleet, workspace and person are **kinds of ownership scope, not a containment ladder** (council C-h).

### 5.2 Persons and workspaces (🟡 call D)

- Every person has a **personal workspace**.
- **Shared workspaces** (e.g. `household`) have several members.
- A person belongs to several workspaces. Their private accounts never become workspace-owned.
- Router workspaces are today an organizational home, **not yet a confidentiality boundary**. Membership, privacy and delegation must be built (council C-h).
- Naming: AgentStudio daemon E25 also says "workspace" for UI layout (❓ call B).

### 5.3 Resources (🟡 call D)

- Every resource has **one owner**: a person, or a shared workspace. Its owner **registers and signs it in once**, into a workspace: your Gmail into your personal workspace (still yours); the family calendar into the household.
- Registering never transfers ownership. Approvers come from the **owner's** policy (council C-a).
- Each persona is granted its own **slice**. An agent's access has two layers: the persona's workspace is the **ceiling** (what is registered there or shared in), and its permission profile is the **slice**.
- **Today:** agent-vm admits Google accounts by owner (issuer + subject) **and** `allowedAgentIds`, and config validation requires each listed agent to exist (`google-permission-policy-service.ts:146-156`). So current access is per agent ID. Granting to a persona instead is a **consent expansion, not a key rename**: future instances inherit it. The grant must state the owner, workspace, persona revision, limits and instance narrowing it covers, and widening a persona never widens existing consent (council C-c; agent-vm Spec C3/C8, Lead 8301).

### 5.4 Compute boundaries (✅ D-15)

- Every machine or VM is assigned to **exactly one boundary**: a person, or a shared workspace. Its files, repositories, caches, logins and credentials at rest belong to that boundary.
- A launcher only starts personas whose acts-for falls inside its unit's boundary. **Workspace personas run only on workspace units** (daemon Advisor 8304; consistent with D-15).
- An AgentStudio Host and a Router installation serve exactly one boundary.
- 🟡 Shared hardware hosting several boundaries uses VMs, not separate OS users (council point 5; D-15 requires the isolation, not this mechanism).
- **Never crosses between boundaries:** execution state, ambient credentials, filesystem authority.
- **Does cross when authorized:** content. A brokered resource result, or a mail body that persists at the recipient (Router PD4:125–137), keeps its owner, audience and ceiling attached (8286, 8308).
- **Provisioning (❓ call E):** each boundary needs an execution unit plus an authorized launcher. The launcher is an AgentStudio Host (E23) for terminal agents, or the Router's host for headless harnesses (`conversation_operations.rs:68–92` dispatches through `ProviderConversationBackend`; `codex-router-host`'s `ExternalProviderSupervisor` creates sessions). Not assigned to AgentStudio or agent-vm by default. External agents need none of our provisioning.
- Reference: Grok's execution table (D-16). Its team-bot rows are superseded by D-17.

### 5.5 Sharing across workspaces (🟡 call G)

A **share** is an explicit grant made by the resource's owner:

| Field | Meaning |
|---|---|
| resource | the resource |
| from | its owner |
| into | the target workspace |
| recipients | named, immutable persona references (recommended); or "any persona of the target workspace", which delegates recipient choice to that workspace's admins and needs your explicit consent |
| ceiling | the actions allowed |
| expiry | when it ends; it is revocable at any time |

Rules:
- The recipient's slice can only narrow the ceiling: effective mode = the stricter of the two.
- The credential stays in the owner's broker; the gateway uses it within the ceiling.
- Approvers stay the owner's.
- A share never switches acts-for, borrows the owner's agent, transfers a credential, appoints a role or delegates approval authority (D-17).
- A named grant never widens when a persona's definition changes.

**Assurance limit:**
- A share can forbid further grants and publication beyond its audience.
- It **cannot** stop an agent that has read content from repeating it.
- Read-only limits actions, not dissemination.
- Revocation stops future access; it doesn't recall what was read.

## 6. Identity

Diagrams: [identity.html](identity.html).

### 6.1 Who has an identity

| Principal | Proves itself with | Enrolled by | Status |
|---|---|---|---|
| Admin (you) | Sign-in through the configured Cloudflare Access identity provider | — | 🟡 |
| Person | their own Access sign-in | you invite; they sign in | 🟡 |
| Device (your Mac/iPhone app) | a device key enrolled to you; proves the device, not a fresh tap | you, per device | 🟡 · ❓ T-9 |
| Machine / installation | a valid Access assertion for its configured service client, mapped to its enrollment, **plus** the central machine credential check. This proves neither physical presence nor that the unit is uncloned. | you approve its join | 🟡 · ❓ T-7, T-10 |
| Service (Router installation, Host, computer MCP; cloud gateway, broker) | its own service credential; machine-hosted services register under their machine | the machine, or you | 🟡 |
| Persona | **nothing**: a registry entry, never a caller | the workspace's owners | ✅ D-7 |
| Agent | its own short-lived credential from the backbone, obtained by its launcher | the launcher, automatically | ✅ D-6 · 🟡 · ❓ T-1, T-2 |
| External agent | per platform (header token, OAuth connector) | you, by hand | ✅ D-11 · ❓ T-8 |

- **The iPhone app is two identities:** your device, which answers approvals, and an AgentStudio Gateway, which pairs with Hosts. Neither credential does the other's job.
- **A session or conversation is not a registry principal and not proof.** In the Router a SessionRef remains an actor identity (Router spec E10; RC-8 separates actor from carrier). A new conversation need not mint a new agent principal (8338).

### 6.2 The registry

- It records principals, their owner-authorized enrollment, credential bindings and status.
- It holds **no permissions**.
- Cloned images must not inherit a usable enrollment. The Host singleton lock is local only; clone fencing is open (council C-e, T-7).

### 6.3 Enrollment flows

1. **Admin bootstrap.** You sign in through Access. Central admits admin routes only for the configured owner email. That's what central does today, on an unmerged branch.
2. **Machine join** (enrollment sign-in, D-8). The machine requests to join and shows a code; you approve on a device.
   - In the current one-core central design, the machine **generates its own credential and central stores only its hash**. Enrollment returns a PeerId, expiry and ReceiverId, never the secret (one-core design §0a).
   - The Access client ID identifies the service client; it is not its secret.
   - The machine is assigned to one boundary.
   - Any central-issued machine credential would be a new proposal (T-10).
3. **Persona definition.** The workspace's owners define the persona: acts-for, launch rule (which launchers, how many, how long) and one permission profile per product.
4. **Launched agent** (✅ D-6). A launcher on an enrolled unit proves itself and asks to enroll an agent under a persona. The backbone checks that the launcher is allowed for that persona and boundary, within limits, and issues an agent ID plus a short-lived credential. The agent renews while running.
   - Launcher authorization and consent scope: T-5.
   - Credential carriage through Cloudflare: T-1.
5. **External agent** (✅ D-11). You register it by hand, giving one persona and one agent, with its profiles. Its credential depends on the platform.
6. **Person and devices.** You invite; the person signs in and enrolls their devices (an enrollment sign-in to themselves). They then sign in to their own resources (resource sign-in, through the credential broker) and grant slices to personas.

### 6.4 What each hop of one call proves

The example is an agent calling a Mac tool through the cloud gateway.

| Hop | Proves | Proven by | Status |
|---|---|---|---|
| Cloudflare Access | a valid assertion for a configured service client | Access service token (no paid seat), mapped to its enrollment | 🟡 |
| Agent credential | which agent, and so which persona and workspace | the agent's backbone credential, checked for validity and revocation | 🟡 · ❓ T-1 |
| Gateway policy | what this agent may do | the persona's tool profile, narrowed for this agent, plus resource-owner grants | 🟡 |
| Gateway → Mac | the gateway acts for this agent, for this exact call | gateway service identity + bounded delegation (agent-vm Spec E10) | 🟡 · ❓ T-2 |
| Mac | the final yes or no | its own ceiling; approval if needed; single use | 🟡 |

A stolen gateway signing key could claim any agent, but only within each target's ceiling. An agent-bound grant would narrow that; T-2 decides.

### 6.5 Credential lifecycle and revocation

| Event | Effect | Status |
|---|---|---|
| Rotation | same agent, new credential issuance; a pending approval bound to the old issuance may need asking again | 🟡 |
| Revoke one credential | that issuance only | 🟡 |
| Revoke an agent | all its issuances; history kept for audit | 🟡 |
| Revoke a persona | every agent of that kind | 🟡 |
| Suspend a machine | its services, and new agents from its launcher; the effect on running agents is open | 🟡 · ❓ |
| New conversation | nothing: same agent, no new login or token | 🟡 |
| Network reconnect | same identity; a new authenticated connection | 🟡 (O3) |
| Permission change | same agent; a new assignment revision; stale approvals invalid | 🟡 (O3) |
| Authorized relocation of an agent | same agent; updated execution-environment binding, within its boundary | 🟡 (O3) |
| New independent machine | new identity and credential | 🟡 (O3) |
| Machine disabled | new admissions that need that machine are rejected | 🟡 (O3) |

IDs are independent of token values, key fingerprints, IP addresses and socket IDs (O3). **Presence is separate from identity** (O3):
- registered and offline → a known identity, an unavailable target;
- disabled and connected → a connected transport, access denied.

Freshness is checked at Cloudflare, the gateway, the target and before first effect; the maximum delays are open (T-6).

### 6.6 Harness sessions (Claude Code, Codex, Cursor) and agent identity

Owner, 2026-10-18: "we have agetn session id which is identiy along wiht amchine/routing/sesisonid provider in coedex rotuer … so agent can attest with identity?"

**Today, in agent-collaboration** (`codex-router.collab-improvements` at `af3fb454`). A harness session is a `SessionRef` = `{serviceId, endpointId}` + `sessionId` (`crates/collaboration-protocol/src/endpoint_identity.rs:94-110`):
- `serviceId` is the Router installation. Its "machine identity" is that UUID plus a hostname label (`collaboration-service/src/machine_identity.rs:5`).
- `endpointId` is the harness adapter (`codex-local`, `claude-local`, `cursor-local`). It is "not a computer, process, transport connection, or conversation identity".
- `sessionId` is the provider's conversation ID, "interpreted only by its endpoint".

How the caller is identified today:
- The CLI learns its own session from the harness's environment variable (`CODEX_THREAD_ID`, `CLAUDE_CODE_SESSION_ID`, `CURSOR_CONVERSATION_ID`; `agent-collaboration/src/current_session_identity.rs:16-29`).
- The MCP server never sees that environment. Callers are "supplied by the MCP request and … not authenticated; the service uses it as a confusion guard" (`collaboration-mcp/src/mcp_server/message_tools.rs:37`).
- Session IDs appear in posts, links and logs, so they are not secrets.
- **So a `SessionRef` is an address and correlation, not an attestation.**

**Target** (🟡; D-6):
- The `SessionRef` stays the agent's address and Router actor identity (E10).
- The registry adds an **agent ID bound to that `SessionRef`** and a **credential** that proves it.
- The binder is the party that started the harness: the launcher. That is the Router's host for Codex threads it creates, or an AgentStudio Host for terminal agents. At launch the launcher enrolls the agent under a persona and obtains a short-lived credential bound to the `SessionRef`. Preferably the local Router or a proxy attaches it, so the agent's environment never holds it.
- **The local Router installation is the attester for sessions on its machine** (🟡; owner: "the router knows we make it mechancial to provide the form?"). What it knows today:
  - sessions it created, from its provider operation records (`collaboration-service/src/provider_operation_store.rs`);
  - live Claude Code sessions started by hand, from Claude Code's local registry: session ID ↔ live PID, cwd, socket path, with a liveness probe and duplicate-claim detection (`claude-code-peer-messaging/src/claude_code_session_registry.rs`).

  It submits an **attestation** to the backbone:
  - installation `serviceId` (enrolled, with a boundary);
  - `endpointId` + `sessionId`;
  - evidence: created-by-this-Router (operation ID), or live local session (PID, process start time, socket path);
  - persona;
  - a short expiry.

  The backbone checks that the installation is enrolled and unrevoked, that the persona's workspace equals the machine's boundary, and the launch rule. It then returns an agent ID and a short-lived credential bound to the `SessionRef`. The Router keeps it and attaches it to the agent's outbound calls, which resolves T-1 with the local Router as the proxy.
- **The Router must add:**
  1. binding the calling connection to a session, which isn't done today: a per-session token in the harness's MCP config for sessions it launches, or the connecting process ID over a local socket mapped to the registry's live process for terminal sessions (Cursor needs the token, as it has no registry);
  2. a persona rule: named in the create request for Router-created sessions, or a default persona per harness per machine, set once by the owner, for terminal sessions.
- **Limit:** it proves "a live harness session of this machine's user", not model behavior. Any process of that OS user could pose as another of that user's agents. Because a machine serves one boundary (✅ D-15), that never crosses to another person's or workspace's agents.

**Workspaces don't pool identities.** A workspace holds personas and resources; an agent belongs to a workspace only through its persona.
- Your wife has her own personal workspace (🟡 call D), with her personas, agents, accounts and machines.
- Personal agents don't work *in* `household`. The household's own persona does shared work on household compute (✅ D-17 rules out an agent working for both people).
- Personal agents of both people can **talk** on the household board when that board is shared to their personas. Talking is never acting for the other person (✅ D-17), and getting an agent to act needs an explicit per-action grant (🟡 call F).
- Today none of this is enforced: a message's sender is "reported by the request's client, not authenticated" (`message_tools.rs:8`).

### 6.7 Never accepted as proof

- a session ID;
- a board post's author;
- an agent name inside a tool call;
- `X-Forwarded-User-Agent`;
- the identity of Cloudflare's managed MCP Portal for unattended agents (it calls upstream with one shared admin credential).

## 7. Access

Diagrams and test situations: [fleet-model.html](fleet-model.html).

### 7.1 Vocabulary (🟡 call H)

Owner: "capabilties is a term that means colleciotn of capabitites skills, instruciotns. when isntantiated its a persona/ agent no? then bot is just longlived?"

```text
capabilities ──compose──►  persona (a definition)  ──run──►  agent session  (short-lived, many per persona)
tools+modes,               composed capabilities              or
skills, instructions       + on behalf of whom                bot            (long-lived, one per persona:
                           + home workspace                                  memory + execution environment)
```

- **Capabilities compose.** Several bundles (say "email triage" + "calendar") make one persona. When the persona is saved, they are flattened into one complete profile for that revision.
  - Conflicting modes for the same tool are **rejected on save**, and the author picks one. "Stricter wins" was the alternative, but then adding a capability could silently remove access.
  - Changing a capability makes a new persona revision. It never widens consent a resource owner already gave (C-c).
- **The persona is the definition.** It says what may be done and for whom, and its home workspace decides which concrete resources that means. One capabilities bundle can feed several personas, e.g. a shared template that each person instantiates as their own persona.
- **What runs is an agent session or a bot.** Both are agents: authenticated, Router-attested callers. A bot is long-lived and keeps memory and an execution environment; for a bot, persona and running instance are one-to-one.
- A single tool is a **tool**. agent-vm's Spec E3 calls it a "capability"; cross-product documents say "tool" to avoid the clash (call H).

- **Three separate meanings** (Router/board Advisor 8347):
  - a **skill role** (lead, implementer, chief of staff) is purpose and grants nothing;
  - a **permission profile** controls which principals may reach and use resources;
  - a **Router role assignment** (E11) confers specified **domain authority** on a concrete actor. RL-5/6 restrict who may grant it; WS-1 requires a project lead to create, rename or close a workstream.
- Access never replaces E11 gates. An authenticated agent with the right profile still needs its E11 role for role-gated operations. A persona or a share never appoints a role, and role histories are never merged. This preserves an existing Router contract; it isn't a new persona rule.
- "Chief of staff" is a skill role, not one of E11's project/workstream roles.
- **Seat** is board participation.
- An access grant never appoints a role, and a seat never bypasses access checks.

### 7.1a How capabilities operate: in a workspace vs in an agent or bot (🟡 call N)

Owner: "ok now how they operate.  what are capabilties in a agent/bot vs in a workspace?"

```text
fleet library (optional)     workspace                        persona           agent session / bot
generic templates ─install─► capabilities installed here, ─compose─► definition ─run─► receives them:
"email triage" v3            BOUND to this workspace's                          tools checked per call;
                             resources (your Gmail)                             skills + instructions delivered
```

- **In a workspace, a capability is supply.** Installing it binds its generic tool references to the workspace's registered or shared-in resources and pins a version. It can't be installed unless those resources exist there, so the workspace's catalog is the ceiling.
- **In an agent session or a bot, a capability is selection.** The persona composes some installed capabilities, and the running agent receives exactly that set.

| Part | In the workspace | In a running agent session or bot | Enforced? |
|---|---|---|---|
| Tools + modes | listed against the workspace's resources | visible through the MCP gateway; every call checked against the persona's flattened profile, the resource owner's grant and the mode | yes (agent-vm gateway / resource) |
| Collaboration tools (boards, messaging, requestable actions) | the workspace's boards and agents | every call checked | yes (agent-collaboration) |
| Skills | stored, versioned | delivered by the launcher at start; a bot keeps them in its environment and updates on a new persona revision | no (they guide the model) |
| Instructions | stored, versioned | delivered as system prompt or project instructions | no |
| Secrets | never part of a capability; they stay in the owner's credential broker | never delivered; tools use them on the agent's behalf | — |

**Rules:**
- **Instructions are not permissions.** A skill or prompt can't unblock a tool.
- A capability never carries a secret. This is unlike Grok team bots, whose secrets are "available in every teammate's conversation".
- **Agent session vs bot:**
  - a session gets the persona revision current at launch;
  - a bot updates when the persona revision changes;
  - both are checked on every tool call;
  - only a bot has memory (a workspace resource with an audience).

**Today:**
- Skills are installed per OS user on a machine (Claude Code and Codex plugin folders), so every session on that unit sees all of them.
- Per-persona delivery needs the launcher to scope skills per session; whether each harness supports that is unverified (❓ T-17).
- Because a unit serves one boundary (✅ D-15), per-machine skills don't cross people; they are just broader than one persona.

### 7.2 Personas (✅ D-7, D-17)

- **One owning workspace** (🟡 call D). The same definition registered in two workspaces gives two personas, with separate grants, history and consent. The home workspace is not an access limit: an agent can still receive a share.
- **Acts for** (✅ D-17 rejects cross-person use; 🟡 call D proposes the positive model): one fixed person, or one workspace using only that workspace's resources. There is no runtime "requester" switching: a bot that switches whose accounts it uses depending on who is talking was rejected. A household agent acts for the household, not for either person (🟡 call D).
- **Origin:** launched (we run the harness; a launcher enrolls instances) or external (registered by hand).
- **Launch rule** (launched only): which launchers may start it, how many, for how long.
- **Profiles:** one per product (tools in agent-vm, collaboration in agent-collaboration, Host grants in AgentStudio).
- A persona is a **template**: it is not the caller and does not own operations (Lead 8292).

### 7.3a Bots versus agents (🟡 call L)

Owner: "so waht is a agent or bot maybe we seperate concetps … a bot has memories? … bot sin ehrmes or gorkobt they ahve memeory and execkution evneiroment".

```text
capabilities ──compose──► persona (definition) ──run──► agent session | bot
```

| Concept | What it is | Memory | Execution environment | Lifetime |
|---|---|---|---|---|
| Persona | what may be done, for whom (profile + acts-for) | none | none | a definition |
| Bot | one persona + memory + its own execution environment + channels (board, Slack, app) + configured skills and plugins | yes, a resource of its workspace | yes, a VM or folder on its boundary's unit | until retired |
| Agent | one running harness session, attested by the local Router (§6.6) | its context window only | its host's, or its bot's | minutes to days |

Mapping:
- Hermes, a Grok personal bot, the household bot and Grok as chief of staff are **bots**.
- Dot and Muse are external bots: their memory and environment live on their platform.
- Coding sessions of `codex-worker` are **worker agents**, with no bot.

Rules:
- **The caller:** for a bot, the bot is the stable caller (agent-vm Spec E2: "Many credentials may authenticate one caller; many sessions may refer to it"). A later session can resume an earlier session's pending work, and the bot keeps one history. A worker agent is its own caller, so worker histories stay separate.
- **Memory is a resource with an owner and an audience:**
  - a personal bot's memory is personal;
  - a household bot's memory is household-visible;
  - content derived from a private conversation never enters a shared bot's memory without the owner's OK;
  - per-person private notes inside one shared bot are the rejected requester model (D-17).
- **Environment:** a bot's execution environment sits on a unit of its own boundary (✅ D-15). Provisioning is call E.
- **One bot, one persona.** A persona may have no bot (worker types) or one bot. Two assistants with the same access are two bots with two personas.

### 7.3 Agents and grants

- An agent is persona + instance ID + launcher + execution unit (launched), or persona + registration (external).
- An agent **inherits its persona's slice and can be narrowed, never widened**.
- It is the authenticated caller and owns its operations and artifacts. History is never merged under the persona.
- "Agents are authenticated; personas are authorized" is shorthand only. Instance narrowing, the resource owner's current grants and audience checks all still apply; a persona profile alone is not sufficient authorization (8338).

### 7.4 Tool modes (✅ D-9)

| Mode | Who decides | Today's nearest equivalent (`mcp-portal-approval-policy.ts:57-80`) |
|---|---|---|
| approved | nobody; it runs | `allowWithoutApprovalTools`; `withoutApproval` namespaces; trusted read-only annotation |
| auto | a judge (Jev or a classifier) inside fixed limits | new |
| requires approval | a human approver from the resource owner's policy | `alwaysAskTools`, `writeTools`, `requiresApproval` namespaces, `always-require-approval` |
| blocked | nobody; it never runs; no approval overrides it | everything else |

These are per-tool policy choices, not operation states. A timed-out or handed-back approval is never a grant.

**Auto judge rules** (🟡; placement T-16):
- three outcomes: approve, escalate to a human, deny;
- unsure, unavailable or timed out → escalate;
- recorded as a decider (judge identity, policy version, reason);
- acts only inside **deterministic limits** set outside the model (eligible tools, recipients, accounts, effect bounds), and treats arguments as untrusted (council C-b).

**Critical tools go to a human whenever they are allowed to run; blocked stays blocked.** Today's `approval_required.level: 'critical' | 'standard'` (`portal-tools.ts:264`) is an unused OpenClaw-era severity hint; this gives "critical" a real policy meaning.

### 7.5 Agents asking agents (🟡 call F)

Messaging is not permission to act. For agent A to get agent B to do X, three separate checks apply:
1. May A request **this offered action** from B?
2. May B do X on the target resource, with **B's own** authority?
3. May the result go to **this audience**?

- `approved` only removes the per-call human step inside those checks.
- An approval request shows who asked. That is provenance only, unless the asker's identity is verified.
- AgentStudio pane notices and asks (E11) are a may-message channel, never a may-request-action grant (8304).
- Cooperation stays within one workspace's agents, or one person's agents (D-17).

### 7.6 External agents (✅ D-11)

- One persona and one agent, registered by hand.
- **Collaboration profile:** which workspaces and boards it may read and post to, and which agents it may message.
- **Tool profile** (MCP portal): optional. "Talk only" means no tool profile **and** no portal credential.
- Its posts are untrusted data and never instructions.
- It gets fixed-person or workspace-only authority. Approval-gated tools are unavailable to it until its platform proves per-call correlation (council C-g, T-8).

### 7.7 Team bots, family bots and personal agents (tradeoffs)

Owner: "how this diffrent form a team bot?  or a family bot?  etc?  pros and cons lets think in tradeoffs".

| | Team bot (Grok style) | Family bot (`household-agent`) | Personal agents | Shared template, a copy each |
|---|---|---|---|---|
| Acts for | whoever is asking | the household | one person | each copy, its own person |
| Whose accounts | the asker's sign-ins | household-owned plus explicit shares | its person's | its person's |
| Setup | once | once | per person | once, copied |
| Memory | team memory + private notes per person | household memory | per person | per copy; shared knowledge via household memory as a resource |
| Privacy between people | depends on one bot compartmenting everyone | anything it touches is household-visible | strong | strong |
| Runs on | the asker's VM per conversation, or a shared VM | household VM | each person's units | each person's units |
| Approvals | the asker | household approvers | the person | the person |
| Main risk | one bot holds everyone's access; injected content from one person can drive actions with another's accounts; history not compartmented by credential (council) | nothing personal; shares widen exposure | duplicated setup | template updates must not widen consent |
| Build cost | high: per-invocation binding, per-person compartments, a VM per asker | low | low | medium |
| D-17 | rejected | fits | fits | fits (one definition registered per workspace, §7.2) |

**Recommendation** (🟡):
- a family bot for shared jobs, plus personal agents;
- optionally a shared template, to get the team bot's "set up once" and shared knowledge without any agent holding two people's access.

**Cost:** a copy per person, on that person's compute, and no single chat surface for personal requests in a family channel.

**Reopen if** one chat entry point should *route* requests to each person's copy. That would be routing only, never switching a live worker between people, and is out of scope for now.

### 7.8 The check chain for one tool call (🟡)

1. Agent credential valid, agent and persona not revoked.
2. Persona and workspace from the registry.
3. Tool in the persona's profile (narrowed for this agent), and resource registered in the workspace or shared in.
4. Resource owner's current grant.
5. Effective mode (§8.4 for routed calls).
6. Approval if required.
7. Single-use admission at the resource.
8. The result's audience.

## 8. Human interactions and approvals

### 8.1 Five kinds (✅ D-8)

Built on AgentStudio's ask model (`PaneContextAskSettlement.swift`): waiting is `non-blocking` or `blocking(deadline)`; endings are `answered`, `handedBack`, `dismissed`, `expired`, `withdrawn`, `stale`.

| Kind | Agent waits? | Answer | Endings | Settled by |
|---|---|---|---|---|
| Approval | yes, optional deadline | approve / deny | approved; denied; expired (agent gets "not approved: timed out" and continues); handed back | the decision owner (D3, T-3); the resource re-checks and uses it once |
| Ask | no (blocking available) | text, choice or form | answered; dismissed; withdrawn; stale | the ask's owner (Host for pane asks, Router for Router asks) |
| Notification / status | no | read only | read / dismissed | interaction store. Delivery, dismissal and read marks are separate states; status may be its own channel (T-14) |
| Resource sign-in | yes, optional | complete the provider's page | completed (broker-verified); expired | credential broker. Tokens and codes never enter interaction content or push |
| Enrollment sign-in | yes | approve the join | enrolled; refused; expired | identity registry |

### 8.2 Who approves (🟡)

- **Approvers come from the resource owner's policy** (council C-a): you for your Gmail; household approvers for household resources (❓ call C).
- The requester only supplies context.
- The admin is not a fallback approver.
- In a batch, the policy binds every target.

### 8.3 The approval path (🟡; D3 open)

1. The agent calls with a **stable operation ID** that it chooses and reuses on retry.
2. The resource records the operation as pending and raises an approval: the exact call, who asked, and an expiry.
3. The backbone inbox **carries and shows** it. The inbox is transport and projection, not the decision authority.
4. A push wakes your phone; the app fetches the request as your enrolled device.
5. You answer. An **authorized device authenticated the answer**; that proves neither approver eligibility nor a fresh physical tap (T-9).
6. The decision owner records the decision (D3 open: a local or external authority; online reservation vs a resource-bound receipt).
7. The resource re-checks the decision, current policy and the requesting issuance, then **uses it once**.

Further rules:
- The decision goes to the resource, so no harness has to carry a private approval token (`_meta`). That makes it webhook- and event-friendly (G5); Standard Webhooks 1.0.0 is prior art for delivery.
- Matching "same agent + tool + arguments + time window" is **not** an operation identity. Two intentional identical sends and one retry look the same.
- An ambiguous result after arming is never replayed.

### 8.4 Calls routed cloud → Mac

- **Operation key** (agent-vm P16, accepted):
  - outer `(gateway authority, agent, K)`, inner `(computer authority, agent, K)`;
  - the gateway records the target and inner key before sending;
  - recovery after a lost reply looks up the same inner key and never runs the action;
  - a late reply cannot undo a finished result.
- **Approval composition** (❓ call I, agent-vm D3): recommended **floor**.
  - The cloud's mode travels in the delegation; the Mac applies the stricter of it and its own mode and asks once.
  - A missing floor is rejected.
  - The floor preserves cloud policy only while the gateway and issuer stay honest.
  - Unresolved compositions are rejected, not guessed.

### 8.5 Inbox, settlement, clients (🟡)

- **Interaction store:** the backbone's record and projection. "Goes through" means recorded and shown by, not routed or gated by. Host pane asks settle locally and report when reachable. An unreachable backbone never blocks an answer from a client attached to that Host. The offline contract is T-12.
- **Settlement owner:** exactly one per interaction, by kind. The inbox shows "settled" only after that owner's receipt.
- **Clients:**
  - Your AgentStudio Mac and iPhone apps, and a web client (🟡 call M: new daemon scope).
  - A client answers a kind only if it is authenticated as your device or session, authorized for that kind, and able to give that kind's answer.
  - Resource sign-in needs a browser.
- **Presenters** (IDE, Hermes, web pages) show, never decide.
- agent-vm's current approval web UI is scratch (✅ D-12). The pattern worth keeping is Access-verified approver identity.
- **Push** is a redacted wake signal; content is fetched after device authentication.
- **Effects** happen only after settlement, under the resource's own rules; settlement itself never dispatches.

### 8.6 Harness-native prompts (❓ call J)

Codex and Claude Code shell and file permission prompts stay with each harness's own settings, outside this system: "teh rest goes thorugh harness auto approval". If a hook adapter is designed later, the harness settles, and the inbox withdraws the item when it does.

### 8.7 MCP portal approvals today (source facts)

| Path | Prompt | Decider / minter | Portal |
|---|---|---|---|
| Standalone MCP Portal | the harness's own UI (originally OpenClaw `requireApproval`) | a harness-side plugin with a per-agent HMAC key, `PORTAL_HMAC_KEY__<agentId>` (`hmac-env.ts`). It signs `{agentId, calls[namespace, toolName, argumentsHash], exp, iat, jti}` with audience `mcp-portal:approval` (`hmac-token.ts`); the agent retries carrying it in `_meta["agent-vm/tool-portal-approval-token"]` (`portal-mcp-server.ts:31,243`) | verifies, single use via a replay cache, runs; no server-side approval record |
| Standalone Tool Portal | none built in | "a protected operator approval integration that owns the HMAC key" (`standalone-tool-portal-approval.ts:203`) | challenge; verifies; reserve/arm once |
| Managed (Hermes) | Hermes native UI | controller approval ledger | runs under the controller grant |

- No production code in the tree mints these tokens since the OpenClaw plugin was removed (`f2fb4c05`).
- The signing helpers and test callers remain; outside consumers were not checked.
- agent-vm retires both old standalone approval protocols at a hard cutover (P12; agent-vm PD "Retire legacy standalone approvals").

## 9. Leases and mail (✅ D-5 cadence and maximum · 🟡 pause rules from Router FL-9)

**Leases:**
- Renew every 15 minutes, maximum about 4 hours.
- When a lease expires, lease-gated writes, wakes and schedules **pause**; reads continue; renewal of the same epoch resumes them.
- No spool, grace period or bypass: "agents dont work if they not online".
- Matches Router FL-9 and fleet-sync SE2.
- These are writer leases over replicated stores, not tool execution windows or approval lifetimes.
- Which AgentStudio capabilities are lease-gated is T-13.
- Lease holders are installations, and the backbone checks the holder's boundary against the store's (council C-d, scoped to the daemon's owning Host database per 8286).

**Mail:** custodial delivery, outbox → central → inbox. Delivered is not read, answered or approved.

## 10. When something is down

| Failure | Still works | Waits (fails closed) |
|---|---|---|
| Backbone down | live peer lanes; local work; leases until expiry; Host-local asks answered from an attached client | new remote interactions and answers; lease takeovers; outboxes queue |
| Producer machine down | the inbox shows the request | the answer waits; on return the owner re-checks expiry before settling |
| Phone suspended | push wakes it | nothing lost |
| Device lost | you revoke it | answers proven by that device are refused |
| Host offline past its lease | sessions keep running | lease-gated writes, wakes and schedules pause |
| Cloud gateway loses a Mac reply | the gateway recovers the same inner operation | no new run of the action (§8.4) |

## 11. Today versus target (code facts)

| Product | Today | Target |
|---|---|---|
| agent-collaboration | Board actors and session IDs are declared, not authenticated. Approval answers are compared with a **supplied** identity (`interaction_history_store.rs:548-565`), and pending interactions are cancelled on restart. Tailnet exposure gives allowed peers the whole MCP surface. Central (unmerged) admits the owner email for admin routes and machines for sessions (`access_rules.rs:149-155`) and stores machine enrollments. No agent credentials; no per-persona board grants. | registry, agent credentials, authenticated answers, collaboration profiles |
| agent-vm | Standalone Tool Portal admits a fixed configured list of bearer credentials. MCP portal admits a bearer per request and filters tools per agent ID. Google accounts are granted per owner and `allowedAgentIds`. Browser OAuth sign-in and Hermes approvals use Cloudflare Access identity (#231). Credentialed runtimes are fenced per zone and agent with epochs. HMAC approval tokens have no in-tree production minter. | verify backbone agent credentials; profiles per persona; one approval flow per action; hard cutover of legacy approvals |
| AgentStudio | Pane asks and settlement exist in today's app (`PaneContextAskSettlement.swift`). The daemon (Host, Gateway, pairing) is in design; its code is not checked here. | Host as launcher; devices answer approvals as you |
| Cloudflare | Access verifies you and service tokens (no seats; 50 tokens by default). Managed MCP Portal calls upstream with one shared admin credential. Access mTLS is not on the Free plan. | Access in front of our gateway for agents |

## 12. Evidence anchors and standards

- **Router central:** `codex-router.feat-central-one-core/crates/collaboration-central-core/src/access_rules.rs` (owner email, machine class), `registry_contract.rs`; one-core design §0a (machine credential hash custody). Unmerged.
- **Router design:** `codex-router.collab-improvements/docs/specs/2026-10-04-board-orchestration-design/`:
  - U63 mail;
  - spec-3 FL-9 leases, FL-10 takeover;
  - program-design-4-messaging §9, §12;
  - spec 1 E10, E11, RC-8, RL-1/5/6.
- **Router interactions:** `crates/collaboration-service/src/interaction_broker/interaction_history_store.rs`.
- **AgentStudio:** `agentstudio.feat-daemon/docs/specs/2026-10-15-agentstudio-daemon/` (E10, E11, E23–E26, R14, R15, G13; fleet-sync-consumer-fit.md); `Sources/AgentStudio/Core/PaneContext/PaneContextAskSettlement.swift`.
- **agent-vm:** `docs/specs/2026-10-14-portable-tool-portal-hosts/` (Requirements, Specification, Program Design, Verification Design); `packages/config-contracts/src/mcp-portal-approval-policy.ts`; `packages/mcp-portal/src/portal-auth/*`; `packages/agent-vm/src/controller/oauth/google-permission-policy-service.ts`.
- **Cloudflare (verified 2026-10-18):** MCP Portal service-token sessions use the admin credential upstream; service tokens consume no seats; Access mTLS is not on the Free plan.
- **Standards** (prior art, no conformance claimed):
  - OpenID AuthZEN Access Request and Approval Profile, Draft 1 (2026-10-13);
  - Standard Webhooks 1.0.0;
  - RFC 8693 (`sub`/`act`).
- **Council:** [council-summary-2026-10-18.md](council-summary-2026-10-18.md), corrections C-a to C-j (points superseded by D-17 are marked). Board posts 8272–8338 on the concept thread.
