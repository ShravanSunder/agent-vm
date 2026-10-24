# Agent identity and workspace access: Specification

What must be observably true about who acts, how each identity is proven, which workspace it belongs to, and how tool access is granted and removed. Authority: [Requirements](requirements.md). Structure: [Program Design](program-design.md). Proof: [Verification Design](verification-design.md).

## Who uses this, and where they see it

```mermaid
flowchart LR
  O[Owner / admin] -->|admin console: workspaces, machines and their allowed workspaces,<br/>bots and their membership, workspace pairs, lookups| SYS
  PP[Person] -->|sign in| SYS
  BOT[Bot] -->|sign in with its own credential| SYS
  FS[Fleet harness session<br/>on an enrolled fleet machine] -->|agent-collaboration calls,<br/>vouched for by its machine| SYS
  SYS[(Agent identity and workspace access<br/>fleet, sign-in service, Tool Portal<br/>shown as one system)]
  SYS -->|workspace tokens, members only| MCP[Each workspace's MCP address<br/>at the Tool Portal]
  BOT -->|tool calls, only if a member| MCP
  FS -->|tool calls for its project's workspace| MCP
  X[Collaborator of W] -.->|refused: W's tools| MCP
```

## Problem today

| ID | Problem | Where it shows |
|---|---|---|
| P1 | The fleet cannot name an agent. Its central service knows only a machine or the owner, and an agent-collaboration call's sender is whatever the call claims. | Fleet code: `AccessCaller {Machine, Owner}`. Live runs on Codex, Claude and Cursor stored a session claiming to be another as that other session. |
| P2 | The Tool Portal's agents are separately registered clients holding their own secrets, with no connection to the fleet's sessions. | Draft PRs #263 and #262 compared with the fleet. |
| P3 | Nothing records which workspace an identity belongs to or may talk to. A session's workspace is only guessed from its working directory, and any declared session can join any thread. | Fleet code: the context lookup from the working directory; thread seats only. |
| P4 | Self-contained tokens keep working after a removal until they expire. | Inherent to token-only checking. |
| P5 | Sessions on one open machine can read each other's work, and nothing shows it. | Same OS user on the owner's machines. |

## Outcomes

| ID | Outcome | Success condition |
|---|---|---|
| O1 | Every acting identity is one of three kinds and is attributed correctly. | A false sender is refused. Every grant and record names a kind and an ID. |
| O2 | Only members of W use W's tools, within their persona. Collaborators only message. | A collaborator's tool call is refused. A member's allowed call is admitted. |
| O3 | The owner can see each identity's workspace and each machine's shared bucket. | Lookups answer for every identity and machine. |
| O4 | A removal stops the next call once pushed, and expiry is the backstop. When the fleet's truth is unavailable, the system fails closed. | As in R16, R18–R21 and R25. |
| O5 | The same behavior holds on Cloudflare and on any other host. | The same obligations pass on both. |

## Entities

The entity table is the normative home. Program Design binds each entity to its storage and wire shapes.

