# Fleet Framework: open questions

Every open question on every aspect, written down at the owner's request ("open qkueitowsn on all aspect sshodul be written down"). It is grouped by area.

- **Who decides:** **owner** means only the owner can settle it. A product name means that product's Lead settles it within the framework.
- **State:** open, or *owner-later* when the owner has said it will be designed later.
- **Answered questions** move to the decisions table in the [parent doc](2026-10-18-fleet-framework.md), with the owner's words.

Sources:
- `F-n` are decisions in the parent doc.
- `T-n` and call letters are from the WIP decisions file ([`docs/wip/2026-10-18-fleet-backbone-concepts/decisions-and-open-questions.md`](../../wip/2026-10-18-fleet-backbone-concepts/decisions-and-open-questions.md)).
- Post numbers are on the concept board thread `01a14f55-20c1-753e-823c-6120b2c429b4` or the agent-vm work thread `01a14e9e-ba87-7605-bc7b-7e6eff6ec101`.

## A. Fleet and people

| # | Question | Why it matters | Who decides | State | Source |
|---|---|---|---|---|---|
| Q-A1 | Is the owner the fleet's only administrator, and can other people administer anything at fleet level? | decides who enrolls machines and people, and who can see everything (the admin-trust cost) | owner | open | call A, F-8 |
| Q-A2 | How does a person join the fleet: invited by the admin, or self-registered? | registration flow and identity proof for people | owner | open | F-8 |
| Q-A3 | Household approvals: does either owner approve, or both, for which actions? | approvers for shared-workspace resources | owner | open | call C |

## B. Workspaces and resources

