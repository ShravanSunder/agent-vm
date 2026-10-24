# Agent identity and workspace access: Verification Design

How each requirement in [Requirements](requirements.md) will be shown to hold, against the [Specification](specification.md)'s obligations and the [Program Design](program-design.md)'s seams. This is a plan; nothing in it has been observed.

## Proven by: one line per requirement

| U | Your need, in short | Proven by | Stays unverified |
|---|---|---|---|
| U1 | Three kinds of identity | Every token and every recorded actor parses as exactly one of the three kinds. Anything else is rejected. | — |
| U2 | Bots prove themselves with their own credential | A bot signs in with an active credential and is accepted, as the same bot through either of two credentials. With a retired one it is refused. Its record shows the storage note. | How real bots store their secrets (accepted limit) |
| U3 | Sessions vouched for by their machine | Two real sessions get tokens through their enrolled machine, each naming itself. After you revoke the machine, neither gets anything. | Cloud VMs and agent-vm VM sessions |
| U4, U5 | Member or collaborator; a bot in at most one workspace | A second membership for a bot is refused. A bot collaborator messages with its collaboration token but can't use tools or start work. | — |
| U6 | A session belongs to its project's workspace | Start a real session for a project and see its token name that project's workspace. Its repository makes no difference. A machine not allowed for that workspace is refused. | Who may start a session (OD1) |
| U7, U8 | Collaborators only message, across allowed pairs | A session messages a member of a paired workspace and it arrives. An unpaired one is refused. A collaboration token is refused at the Tool Portal. | Whether a bot collaboration needs your allowance (OD3) |
| U9 | Look up who belongs where | Each lookup answers correctly for a person, bot, session, workspace, machine and pending removal. | — |
| U10, U11 | Members only, within their persona | A member's allowed tool call runs. A collaborator's is refused. A session's wider named persona adds nothing beyond the default; a changed default applies from the next call. | — |
| U12 | No live check; configurable lifetime, max 1 h | Tokens stop working at their grant expiry, however late they were minted. The Tool Portal answers calls while Fleet central is unreachable. | — |
| U13 | Removals pushed | Remove a member and see its very next call refused once the notice arrives. A token decided before the removal but minted after it is refused; one decided right after a persona change works. With the Portal down, or the work interrupted half-way, the removal shows pending and lands later. | — |
| U14 | Fail closed | Stop Fleet central: no new tokens, a decision taken just before minting nothing late, and calls stop at grant expiry. | — |
| U15 | One owner per truth | Every membership change happens only at Fleet central. The Portal and sign-in hold no membership. Requests between them come only from the expected service. | — |
| U16 | One contract, any host | The same suites pass for Fleet central on Cloudflare and Tokio, the Portal on Cloudflare and Node, and the sign-in service on Cloudflare and Node. | The Node and Tokio hosts in production deployments; the sign-in Node host until it is built |
| U17 | No new machine keys | No code path creates or reads a machine private key. Vouching uses the enrolled connection. | — |
| U18 | Isolation recorded and shown | A session's isolation, with its instance ID and machine environment, appears in its record and token, and its machine's shared bucket lists its workspace. Nothing is refused for isolation. | Whether the isolation the launcher asserts is true |
| U19 | No false senders | Real Codex, Claude and Cursor sessions trying to post as another session are refused, and stale or foreign bindings are refused. | Same-user processes holding another session's binding (the accepted shared-bucket limit) |
| U20 | People sign-in unchanged | The people sign-in design's own proof, re-run after its organization admission moves to Fleet central. | — |
| U21 | Only you administer | Your admin action works. Another member, another organization's owner, a removed owner, a stale session, a bot and a session are each refused with nothing changed or shown. | — |

## Shared observations

Several rows use the same observation. Each is described once here.

**SO1: Fleet identity journey** (needed, lasting). It belongs in `verify-codex-router` as a new journey `fleet-identity`, because Fleet central owns the truth it reads.