| ID | Term | Identity rule | Relationships | Invariants | Observable states | Canonicalizes | Basis |
|---|---|---|---|---|---|---|---|
| E1 | **Organization** | Its organization ID. | Has 0..n E2. Has an owner and the people allowed to sign in. | Organizations never share members, sessions or records (sign-in R19). | active | sign-in E12; Tool Portal E1 | U20, D2, F-82 |
| E2 | **Workspace** | Its workspace ID: the fleet's existing UUIDv7, kept as is. | Belongs to exactly one E1. Has 0..n E16, E8, E9, E10, E15 and E17. Has one MCP address at the Tool Portal. | Its ID never changes. | active, archived | Tool Portal E2; the fleet's workspace record | U10, U15, F-73 |
| E16 | **Project** | Its project ID: the fleet's existing project. | Belongs to exactly one E2, through its board. Has 0..n E7 started for it. | Never moves to another workspace without its sessions ending. | active, retired | the fleet's project-directory entry | U6 |
| E3 | **Person** | Their sign-in account in one deployment (sign-in E2). | May sign in to the E1s that allow them. Has 0..n E8. | Never a bot or a session. | as in the sign-in design | sign-in E2 Person | U1, U20 |
| E4 | **Bot** | Its bot ID, assigned once when the admin registers it. A bot that registers again is a new bot unless the admin restores the old one. | Belongs to the E1 that registered it. Has 1..n E5, at most one E8, 0..n E9 and 0..n E18. | Never a member of two workspaces. Its internal agents act as the bot and are not identities here. Its bot ID is not any of its credentials' client IDs. | registered, retired | "bot", "external agent", sign-in E9 Agent client | U1, U2, U5 |
| E5 | **Bot credential** | Its client ID. | Belongs to exactly one E4. | How the bot stores the secret is unknown to the system, and the system says so. | active, retired | sign-in E9's client credentials | U2 |
| E6 | **Fleet machine** | Its fleet enrollment: one Router installation the owner enrolled. Re-enrolling is a new enrollment. | Runs 0..n E7. Has 0..n E15. | Proves itself only through its existing enrollment, with no new key. | enrolled, revoked, expired | "enrolled machine", "Router installation", "peer" | U3, U17, U21 |
| E15 | **Machine allowance** | The pair of one E6 and one E2. | Belongs to one E6 and one E2. | Only the admin grants or withdraws it. | active, withdrawn | "machine access", "the machine serves the workspace" | U6, U21 |
| E7 | **Fleet harness session** | Its session reference: its machine's installation, plus its harness endpoint (Codex, Claude or Cursor), plus its conversation ID. A new conversation is a new session. | Runs on exactly one E6. Was started for exactly one E16. Holds exactly one E8, in that project's workspace. Has exactly one E13. | Holds no secret. Never logs in. Accepted only as vouched for by its machine. Its machine has an active E15 for its workspace. Once removed or ended, its membership ends and no grant is decided for it again. | active, removed, ended | "agent" (as an identity), "Router session" | U1, U3, U6, U19 |
| E8 | **Membership** | The pair of one workspace and one identity (E3, E4 or E7). | Belongs to one E2 and one identity. Names one E10, or the session default for a session. | A bot or session has at most one active membership; a person may have several. A session's membership is in its project's workspace. | active, removed. A persona change keeps the membership with a new persona. | sign-in E11 Workspace link; the Tool Portal's member record | U4, U5, U6, U10 |
| E9 | **Bot collaboration** | The pair of one bot and one workspace. | Belongs to one E4 and one E2. | Never grants tools or starting work. Never held together with a membership in the same workspace. | active, withdrawn | "correspondent", "collaborator" (for a bot) | U4, U5, U7 |
| E17 | **Workspace pair** | An ordered pair: a from-workspace and a to-workspace. | Belongs to two E2s in one E1. | It lets members of the from-workspace message members of the to-workspace, and nothing more. It never grants tools or starting work. | active, withdrawn | "Personal may message OSS" | U8 |
| E10 | **Persona** | Its name within one workspace. | Defined by the Tool Portal for an E2. One per workspace is marked the **session default**. Named by 0..n E8. | Says which tools it makes available and which of them may run without approval. A name that is not defined allows nothing. A session's effective persona is what both its workspace's current session default and any persona its starter named allow (R9). | defined, withdrawn | Tool Portal persona; "tool profile" | U10, U11 |
| E11 | **Workspace token** | Its token ID. | Names one E2, one E1, one identity (E4 or E7), and one E10 or the session default. For an E7, also its E6, its machine environment, its E16 and its E13. Carries its grant's place in its organization's order (its grant mark) and its grant expiry. | Issued only to an active member. Unusable after its grant expiry: the moment its grant was decided plus the configured lifetime, never more than 60 minutes after that decision, however late it was minted. | valid, expired, rejected | sign-in E10 Agent proof | U10, U12 |
| E18 | **Collaboration token** | Its token ID. | Names one E4 and its E1. Names no workspace and no persona. | Issued only to a registered bot presenting an active credential. Accepted only by the fleet's collaboration service, never by the Tool Portal. Grants no tools. Same lifetime rules as E11. | valid, expired, rejected | — | U2, U7 |
| E12 | **Removal notice** | Its notice ID. | Names one E2, one identity (or one E6, for every session on it), and the removal's place in its organization's order (its removal mark). | Covers every token for that identity in that workspace whose grant mark is before its removal mark, however late the token was minted. A notice received later with an earlier mark never lowers what is covered. | pending, acknowledged, lapsed | "pushed removal", "reject entry" | U13 |
| E13 | **Isolation record** | Its session. | Belongs to exactly one E7. Names its E6, its machine environment (physical or cloud VM), its isolation kind (`Host`, `ProcessSandbox`, `Container` or `Vm`), and an instance ID minted at launch, whatever the kind. | Asserted by what launched the session; nothing proves it. Recorded at launch and never changed. | recorded | "room"; the proposed `AgentIsolation` and `MachineEnvironment` | U18 |
| E14 | **Shared bucket** | One fleet machine, derived. | For one E6: the E2s that have had member sessions with isolation kind `Host` on it. | Derived from E7 and E13. Shown, never enforced, in the first round. | as derived | "leaky bucket" | U18 |