| # | Question | Why it matters | Who decides | State | Source |
|---|---|---|---|---|---|
| Q-B1 | Who may own a workspace (one or several owners), and how does ownership transfer? | F-14 needs "both workspace owners" to mean something definite | owner | open | F-4, F-14 |
| Q-B2 | "Workspace" collides with the daemon's E25 (UI composition). Rename the daemon's to "composition" or "arrangement set" ("layout" already means split geometry there)? | two meanings of one word across specs | owner | open | call B, 8353, 8458 |
| Q-B3 | Are AgentStudio's resources (sessions, terminals, worktrees) fleet workspace resources under the fleet permission model, or does the daemon keep its own permissions, with fleet capabilities only setting the ceiling? | one owner of authorization for Host resources **Proposed narrowing (8557):** the coarse part follows F-33/F-34/F-37: who may log in to a Host is membership of its isolation unit's owner scope (owner, managers, members). The daemon keeps the fine part: controller vs viewer (IP2), attach, kill. The owner is asked only to confirm that split | owner | open | 8458 (daemon option i / ii), 8557 |
| Q-B4 | F-11 says a bot "runs in its own VM … we dont contorl that". Earlier, "vm is part of workspace". Does a workspace still own VMs where its projects live, while bots may run anywhere? And "projects per VM" must not mean a permanent VM identity: today a Router project (E3) is a stable UUIDv7 under one board, worked on **one machine at a time**, keeping its identity and central copy when the holder changes F-39 answers part: workspaces map to machines or VMs; bots on VMs we don't control map only by registration | what "a workspace spans VMs" means now; project identity | owner (meaning), framework + agent-collaboration (mapping) | open | F-11; earlier decision 3; Router spec-1:62–66,102–112, spec-2:51, spec-3:63–64 (8470) |
| Q-B5 | How does work on one VM reach a project on another VM in the same workspace: through MCP file resources, or directly? | the cross-VM access path | agent-vm + daemon | open | blind spot 10 |
| Q-B6 | Who provisions a workspace's VMs and runs them? More pressing after F-34: a new boundary means a new host or VM | some product must own it | owner | open | call E, F-34, 8503 |
| Q-B7 | Sharing a resource into another workspace: to named personas only, or any persona of that workspace? | share model | owner | open | call G |
| Q-B8 | Is the fleet workspace the same entity as Router's E1 Workspace (same UUID), or a distinct resource linked to it? Which spec owns shared workspace meaning, and which owns board-only children? | one workspace noun across products | framework + agent-collaboration | open | Router spec-1:62–66; requirements U23 (8470) |
| Q-B9 | F-27 was answered with team accounts in mind. Does it also cover a **personal** account a person connected to a shared workspace (e.g. the owner's own Gmail in the family workspace), or does that still need its owner's consent? D-17 ("no team bot serving several people's accounts; nobody uses another person's agent") points to the second, unless the owner changes D-17 **Answered by F-35:** personal accounts are excluded | the line between team and personal accounts | owner | answered | F-27, D-17, F-35 |
| Q-B10 | F-11 says a bot's VM is "just wher a bot lives isoalte dor colives". Does that relax D-15 ("the machiens ahve to be private per boudnariy"), letting bots from different boundaries share a machine? The daemon assumes one Host per boundary, with the boundary in E23 Host identity and in immutable UUIDv7 replicated keys (daemon D05). Changing the boundary later means re-keying, and sharing would need isolation per boundary inside a Host, which the daemon doesn't have. **One-way door.** Related to Q-B4 **Answered by F-34:** D-15 holds; each host or VM is its own boundary | machine boundary; daemon keys | owner (daemon affected) | answered | F-11, D-15, F-34, 8494, 8503, 8505 |
| Q-B11 | Moving a machine or VM to another workspace: does it need a wipe, or an explicit handover? Devices you use as clients (phone, laptop) are not workspace machines | machines map to one workspace (F-34, F-39) | owner | open | 8537 |
| Q-B12 | Confirm: a project must not move to a machine in another workspace | project and workspace boundaries | owner | open | 8537, Q-B4 |
| Q-B13 | Naming for the Specification: "boundary" has two senses. Proposed names: **owner scope** (a person or a workspace, D-15's sense) and **isolation unit** (one host OS or VM, which serves exactly one owner scope; F-34's sense, used by daemon E23) | one word, two meanings | framework | open (proposed by 8509, 8557) | D-15, F-34 |
| Q-B14 | F-35 makes team vs personal accounts matter, but nothing says **how an account is classified**: who marks it team or personal (the person connecting it, a manager, the provider's account type), when (at connect time), and whether it can change later | F-27/F-35 can't be enforced without it | owner (rule), agent-vm (mechanism) | open | F-27, F-35, work thread 8508 |

## C. Members, capabilities, personas, agents and bots

| # | Question | Why it matters | Who decides | State | Source |
|---|---|---|---|---|---|
| Q-C1 | What does persona registration look like, so it's easy (F-12)? Who registers, and with which config, through agent-vm's Tool VM configuration? | the owner's ease-of-registration requirement | agent-vm, with owner review | open | F-12 |
| Q-C2 | Fleet "capability" (a bundle or permission) vs agent-vm Spec E3 "Capability" (one invocable tool): the framework says "tool" for a single one. Does agent-vm rename E3, or keep it with a mapping note? | one word, two meanings across specs | agent-vm | open | 8460 flag 1, call H |
| Q-C3 | Fleet "agent session" vs agent-vm E9 (conversation correlation), the daemon's E9 (provider conversation) and Router's E10 (a declared SessionRef or HumanId, with the verified writing installation recorded separately): how do they map, distinguishing persistent bot, session actor, registrant/effective authority and verified calling principal, without treating a native conversation ID as an authenticated principal? Also name the execution mapping: fleet "execution environment" (F-6: a VM or unit) is not daemon E1 "Execution session" (one terminal or process session; many run in one environment); daemon E23 "machine/work environment" ≈ fleet "execution environment". **Owner input (F-40):** two families. Proposed reading (8537): a coding agent is identified by its session ID as reported by the agent-collaboration install on its machine; a persistent bot is identified as the bot, registered into a workspace (F-10). **Constraint (8546):** the Router already keys coding actors by the full SessionRef (Router ServiceId + provider EndpointId + native SessionId; board_identity.rs:186–213, project_actor_rows.rs:25–65). The native ID alone isn't unique. Keep that key, and add the fleet registry link as a separate association rather than re-keying; holding the string still doesn't prove ownership of the session (Q-E1). The daemon confirms: E9/E10 reference the full SessionRef through the daemon's own UUIDv7 association, never re-keying it (8557; daemon D05) | identity mapping across specs | framework + agent-vm + daemon + agent-collaboration | open | 8460 flag 2, 8458, 8470 (Router PD1:112–118, spec-3:138–145), 8494, 8537, F-40 |
| Q-C4 | How is effective scope carried into agent-vm's complete assignment, with verified revisions? Per F-32, a call's scope is what **the workspace it names** allows that agent (persona ∩ that workspace's grant); the bot's other workspaces don't widen it | prevents a copied label standing in for a grant | framework + agent-vm | open | 8460 flag 4 |
| Q-C5 | Who may change a persona, and does a change need the workspace owners' consent when it widens tools? | consent never silently widens | owner | open | council C-c |
| Q-C6 | Is Grok the owner's chief of staff (inside, as a workspace bot), or an external bot reached through a channel? | Grok is xAI-hosted (F-7, F-19), but the chief of staff is the owner's own (F-16) | owner | open | call K, F-16 |
| Q-C7 | Who may switch a running agent's role, and how is that control expressed? | F-3 says it's controlled | owner | open | F-3 |
| Q-C8 | Does a bot registered into several workspaces get each workspace's tools through a separate registration? And does "bot as its registrant" (F-15) hold when a bot is shared? | multi-workspace bots | owner | **answered by F-32:** union of tools; each call names a workspace, which must allow the tool; attribution and mistake-catching, not a security partition. Remaining: does F-15 hold for a shared bot | F-10, F-15, F-32 |
| Q-C9 | "Role" has a second meaning: Router E11 is a subject-scoped **appointment to an actor** (grant history, cardinality, separation of implementer, verifier and reviewer). Loading an "implementer" persona is not that appointment. How do persona (F-2) and E11 appointment map and get named, without replacing E11 or inferring grants from a role label? | one word, two meanings | framework + agent-collaboration | open | F-2; Router spec-1:98,111–112, authority_roles.rs:124–202 (8470) |
| Q-C10 | ~~Does "bot treated as its registrant" change authorization, attribution, or both?~~ **Answered by F-23:** the registered thing is an agent in a harness, and managers configure its tools. Attribution is answered in direction by F-30: the agent, on behalf of whoever the channel can identify. Remaining: how the requester is carried through, and what "on behalf of" shows when no channel asked (scheduled or background work) | accountability | owner | owner-later (pass-through) | F-15, F-23, F-30 |
| Q-C11 | What is agent-vm's **fourth tool bucket**? The owner remembered: useful cloud services, cloud integrations, computer tools. agent-vm's docs name only three resource groups: ordinary remote MCPs, protected cloud services, configured computer services (`docs/specs/2026-10-14-portable-tool-portal-hosts/requirements.md:5`). The three backend kinds (`tool-portal-config.ts:105`) are a separate execution axis and don't identify the missing bucket (agent-vm Lead, DM 01a151a8). Unknown until the owner recalls it | the bucket model for workspace subsets | owner | open | F-24 |
| Q-C12 | **Managers:** ~~per workspace or per agent?~~ **Per workspace (F-29).** Remaining: can managers add other managers? What can a manager change: tools, collaboration defaults, membership? | who configures agents (F-23) | owner | partly answered | F-23, F-29 |
| Q-C13 | **Groups and defaults:** build on agent-vm's existing catalog presets (ceilings, e.g. `all-supported`) and versioned collections (defaults, e.g. `read-only-assistant`; `oauth-config.ts:88`), extended from Google to all four buckets plus agent-collaboration defaults? | easy configuration (F-24) | agent-vm, with owner review | open | F-24; `docs/reference/configuration/examples/tool-portal-google-policy.config.jsonc:179` |
| Q-C14 | **Acts for:** a coding agent acts for its machine's workspace, on behalf of whoever started it (F-30). Pending the owner's yes (8537) | who a coding agent works for | owner | open | F-38, F-40, 8537 |

## D. Channels and messaging (agent-collaboration designs the details, per F-13)

| # | Question | Why it matters | Who decides | State | Source |
|---|---|---|---|---|---|
| Q-D1 | What does a channel connect: member to member, workspace to workspace, or both? Who can withdraw consent to it? | the core channel noun and its lifecycle | framework + agent-collaboration | open | F-13, 8470 |
| Q-D2 | Inside one workspace, may any member message any other, or are channels granted there too? | default permission inside a workspace | owner | open | F-13, F-21 |
| Q-D3 | Once both owners agree to a cross-workspace channel (F-14), which members on each side may use it? | scope of the agreement | owner | open | F-14 |
| Q-D4 | Can a channel carry requests that ask for action, or only messages? Requests still pass tool admission and approval | messaging vs acting | owner + framework | open | call F, 8367, 8368 |
| Q-D5 | How are AgentStudio's E11 notices and asks related to fleet mailboxes and interaction kinds: the same thing, or projected? Today agent-to-human notices and asks go through AgentStudio's own path (hooks call the AgentStudio RPC; daemon spine:31), not agent-collaboration. Does F-13 ("all agents message thorukgh agent-collabpraiton") cover messages from agents to people, or only agent-to-agent messages? **F-31 answers the scope:** agent-collaboration is a channel to AgentStudio, and hooks are another. Remaining: is E11 a fleet interaction kind with the Host settling it, or daemon-only and projected? | one owner of human-facing messages | framework + daemon (mapping) | partly answered | 8458 item 5, F-13, F-31, 8494 |
| Q-D6 | External channels: which kinds come first (Telegram, email, Muse or Grok connectors, webhooks), and how is the far end authenticated? | external is a channel (F-9) | owner (which kinds), agent-collaboration (how) | owner-later | F-9, F-16 |
| Q-D7 | Inbox classifier (Jev): what it decides, what it may drop, and how it routes to "the right agent" | every external message passes it | owner | owner-later | F-16 |
| Q-D8 | Outbox classifier: what it checks before a message leaves | outbound disclosure | owner | owner-later | F-16 |
| Q-D9 | Workspace chief: what it is (agent, rules, or a person approving) and what it decides | the per-workspace inbox system | owner | owner-later | F-16 |
| Q-D10 | Chief of staff: what it delegates, and to whom, across the owner's workspaces | the owner's single delegate | owner | open | F-16 |
| Q-D11 | Delivery semantics: ordering, retries, whether a message can start an agent's turn, read state | the product contract for messages | agent-collaboration | open | F-13 |
| Q-D12 | ~~Does a same-fleet cross-workspace message pass the classifier?~~ **Answered by F-25:** one classifier for all inbound, configured by sender level. Remaining: the exact levels, and each level's default policy | classifier configuration | owner (levels), agent-collaboration (mechanism) | partly answered | F-25 |
| Q-D13 | ~~What happens to queued messages on revocation?~~ **Answered by F-26:** dropped. Remaining product details: is the sender told? What "delivered" means (central fetch, local custody, carrier acceptance, read by the model or a person)? Which channel or membership grant each queued message is tied to? Where revocation is checked: before any attempt that could first hand the message over, including releasing a held message, on both remote and same-machine paths? How it is ordered against a delivery already in flight? Already-accepted and uncertain outcomes are kept, and a missing report never counts as a successful drop. Closing a machine's mailbox is not the mechanism: it is machine-wide and misses messages already fetched | revocation behavior | agent-collaboration | answered (details open) | F-26; concept thread 8489, 8498 |
| Q-D14 | How does the logical **member mailbox** (F-21) map to today's transport-custody mailbox **per installation** (Router PD4:46,103,148), with continuity for already-persisted recipient resolution and statuses (spec-1 E18:119; PD4:142–148)? These can coexist; they are not the same id | mailbox identity | framework + agent-collaboration | open | F-21 (8470) |
| Q-D15 | Attaching to a terminal is an **unfiltered output channel**: anyone attached (the daemon's controller and viewers, IP2) sees everything the agent prints, and E11 copies reach the Host's Gateways (daemon R15, spine:144). Under F-13 and F-21, who may attach to or view a workspace bot's terminal: any member, managers only, or the bot's registrant? Is attaching a channel under the same permission model? **Answered by F-33:** only the owner, managers or members, through the SwiftUI app. Remaining: is attaching modelled as a channel (daemon) | a side channel around channel permissions Attach is modelled as console access into an execution environment, not an agent-collaboration channel (Daemon Advisor 8557; the daemon Lead's call). Unfiltered output is acceptable because the audience is the isolation unit's own people (F-33 with F-6) | daemon | answered | F-6, F-13, F-21, F-33, 8494, 8557 |

## E. Identity and attestation

| # | Question | Why it matters | Who decides | State | Source |
|---|---|---|---|---|---|
| Q-E1 | How does the local Router bind a calling connection to a session (per-session token, or the connecting process's ID), and what persona rule applies to terminal-started sessions? | turns a session address into an attestation | agent-collaboration | open | concepts §6.6 (WIP) |
| Q-E2 | How does an agent's credential reach the cloud MCP gateway through Cloudflare Access? | agent identity at the gateway | agent-vm (D2) | open | T-1, T-2 |
| Q-E3 | How do bots outside our machines (vendor-hosted, registered per F-10) prove who they are? | registered external bots | agent-collaboration + agent-vm | open | T-8 |
| Q-E4 | Who may authorize a launcher, and what does enrollment consent cover? | launcher enrollment | owner | open | T-5 |
| Q-E5 | How fast must revocation reach each checkpoint? | revocation freshness | owner (tolerance) | open | T-6 |
| Q-E6 | Cloned VMs must not act as the original | clone fencing | agent-collaboration + daemon | open | T-7 |
| Q-E7 | **Established baseline:** central's machine enrollment already stores a credential hash, keyed by a stable v7 PeerId mapped to the existing ServiceId (one-core PD:103–110; machine_enrollment.rs:32–39,457–473). Open only what the new agent and person credential model adds or changes. Don't broaden the broker's recoverable provider-secret custody into recoverable machine credentials | custody of new credential kinds | agent-collaboration | open (baseline established) | T-10, 8470 |
| Q-E8 | Fresh human gesture (e.g. Face ID) vs device key for critical approvals | approval proof strength | owner | open | T-9 |
| Q-E9 | Register a machine once, in the fleet, with the AgentStudio Host as a service under it; or register it separately in AgentStudio too? (The Daemon Advisor advised once; the owner asked.) Today's EnrollMachine enrolls a Router installation (ServiceId, label, Access client ID, credential hash, expiry; machine_enrollment.rs:32–40) with no workspace or isolation-unit association. It must not silently become the Host/VM identity or the one-workspace placement | one machine identity | owner | open | F-39, 8537, 8546 |

## F. Approvals and interactions

| # | Question | Why it matters | Who decides | State | Source |
|---|---|---|---|---|---|
| Q-F1 | Approvals are accepted only from an authenticated person through the fleet inbox, never through a bot's channel. The owner hasn't confirmed this | stops a bot's channel approving its own request | owner | open (provisional) | holes discussion |
| Q-F2 | For cloud → Mac calls: set approval modes centrally, with machines only stricter (a floor), or separately per machine? | one prompt per action | owner | open | call I, agent-vm D3 |
| Q-F3 | Where the approval decision is recorded; automatic continuation vs retry | the approval protocol | agent-vm (D3) | open | T-3 |
| Q-F4 | Auto-judge: where it runs, its limits | "auto" mode | owner + agent-vm | open | T-16 |
| Q-F5 | Harness-native prompts (Codex / Claude Code permissions) stay with each harness? | scope of approvals | owner | open | call J |
| Q-F7 | The F-28 audit log: which events count as security or permission changes; whether each action owner writes its own log or there is one shared log; who can read it; how long it is kept | an audit trail across three products | framework + each product; owner for readers and retention | open | F-28 |
| Q-F8 | **Audited commit:** is a security or permission change written in the same commit as its F-28 audit event, so neither can exist without the other? Which product owns that commit for each kind of change (tool policy in agent-vm, membership and channels in agent-collaboration)? | F-28 says "always"; a change without its event breaks that | framework + each product | open | F-28, Q-F7 |
| Q-F9 | ~~Where does the chat's agent run, and may changes auto-apply?~~ **Answered by F-43:** chat in the app as generative UI from a fast model; every change waits for the owner's Accept or Deny (no auto-apply). Remaining: which model, now narrowed by F-44 to cheap fast candidates (Luna, Haiku, an OpenRouter model, or Jev for choice-based composition), to be tried in the F-45 mock; whether the surface is a conversation or a single-shot request bar; which service makes the model call (it gets no authority either way); what current state the model may read in order to propose (F-20 allows the model provider to see context). Every option still needs the configuration API (typed operations, manager check, preview, audit write) | how settings change | owner (model choice); agent-vm (API, model call placement) | partly answered | F-41, F-43, work thread 8729 |
| Q-F6 | Are AgentStudio apps (plus web) the inbox clients for all interaction kinds? | new daemon scope | owner | open | call M |

## G. Execution environments and memory

| # | Question | Why it matters | Who decides | State | Source |
|---|---|---|---|---|---|
| Q-G1 | How VMs work as execution environments | details deferred | owner | owner-later | decision 10 |
| Q-G2 | Memory systems: per-bot memory and files-as-memory are assumed; any shared memory design | deferred | owner | owner-later | F-18 |
| Q-G3 | Which AgentStudio capabilities are gated by leases | lease scope | daemon | open | T-13 |
| Q-G4 | Ambient credentials on a VM bypass MCP approvals. Accepted under workspace safety (F-17), or must credentials stay in the broker? | effect control outside MCP | owner | open | holes item 3 |

## H. Requirements themselves

| # | Question | Why it matters | Who decides | State | Source |
|---|---|---|---|---|---|
| Q-H1 | The three products build in parallel, so this is about **scope**, not order: which needs must the first working version have, and which can wait? (Plain list A–G in chat) | Requirements priorities | owner | open | chat; owner: "would we not build in h1 paralel they are 3 systems?" |
| Q-H2 | One or two situations the owner wants to see working end to end | acceptable outcome-level evidence | owner | open | chat |
| Q-H3 | Standards and cost limits: no paid seats per agent; follow standards. Carry them as Requirements limits? | limits | owner | open | O7 |