- **What it reuses:** the model-free `board_central_journey.py` launcher (`references/board-storage.md:3–10, 20–39`) for the local central, its enrollment and the debug Host. That launcher starts no provider and no normal Router, so it supplies the arrangement only.
- **What must be built:** a native launch part that starts a normal Router with real Codex, Claude and Cursor sessions against that central, registers them for projects, and reads their bindings. Dependencies: provider accounts on the run machine, the per-session ACP MCP lists, and the Codex thread binding.
- **What runs:** that Router and its sessions, a local Fleet central (Tokio, plus local workerd), the local sign-in Worker from `verify-auth`'s harness, and the Tool Portal through its production `index.ts` host entry.
- **What it drives:**
  1. enroll the machine and allow it for workspace W;
  2. start two sessions for a project in W;
  3. call a Portal tool through the forwarder from each;
  4. try posting as another session, and with a stale and a foreign binding;
  5. message across a paired and an unpaired workspace;
  6. change a session's persona, then call at once;
  7. end one session (archive) and remove the other;
  8. revoke the machine, interrupting the fan-out once;
  9. stop Fleet central between a decision and its mint, and before a decision.
- **What it reads:**
  - the tool's effect counter at the controlled MCP server;
  - the Portal's refusal classes;
  - decoded token claims;
  - central's lookups, including `RemovalStatus`;
  - board records.

**SO2: sign-in issuance journey** (existing `verify-auth` agent journey, to update, lasting). Its target is the local T3 sign-in Worker on real workerd, D1 and Better Auth 1.7.8. Changes:

- Bot client credentials take their decision from a real local Fleet central.
- A bot with two credentials gets the same `principal` through either.
- The fleet-session grant mints for two sessions under central's one client, each with its own `principal`.
- Each refusal class is observed: not a member, identity not proven, machine not allowed, unavailable, and a decision past its redemption window.
- A collaboration token is minted for a bot with no membership.

**SO3: Tool Portal admission** (existing agent-vm host e2e suites on the production entry, extended, lasting). It covers:

- each C1 refusal class before any tool runs, read from the controlled MCP server's effect counter;
- persona narrowing: session default, an undefined persona, a narrower one, a partly wider one on a shared tool and on a tool only it allows, and a default changed during a token's life;
- removal marks: a forged notice, an unauthenticated one, an out-of-order lower one, a duplicate, notices surviving a store restart, and the retention boundary;
- calls answered while no Fleet central exists.

**SO4: central conformance** (existing `verify-codex-router` central-runtime journey, extended, lasting). The organization authority's commands, guard, lookups, marks and outbox, and the Registry fan-out, run on native Tokio and on local workerd from one core, including restarts between each owner's commit and its outbox steps.

**SO5: deployed check** (existing private Cloudflare deploy cycle, a new row, temporary per cycle). It covers the Tool Portal, the sign-in service and Fleet central on real Workers in the private account:

- a bot token is issued and used;
- a removal is pushed and the next call is refused;
- Fleet central is made unavailable and no token issues.

Sampling covers arrival and refusal only.

**SO6: contract round trips** (needed, lasting). Fixtures generated from the Rust contract are parsed by the Zod schemas and back, for every shape in the Program Design: principals and isolation kinds (including `host` with its instance ID), persona references, decisions, notices, marks at their limit, and a version the receiver doesn't know.

**SO7: service-request negatives** (needed, lasting). For each C7 edge on its real receiving entry: the right caller succeeds; the wrong caller, the wrong scope, another receiver's audience, another organization or workspace, an altered body, an expired credential and a rotated key are each refused with nothing changed; a repeat has only the stated effect.

## Coverage rows