```mermaid
erDiagram
  E1_ORGANIZATION ||--o{ E2_WORKSPACE : contains
  E2_WORKSPACE ||--o{ E16_PROJECT : contains
  E2_WORKSPACE ||--o{ E8_MEMBERSHIP : has
  E2_WORKSPACE ||--o{ E10_PERSONA : defines
  E2_WORKSPACE ||--o{ E17_WORKSPACE_PAIR : "from / to"
  E6_FLEET_MACHINE ||--o{ E15_MACHINE_ALLOWANCE : "allowed to serve"
  E15_MACHINE_ALLOWANCE }o--|| E2_WORKSPACE : for
  E6_FLEET_MACHINE ||--o{ E7_FLEET_HARNESS_SESSION : "runs, vouches for"
  E7_FLEET_HARNESS_SESSION }o--|| E16_PROJECT : "started for"
  E7_FLEET_HARNESS_SESSION ||--|| E8_MEMBERSHIP : "exactly one"
  E7_FLEET_HARNESS_SESSION ||--|| E13_ISOLATION_RECORD : records
  E4_BOT ||--|{ E5_BOT_CREDENTIAL : "proves with"
  E4_BOT ||--o| E8_MEMBERSHIP : "at most one"
  E4_BOT ||--o{ E9_BOT_COLLABORATION : has
  E4_BOT ||--o{ E18_COLLABORATION_TOKEN : "messages with"
  E3_PERSON ||--o{ E8_MEMBERSHIP : "may hold several"
  E8_MEMBERSHIP }o--|| E10_PERSONA : names
  E11_WORKSPACE_TOKEN }o--|| E8_MEMBERSHIP : "issued only for an active one"
  E12_REMOVAL_NOTICE }o--|| E2_WORKSPACE : "covers tokens of"
  E6_FLEET_MACHINE ||--|| E14_SHARED_BUCKET : "derived view"
```

## Obligations

### Identity and proof

| ID | Obligation | Over | Traces to |
|---|---|---|---|
| R1 | Every identity the system grants anything to, or records as acting, MUST be exactly one of: person (E3), bot (E4), fleet harness session (E7). | E3, E4, E7 | U1, P1, O1 |
| R2 | A fleet harness session MUST be accepted only as vouched for by the enrolled fleet machine it runs on. The session presents no secret. A revoked or expired machine vouches for nothing. | E6, E7 | U3, U17, P1, O1 |
| R3 | When an agent-collaboration call arrives from a fleet harness session, it MUST be recorded as coming from the session whose binding it arrived on. If the call names a different session as its sender, it MUST be refused and nothing recorded. The binding that tells sessions apart is a capability held in the machine's own harness configuration, not a secret the session proves: on one machine user, a process that obtains another session's binding can act as that session. That is the shared-bucket limit (E14, U18), accepted for the first round; this obligation does not separate sessions on one machine from each other. | E7 | U19, U18, P1, O1 |
| R4 | A bot MUST be accepted only when it presents an active credential registered to it. Each bot's record MUST show that its proof depends on the bot's own secret storage. | E4, E5 | U2, O1 |
| R5 | Person sign-in and organizations MUST behave as the people sign-in design states (its R1–R4, R9, R12, R14, R19 and R20). | E1, E3 | U20 |

### Membership and collaboration

| ID | Obligation | Over | Traces to |
|---|---|---|---|
| R6 | A bot MUST be a member of at most one workspace. Only the admin creates, changes or removes that membership. Any other relationship a bot has to a workspace is a bot collaboration (E9). | E4, E8, E9 | U5, P3, O2 |
| R7 | A fleet harness session MUST be a member of exactly one workspace: the workspace of the project it was started for. It is recorded at start and never changes for that session. A session's repository or working directory MUST NOT decide its workspace. | E7, E8, E16 | U6, P3 |
| R8 | Starting a fleet harness session for a project in W MUST be refused if its machine has no active allowance for W. **Gap (OD1):** who may start a session for W. Recommended: the owner, or a session already a member of W. | E6, E7, E15 | U6, OD1 |
| R9 | A session's effective persona MUST be what both W's current session-default persona and the persona its starter named, if any, allow: a tool is available only if both make it available, and it runs without approval only if both let it. The effective persona MUST NEVER make available a tool, or allow a call without approval, that W's current session default does not. A named persona W does not define allows nothing. When the session default changes, the change applies from the next call. | E8, E10 | U11 |
| R10 | A person MAY be a member of any number of workspaces in organizations they may sign in to. Only the admin manages person membership. | E3, E8 | U20, U21 |
| R11 | A bot with an active bot collaboration in W MAY send messages and tasks to W's members. It MUST be refused W's tools, starting work in W, and board roles in W. It proves itself to the fleet's collaboration service with a collaboration token (C6), never with a workspace token. **Gap (OD3):** whether a bot collaboration exists for every workspace in the bot's organization other than its member workspace, or only where the admin allows it. Recommended: only where the admin allows it. | E9, E18 | U7, U2, O2, OD3 |
| R12 | A member of workspace A MAY message members of workspace B only while an active workspace pair A→B exists. Otherwise the message MUST be refused. A workspace pair never grants B's tools, starting work in B, or board roles in B. | E17 | U8, U7 |
| R13 | Only the admin MAY register bots and set their membership or collaboration, allow or withdraw machine allowances, allow or withdraw workspace pairs, create workspaces, and read the lookups (R14). Enrolling and revoking machines act across organizations, so only the fleet's operator MAY do them, under the fleet's existing operator authority; no organization's owner gains it. The admin is the active owner of the organization the action belongs to, signed in to that organization and current there, confirmed at the time of the action as the people sign-in design's R9, R19 and R20 require. Anyone else MUST be refused with nothing changed and nothing revealed: another member of the organization, another organization's owner, an owner whose own entry was removed, a session no longer current, a bot, or a fleet harness session; and, for enrolling or revoking a machine, any organization owner who is not the fleet's operator. | E2, E4, E6, E8, E9, E15, E17 | U21, U20, F-78 |
| R14 | For any identity, the system MUST answer its kind, its member workspace and persona, and its collaborations. For a session, it also answers its machine, project and isolation record. For any workspace, it answers its members, bot collaborators, workspace pairs and allowed machines. For any machine, it answers its allowed workspaces and its shared bucket. For any removal, it answers whether every affected workspace has acknowledged it. | E2–E18 | U9, O3 |

### Tokens and tool calls

| ID | Obligation | Over | Traces to |
|---|---|---|---|
| R15 | Only an active member of W MUST receive a workspace token for W. The token MUST name the issuer, the audience (W's MCP address), the workspace, the organization, the identity's kind and ID (for a session, its whole session reference), the persona (a name, or the session default), its grant mark, the issue time, the expiry and the grant expiry. For a session it MUST also name the machine environment, the project and the isolation record. A token that names a session MUST come only through the fleet's session issuance. | E11, E8 | U10, O2 |
| R16 | A workspace token MUST be unusable after its grant expiry: the moment its grant was decided, on the fleet's clock, plus the configured lifetime. No leeway MAY be added to the grant expiry when a token is checked. Minting it later, retrying, or presenting the same decision again MUST NOT extend that moment. A grant decision not minted within the redemption window, at most 60 seconds after it was decided, MUST mint nothing. The admin MUST be able to set the configured lifetime, and it MUST NOT exceed 60 minutes. Its default is 5 minutes (OD2: the Lead's proposed default, not yet the owner's choice). | E11, E18 | U12 |
| R17 | The Tool Portal MUST admit a call on W's MCP address only with a valid workspace token for W: before both its expiry and its grant expiry, naming W's workspace and W's organization, not covered by any received removal notice, and only for tools its effective persona allows (R9). It MUST NOT call the fleet to decide a call. | E10, E11, E12 | U10, U12, O2 |
| R18 | Issuing a workspace token MUST consult the current truth once. If the identity is not an active member of W at that moment, no token is issued. For a session, a removed or ended session, or a machine without an active allowance for W, also gets no token. | E8, E11, E15 | U14, U15, O4 |

### Removal

| ID | Obligation | Over | Traces to |
|---|---|---|---|
| R19 | When a membership ends, a persona changes, a bot or bot credential is retired, a machine is revoked, a machine allowance is withdrawn, or a session is removed or ended, the fleet MUST send a removal notice to the Tool Portal for each affected workspace. From the moment each affected organization records the removal (for a machine revocation, when the revocation reaches that organization), no new grant MUST be decided there for the removed access, even while notices are on their way; every grant decided there before that moment MUST be covered by its notice. A revoked machine MUST also open no new enrolled connection from the moment the fleet records the revocation. From receipt, the Tool Portal MUST refuse every token the notice covers. The admin MUST see the removal as pending until every affected workspace has acknowledged it. | E8, E12, E15 | U13, P4, O4 |
| R20 | Each grant decision and each removal MUST hold its own place in its organization's order. A removal notice MUST cover every token for that identity in that workspace whose grant was decided before the removal, however late the token was minted. A token whose grant was decided after the removal, with any new persona, MUST be accepted. A machine notice covers every session on that machine. A notice delivered later than another for the same identity and workspace, with an earlier removal mark, MUST NOT lower what is covered. | E11, E12 | U13 |
| R21 | The fleet MUST resend a removal notice until the Tool Portal acknowledges it. The Tool Portal MUST acknowledge a notice only after recording it durably. The Tool Portal MUST keep each notice until every token it covers has passed its grant expiry: at least the 60-minute maximum lifetime plus the allowed clock difference (at most 60 seconds) after receipt, by its own clock. The fleet's and the Tool Portal's clocks are assumed to differ by at most 60 seconds. It MUST still apply notices after a restart. | E12 | U13, O4 |
| R22 | The Tool Portal MUST accept removal notices only from the fleet. A notice from anyone else MUST be refused and change nothing. | E12 | U13, U15 |

### Machines and exposure

| ID | Obligation | Over | Traces to |
|---|---|---|---|
| R23 | Each session MUST record its isolation record at start, as asserted by what launched it. For each machine, the system MUST show which workspaces have had member sessions with isolation kind `Host` on it (its shared bucket). Nothing MUST be refused on the basis of the isolation record in the first round. | E7, E13, E14 | U18, P5, O3 |
| R24 | No new private key MAY be created on, stored on, or required from a fleet machine for any obligation in this set. A machine proves itself only through its existing enrollment. | E6 | U17 |

### Hosts, outages and service requests

| ID | Obligation | Over | Traces to |
|---|---|---|---|
| R25 | While the fleet's truth cannot be consulted, no workspace or collaboration token MUST be issued, and a grant decided before the outage mints nothing after its redemption window. The Tool Portal MUST refuse each call once its token's expiry or grant expiry has passed. No grant MAY be extended on stale information. | E11, E18 | U14, O4 |
| R26 | Every interaction between the fleet, the sign-in service and the Tool Portal MUST use one versioned contract whose meaning does not depend on the host. Each service MUST behave the same on Cloudflare and on a non-Cloudflare host. | all | U16, O5 |
| R27 | Every request between the fleet, the sign-in service and the Tool Portal (C7) MUST be authenticated as coming from that edge's one expected caller, for that one operation, to the receiving service. A request from another caller, for another operation or another receiving service, with an expired credential, or naming an organization or workspace its caller may not act for, MUST be refused and change nothing. Repeating an accepted request MUST have no further effect beyond what C7 states for that operation. | all | U13, U15, U16 |

## Observable contracts

### C1 Workspace token

| Field | Meaning |
|---|---|
| issuer | The sign-in service |
| audience | W's MCP address, derived from the Tool Portal's configured origin and never from a request's Host |
| workspace, organization | E2 and E1 IDs |
| principal | The identity's kind (`bot` or `fleetHarnessSession`) and its ID: a bot's E4 ID, or a session's whole session reference |
| persona | An E10 name, or the session default |
| machine environment, project, isolation | For a session only: from E13, E16 and E13 |
| issued at, expires at | When it was minted, and the expiry the issuer stamped |
| grant expires at | The moment its grant was decided plus the configured lifetime (R16). Never later than 60 minutes after the decision |
| grant mark | Its grant's place in its organization's order |

**Accepted:** the signature verifies against the issuer's published keys; the audience is W's address; the workspace is W and the organization is W's organization; the time on the Tool Portal's clock is before the grant expiry, with no leeway, and before the expiry, allowing at most 60 seconds; for a session principal, the token came through the fleet's session issuance and its machine is its session reference's installation; no received removal notice covers it (a notice for its principal, or its machine, whose removal mark is after the token's grant mark).

**Refused, before any tool runs:**

- **as unauthenticated:** no token, a bad signature, the wrong audience, a workspace or organization that isn't W's, a session token not issued through the fleet's session issuance, an incoherent session (its machine not its installation), or a token past either expiry;
- **as not permitted:** a token covered by a removal notice, or a tool its effective persona does not allow (R9).

### C2 Token issuance

| Outcome | When |
|---|---|
| issued | An active member, the identity is proven (R2 or R4), the truth was consulted, the grant was decided less than the redemption window ago, and for a session it is active and its machine is allowed to serve W |
| refused: not a member of W | No active membership, including a collaborator of W, and a removed or ended session |
| refused: identity not proven | An unknown bot, a retired credential, an unenrolled or revoked machine, or a session its machine did not vouch for |
| refused: machine not allowed for W | A session whose machine has no active allowance for W |
| refused: unavailable | The truth could not be consulted, or the decision passed its redemption window before minting (R16, R25) |

### C3 Removal notice

**Fields:** notice ID, workspace, the identity (kind and ID, or a machine for every session on it), the removal mark (the removal's place in its organization's order), and reason class (membership ended, persona changed, bot retired, credential retired, machine revoked, allowance withdrawn, session removed, session ended).

**Coverage:** a notice covers a token for its identity (or for any session on its machine) in its workspace when the token's grant mark is before the notice's removal mark. For each identity and workspace, the highest removal mark received applies; a later-arriving lower mark changes nothing.

**Delivery:**

- Each notice request is authenticated as from the fleet (R22, R27, C7).
- Delivering the same notice ID twice has the effect of delivering it once.
- The Tool Portal acknowledges each notice ID only after recording it durably.

### C4 Lookups (admin)

As in R14, visible only to the admin (R13). An identity's lookup for a bot also states that its proof depends on its own secret storage.

### C5 Collaboration attribution and messaging

- A session's call is recorded as coming from the session whose binding it arrived on. A declared sender that differs is refused, with a reason naming the mismatch. The binding is a capability held by the machine's harness configuration (R3).
- A bot's message is accepted only with a collaboration token (C6) for an active credential of that bot.
- A message to another workspace's member is refused unless a workspace pair allows it (R12) or the sender is a bot collaborator of that workspace (R11).

### C6 Collaboration token

| Field | Meaning |
|---|---|
| issuer | The sign-in service |
| audience | The fleet's collaboration address |
| organization | The bot's E1 |
| principal | `bot` and its E4 ID |
| issued at, expires at, grant expires at | As in C1 |

Issued only to a registered bot presenting an active credential, after consulting the fleet's truth. Accepted only by the fleet's collaboration service, which then admits each message by the bot's collaborations (R11) and workspace pairs (R12) as recorded at that moment. The Tool Portal refuses it (wrong audience). It names no workspace and grants no tools.

### C7 Service requests

| Caller → receiver | Operation | What a repeat does |
|---|---|---|
| Sign-in service → fleet | Decide whether to issue a workspace or collaboration token to a bot | Decides again; each decision takes its own grant mark. Nothing else changes. |
| Fleet → sign-in service | Mint a session's workspace token from a grant decision | Mints a token with the same grant expiry and grant mark; never extends it. Refused after the redemption window. |
| Fleet → Tool Portal | Deliver a removal notice | No further effect (same notice ID). |
| Fleet → sign-in service | Confirm that a person's session is current and the person active in the organization, for an admin action (people sign-in R9) | Confirms again. Nothing changes. |

Each request is authenticated as R27 states. A credential is accepted only by the receiving service it names and only for the operation it names. A credential is a bearer credential protected in transit: whoever holds an unexpired one can make that one kind of request within its scope, so each receiver also checks that the request's body is well-formed and within that scope.

## Failure and partial outcomes

| Situation | Observable outcome |
|---|---|
| The fleet's truth is unavailable | No new tokens. Existing tokens keep working until either expiry, then calls are refused. Nothing can be removed during the outage, because nothing can change. |
| The fleet's and the Tool Portal's clocks differ, by up to 60 seconds | A token may be refused up to 60 seconds before its grant expiry. A covered token is never accepted after its notice is dropped. |
| A grant is decided but minting is delayed or repeated | After the redemption window, nothing mints. A token minted in time is still unusable after its grant expiry. A repeat yields nothing longer-lived. |
| A removal is recorded but its notices haven't reached every workspace | No new grant for the removed access. The admin sees it as pending. Each workspace refuses covered tokens from receipt; the removed identity stops at grant expiry at the latest. |
| A removal notice is not delivered | The fleet keeps resending, and the admin sees it as unacknowledged. The removed identity stops at grant expiry at the latest. |
| Notices for one identity arrive out of order | The highest removal mark received applies. |
| A persona changes and a new token is requested at once | The new token's grant mark is after the change's removal mark, so it is accepted; the old one is refused from receipt. |
| The Tool Portal restarts | Acknowledged notices are still applied. |
| A session ends (its conversation archived or deleted) | Its membership ends, no new token issues, and a removal notice reaches its workspace. |
| A collaborator calls W's tools | Refused: it holds no token for W. |
| A machine is revoked, or its allowance withdrawn, mid-session | No new tokens for its sessions in that workspace, and a removal notice reaches each affected workspace. |
| A bot's secret leaks | Whoever holds it is that bot until the admin retires the credential. This is the accepted limit in U2. |
| A machine is compromised, or a process on it reads another session's binding | Every session on it can be impersonated, and its isolation records can't be trusted, until the machine is revoked. |
| A session reads another workspace's files on a shared machine | Not prevented in the first round. The shared bucket shows it is possible. Only `Vm` would prevent it. |

## What this set does not do

- No live per-call check to the fleet from the Tool Portal.
- No hardware proof of isolation, and no enforcement on isolation yet.
- No separation between sessions on one machine user: a session's binding is a capability, not a secret it proves.
- No tools for collaborators or workspace pairs.
- No new keys on machines.
- No refresh tokens for people's own MCP clients.
- No change to the Fleet board release now shipping.
- Removal does not erase what an identity already read, copied or sent.

## Proof obligations

| ID | For | Passes when | A wrong build fails because | Reference |
|---|---|---|---|---|
| V1 | R1 | Every grant and recorded actor carries exactly one kind. | A grant or record has no kind, or two. | E3, E4, E7 |
| V2 | R2, R24 | A session token issues only through its enrolled machine. A revoked machine gets nothing. No new machine key exists. | A token issues for an unenrolled or revoked machine, or a machine key appears. | R2, R24 |
| V3 | R3, C5 | Real Codex, Claude and Cursor sessions naming another session are refused, and own-session calls are recorded as their own. A wrong, expired, cross-installation or reused binding is refused. | A false sender is stored, or a stale binding is accepted. | U19; Fleet live findings, 2026-10-23 |
| V4 | R4 | An active bot credential is accepted. A retired credential or unknown bot is refused. A bot with two credentials is the same principal through either. The bot record shows the storage note. | A retired credential works, a credential's client ID is taken as the bot, or the note is missing. | R4, C2 |
| V5 | R6, R10 | A second bot membership is refused. Only the admin sets one. | A bot ends up with two memberships, or a non-admin sets one. | U5 |
| V6 | R7, R8 | A started session is a member of its project's workspace, whatever its repository. A start on a machine with no allowance for that workspace is refused. | The workspace follows the repository, or a start succeeds without an allowance. | U6 |
| V7 | R9 | A session's available tools and approval-free calls are exactly what both its default and its named persona allow. A named persona wider than the default adds nothing. An undefined persona allows nothing. A default changed during a token's life applies from the next call. | A session uses a tool or skips an approval the current default does not allow. | U11 |
| V8 | R11, R12, C6 | A bot collaborator's message, sent with a collaboration token, reaches a member. A paired workspace's member message is delivered. An unpaired one is refused. Tool calls, session starts and role claims by collaborators are refused. A collaboration token is refused at the Tool Portal, and a workspace token at the collaboration service. | A collaborator gets a workspace token, starts work or takes a role, an unpaired message is delivered, or a token is accepted at the wrong service. | U7, U8 |
| V9 | R13, C4 | The organization's active, current owner's admin action applies. A member who isn't the owner, another organization's owner, a removed owner, a stale session, a bot and a session are each refused with nothing changed and nothing revealed. The fleet's operator can revoke a machine serving two organizations; either organization's owner who isn't the operator cannot. | Anyone but that owner changes access or reads a lookup, or an organization owner revokes a machine fleet-wide. | U21; F-78; people sign-in R9, R19, R20 |
| V10 | R14, C4 | Lookups answer correctly for a person, a bot, a session, a workspace, a machine and a pending removal. | An answer is missing or wrong. | U9 |
| V11 | R15, R16, C1 | Every token carries the C1 fields. Its grant expiry is its decision time plus the configured lifetime. A decision minted after its redemption window mints nothing; a delayed or repeated mint never yields a later grant expiry. | A field is missing, a lifetime is exceeded, or a delayed mint outlives its grant. | U12 |
| V12 | R17 | An allowed member call is admitted. Each C1 refusal is refused before any tool runs. The Portal makes no fleet call per tool call. | A covered, expired, foreign or incoherent token runs a tool, or the Portal calls the fleet per call. | U10, U12 |
| V13 | R18, R25, C2 | A non-member, an ended session, or a session on a machine not allowed for W, is refused. With the truth unavailable, no token issues, a pre-outage decision mints nothing after its window, and calls stop at grant expiry. | A token issues without consulting the truth or without an allowance, or a call succeeds after grant expiry. | U14 |
| V14 | R19, R20, C3 | After each removal kind, the next call is refused once the notice arrives. A grant decided before the removal but minted after it is refused. A grant decided right after a persona change is accepted. A late, lower notice lowers nothing. While a removal is pending, no new grant is decided for it. | A covered token works after receipt, a post-change grant is refused, a lower notice reopens access, or a grant issues during a pending removal. | U13 |
| V15 | R21 | An undelivered notice is resent and shown. A notice is acknowledged only once recorded. Notices survive a Portal restart and are kept until every token they cover has passed its grant expiry. | A notice is lost, acknowledged before it is kept, hidden, or forgotten while a covered token could still be accepted. | U13 |
| V16 | R22 | A notice not from the fleet changes nothing. | A forged notice removes anyone. | U15 |
| V17 | R23 | A session's isolation record, with its instance ID and machine environment, is in its record and its token, and each machine's shared bucket is shown. Nothing is refused for isolation. | It is missing, or isolation blocks a call. | U18 |
| V18 | R26 | The same obligations pass with each service on Cloudflare and on a non-Cloudflare host. | Behavior differs by host. | U16 |
| V19 | R27, C7 | Each C7 request from its expected caller, for its operation, to its receiver, is accepted, including with a newly rotated key during its overlap. The wrong caller, operation or receiver, a body naming an organization or workspace the caller may not act for or the receiver doesn't host, a malformed body, an expired credential and a withdrawn or unknown key are each refused with nothing changed. A repeat has only the effect C7 states. | A request is accepted from the wrong caller, for another operation or out-of-scope organization, or with a withdrawn key, or a repeat changes more than C7 allows. | U13, U15, U16 |

## Coverage

| U | E | P | O | R | C | V |
|---|---|---|---|---|---|---|
| U1 | E3, E4, E7 | P1 | O1 | R1 | — | V1 |
| U2 | E4, E5, E18 | — | O1 | R4, R11 | C2, C6 | V4, V8 |
| U3 | E6, E7 | P1 | O1 | R2 | C2 | V2 |
| U4 | E8, E9 | P3 | O2 | R6, R7, R11 | — | V5, V6, V8 |
| U5 | E4, E8, E9 | P3 | O2 | R6 | — | V5 |
| U6 | E6, E7, E15, E16 | P3 | — | R7, R8 | C2 | V6 |
| U7 | E9, E17, E18 | — | O2 | R11, R12 | C5, C6 | V8 |
| U8 | E17 | — | — | R12 | C5 | V8 |
| U9 | E2–E18 | P3 | O3 | R14 | C4 | V10 |
| U10 | E2, E10, E11 | P2 | O2 | R15, R17 | C1 | V11, V12 |
| U11 | E10 | — | — | R9 | — | V7 |
| U12 | E11, E18 | — | — | R16, R17 | C1, C6 | V11, V12 |
| U13 | E12 | P4 | O4 | R19–R22, R27 | C3, C7 | V14–V16, V19 |
| U14 | E11, E18 | — | O4 | R18, R25 | C2 | V13 |
| U15 | all | P2 | — | R18, R22, R27 | C7 | V13, V16, V19 |
| U16 | all | — | O5 | R26, R27 | C7 | V18, V19 |
| U17 | E6 | — | — | R2, R24 | — | V2 |
| U18 | E13, E14 | P5 | O3 | R3, R23 | C4 | V17 |
| U19 | E7 | P1 | O1 | R3 | C5 | V3 |
| U20 | E1, E3 | — | — | R5, R10, R13 | — | V9; the sign-in design's own proof |
| U21 | E2, E4, E6, E15, E17 | — | — | R13 | C4 | V9 |

## What this replaces

These earlier rules change. Each is superseded only where stated.

| Earlier rule | Now |
|---|---|
| People sign-in **R10** ("this service MUST NOT issue proofs to machines or VMs") | It still issues no proof that identifies a machine. It does issue workspace tokens for sessions, requested through the fleet. |
| People sign-in **R15**, **E9**, **E10**, **E11** (an agent client signs in as itself and gets a proof for a linked workspace) | Bots keep this as E4 and E5, with membership from E8. Sessions never sign in (R2). The workspace link E11 is replaced by E8 membership. |
| People sign-in **R17**, **R18** (removal refuses "on its next call" by a stored-record check) | Removal is pushed (R19–R21), with grant expiry as the backstop. |
| **D2** location ("per-organization Durable Object in the sign-in service") | The meaning is kept: each organization is isolated and its owner decides who may sign in. Storage follows U15 (the fleet holds organizations) and is bound in Program Design. People sign-in R9, R19 and R20 carry over unchanged to the fleet's admin (R13). |
| **F-75** ("external agents get agent-collaboration only") | A bot may be a member of one workspace when the admin picks it (U5). Every other relationship stays collaboration-only. |
| The fleet's "context" lookup (a session's workspace from its working directory) | A session's workspace is its project's workspace (R7). The lookup may remain as a convenience; it never decides membership. |
| Tool Portal workspace unit, #262 (membership store and agent-management route) | Membership comes from the token (R15, R17) and removal notices. The per-workspace store keeps approval replay state and removal notices. Management moves to the fleet admin (R13). |

## Noun mapping

| This set | People sign-in design | Tool Portal design | Fleet code today |
|---|---|---|---|
| E1 Organization | E12 Organization | E1 Organization | — |
| E2 Workspace | E6 Relying service (each workspace's MCP address) | E2 Workspace | `workspaces` record |
| E16 Project | — | — | `project_directory` entry |
| E3 Person | E2 Person | — | `Identity::Human` |
| E4 Bot | E9 Agent client (the credential holder) | E3 Agent (when a bot) | — |
| E5 Bot credential | E9's client credentials | — | — |
| E6 Fleet machine | — | — | machine enrollment, Router installation |
| E15 Machine allowance | — | — | proposed in Fleet decision 902 (not built) |
| E7 Fleet harness session | — | E3 Agent (when a session) | `Identity::Session` (`SessionRef`) |
| E8 Membership | E11 Workspace link | member and persona record | thread seat (not membership) |
| E9 Bot collaboration | — | — | — |
| E17 Workspace pair | — | — | — |
| E10 Persona | — | persona | — (board roles are not personas) |
| E11 Workspace token | E10 Agent proof | per-workspace token | — |
| E18 Collaboration token | — | — | — |
| E12 Removal notice | — | — | — |
| E13 Isolation record | — | — | proposed `AgentIsolation` and `MachineEnvironment` (not built) |
| E14 Shared bucket | — | — | — |