| Requirement | Proven by | Reference | Target and journey | Lifetime | Passes when (and the wrong build that fails) | Reuses | Unverified |
|---|---|---|---|---|---|---|---|
| **U1**: R1 | Parse every token principal and recorded actor | E3/E4/E7; C1 | focused tests on `Principal` and the claims schemas, plus SO6 | — | Exactly one of three kinds parses. A fourth kind, a missing `principal`, or a person principal in a workspace token is rejected. A build that defaults an unknown kind to "bot" fails. | none | — |
| **U2**: R4 | Sign in a bot through each of two credentials, then with a retired one | C2; E4, E5 | SO2 | lasting | Both credentials yield the same `principal.bot_id`, different from either client ID. Retired → `invalid_client`, no token. The lookup shows the storage note. A build that takes the client ID as the bot, or keeps retired clients working, fails. | `verify-auth` agent journey (updated) | How real bots store secrets |
| **U3, U17**: R2, R24 | Two real sessions request tokens through their machine; then revoke it | R2; C2 | SO1, SO2; a structural search for key generation | lasting | Each token's `principal.session_ref` names its own session and `client_id` is central's. After revocation, `IdentityNotProven`, no token. No source path generates or reads a machine private key. A build that accepts a declared session without its enrolled connection, or gives both sessions one principal, fails. | the board-central arrangement only | Cloud VMs; agent-vm VM sessions |
| **U4, U5**: R6, R11 | Give a bot a second membership; have a bot with no membership message, call a tool, claim a role | R6; R11; C6 | SO4 (membership); SO1 + SO2 (collaboration) | lasting | The second membership is refused. The collaborator's message, sent with its collaboration token, is delivered. It gets no workspace token; its role claim is refused. A build that issues a collaborator a workspace token fails. | — | — |
| **U6**: R7, R8 | Start sessions for projects in W1 and W2, with a repository attached to both; then start on a machine not allowed for W2 | R7; C2 | SO1 | lasting | Each token names its project's workspace, regardless of repository. The unallowed start is refused, `MachineNotAllowed`. A build that derives the workspace from the working directory fails. | — | **R8's starter rule waits on OD1** |
| **U7, U8**: R11, R12, C6 | Message W1 → W2 with and without a pair; present a collaboration token at the Portal and a workspace token at the collaboration service | R12; C6 | SO1 (board records); SO3 | lasting | With the pair, delivered and recorded with the bound actor. Without, refused, nothing recorded. Each token is refused at the other service. A build that skips the pair check or accepts either token at the wrong service fails. | — | **R11's admission rule waits on OD3** |
| **U9**: R14 | Run each lookup after SO1's actions, including during an interrupted removal | R14; C4 | SO4 + SO1 | lasting | Each lookup matches the state SO1 created; `RemovalStatus` shows pending until the last step. A build that omits collaborations, buckets or pending status fails. | — | — |
| **U10, U11**: R15, R17, R9 | Call an allowed tool, a disallowed tool, with a collaborator's credential, and under each persona case | C1; R9 | SO3 | lasting | The allowed call has 1 effect. Every other case is refused before any effect (0 effects), each with its class. A partly wider named persona runs only the tools both profiles allow and asks for approval when either does. A build that admits on a valid signature alone, or uses the named profile alone, fails. | agent-vm host e2e (production entry) | — |
| **U12**: R16, R17 | Configure 5 and 60 minutes; try 61; mint at once, at 59 s and at 61 s after a decision; repeat a mint; call with central absent | R16; C1 | focused test on the lifetime newtype; SO2 (mint timing); SO3 (calls) | lasting (SO2, SO3) | `grant_expires_at` is the decision time plus the configured value, whatever the mint time. 61 minutes is unrepresentable. The 61 s mint yields nothing; a repeat ends at the same moment. Calls succeed with no Fleet central. A build anchoring expiry at mint time, or calling central per tool call, fails. | — | — |
| **U13**: R19, R20, R21, R22 | For each removal reason, remove, then call. Persona change then an immediate new grant. A decision held, the removal acknowledged, then minted. Notices out of order. The Portal down and restarted. Interrupt each owner's outbox (Registry fan-out between organizations; issuer disable step). Wait out the retention boundary. Send forged and unauthenticated notices. | C3; R20 | SO1 (reasons, interruptions), SO3 (marks, restart, retention, forged), SO4 (outbox restarts), SO5 (deployed push) | lasting (SO1, SO3, SO4); temporary (SO5) | After receipt, the next covered call is refused with 0 effects. The held decision mints nothing or yields a token covered from receipt. The post-change grant is accepted. A lower late notice reopens nothing. During an interruption no new grant issues and the removal shows pending, then completes. A build that only raises the counter on removals fails the persona-change case; one anchoring expiry at mint time fails the held-decision case. | — | — |
| **U14**: R18, R25 | Stop central before a decision and between a decision and its mint; request bot and session tokens; keep calling | R25; C2 | SO1, SO2, SO5 | lasting / temporary (SO5) | No token issues; the stranded decision mints nothing after 60 s; calls succeed until grant expiry, then are refused. A build that issues from cached membership fails. | — | — |
| **U15**: R18, R22, R27 | Inspect where membership is stored; run every C7 edge's negatives | Program Design ownership; C7 | structural check of Portal and sign-in persistence; SO7 | lasting (SO7) | The Portal store holds only approval uses (keyed by `principal`) and removal marks; sign-in holds credentials with `botId`. Every SO7 negative is refused with nothing changed. A build keeping a membership copy, or accepting a request from the wrong service, fails. | — | — |
| **U16**: R26, R27 | Run SO3, SO4 and SO2 on both hosts of each service | R26 | SO4 (Tokio + local workerd), SO3 (Cloudflare + Node), SO2 (Cloudflare + Node) | lasting | The same cases pass on each host. A host-specific divergence fails. | central conformance harness; agent-vm Node host suites | Production Node and Tokio deployments; **the sign-in Node host until it exists** |
| **U18**: R23 | Start sessions with `Host` and `ProcessSandbox` isolation; read their record, token and machine's bucket | E13; E14 | SO1 + SO4 + SO6 | lasting | The isolation, instance ID and machine environment match what the launcher asserted. The bucket lists the `Host` sessions' workspaces. No call is refused for isolation. A build that drops the `host` instance ID or the environment fails. | — | Whether the launcher's assertion is true |
| **U19**: R3 | Real Codex, Claude and Cursor sessions post naming another session; then with a stale binding after the session ends, a binding from another installation, and one re-issued after a Router restart | R3; C5 | SO1 (native launch part) | lasting | Each false sender and each stale or foreign binding is refused, nothing recorded. Own posts and the re-issued binding are recorded as the bound session. Today's build stores the false sender, so it fails. Described, not executed: a process reading another session's binding acts as it, the accepted shared-bucket limit. | the Fleet Advisor's live-run method (2026-10-23) | Other harnesses; same-user binding theft |
| **U20**: R5, R10 | Re-run the people sign-in design's journeys with organization admission at central | the people sign-in design | `verify-auth` bootstrap journey + SO4 | lasting | That design's passing conditions hold. A build that lets a removed person sign in fails. | `verify-auth` bootstrap | — |
| **U21**: R13, C4 | Each admin command and lookup as the organization's current owner; as another member, another organization's owner, a removed owner, with a stale session, and as a bot and a session | R13; people sign-in R9, R19, R20 | SO4 (admin surface through its guard and the confirmation request) | lasting | The owner's command applies. Every other caller is refused with state unchanged and no lookup data in the reply. A build that accepts any person token fails. | — | — |

## Journeys to build or extend

| Journey | Status | Lifetime | Entry it drives | What it reads |
|---|---|---|---|---|
| `verify-codex-router` `fleet-identity` (SO1) | needed: reuses the model-free central arrangement, adds a native launch part | lasting | Router session start, forwarder, board posts, session end, machine revocation, stopping central | effect counts, refusal classes, claims, board records, lookups |
| `verify-auth` agent journey (SO2) | existing, update | lasting | bot client credentials (two credentials); fleet-session grant; collaboration resource; mint timing | claims; refusal classes |
| agent-vm host e2e admission (SO3) | existing, extend | lasting | the Portal's production entry | effect counter; refusals; stored marks after restart |
| `verify-codex-router` central runtime (SO4) | existing, extend | lasting | organization authority commands, guard, outbox and Registry fan-out on Tokio and workerd | durable readback |
| Private deploy cycle row (SO5) | new row | temporary | deployed Workers | arrival and refusal |
| Contract round trips (SO6) | needed | lasting | generated fixtures through Rust and Zod | parse results |
| Service-request negatives (SO7) | needed | lasting | each C7 receiver's real entry | refusals; unchanged state |

All of these run on sunclaw where they are heavy (workerd or whole-suite), never on the owner's Mac, except the deployed row, which runs as a network client. SO1's native launch part needs provider accounts on the run machine.
