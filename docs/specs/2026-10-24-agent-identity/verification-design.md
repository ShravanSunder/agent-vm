# Agent identity and workspace access: Verification Design

How each requirement in [Requirements](requirements.md) will be shown to hold, against the [Specification](specification.md)'s obligations and the [Program Design](program-design.md)'s seams. This is a plan; nothing in it has been observed.

## Proven by: one line per requirement

| U | Your need, in short | Proven by | Stays unverified |
|---|---|---|---|
| U1 | Three kinds of identity | Every token and every recorded actor parses as exactly one of the three kinds. Anything else is rejected. | — |
| U2 | Bots prove themselves with their own credential | A bot signs in with an active credential and is accepted. With a retired one it is refused. Its record shows the storage note. | How real bots store their secrets (accepted limit) |
| U3 | Sessions vouched for by their machine | A real session gets a token through its enrolled machine. After you revoke the machine, it gets nothing. | Cloud VMs and agent-vm VM sessions |
| U4, U5 | Member or collaborator; a bot in at most one workspace | A second membership for a bot is refused. A bot collaborator can message but can't use tools. | — |
| U6 | A session belongs to its project's workspace | Start a real session for a project and see its token name that project's workspace. Its repository makes no difference. A machine not allowed for that workspace is refused. | Who may start a session (OD1) |
| U7, U8 | Collaborators only message, across allowed pairs | A session messages a member of a paired workspace and it arrives. An unpaired one is refused. | Whether a bot collaboration needs your allowance (OD3) |
| U9 | Look up who belongs where | Each lookup answers correctly for a person, bot, session, workspace and machine. | — |
| U10, U11 | Members only, within their persona | A member's allowed tool call runs. A collaborator's is refused. A widened persona is refused. | — |
| U12 | No live check; configurable lifetime, max 1 h | Tokens expire within the configured lifetime. The Tool Portal answers calls while Fleet central is unreachable. | — |
| U13 | Removals pushed | Remove a member and see its very next call refused once the notice arrives. With the Portal down, the notice waits, shows as pending, and lands when the Portal returns. | — |
| U14 | Fail closed | Stop Fleet central: no new tokens, and calls stop once tokens expire. | — |
| U15 | One owner per truth | Every membership change happens only at Fleet central. The Portal and sign-in hold no membership. | — |
| U16 | One contract, any host | The same suites pass with Fleet central on Cloudflare and on Tokio, and the Portal on Cloudflare and on Node. | The Node and Tokio hosts in production deployments |
| U17 | No new machine keys | No code path creates or reads a machine private key. Vouching uses the enrolled connection. | — |
| U18 | Isolation recorded and shown | A session's isolation appears in its record and token, and its machine's shared bucket lists its workspace. Nothing is refused for isolation. | Whether the isolation the launcher asserts is true |
| U19 | No false senders | Real Codex, Claude and Cursor sessions trying to post as another session are refused. | — |
| U20 | People sign-in unchanged | The people sign-in design's own proof, re-run after its organization admission moves to Fleet central. | — |
| U21 | Only people administer | A bot or session attempting each admin action is refused, with nothing changed. | — |

## Shared observations

Several rows use the same observation. Each is described once here.

**SO1: Fleet identity journey** (needed, lasting). It belongs in `verify-codex-router` as a new journey `fleet-identity`, because Fleet central owns the truth it reads.

- **What runs:** an isolated debug Router with real Codex, Claude and Cursor sessions, a local Fleet central (Tokio, plus local workerd), the local sign-in Worker from `verify-auth`'s harness, and the Tool Portal through its production `index.ts` host entry.
- **What it drives:**
  1. enroll the machine and allow it for workspace W;
  2. start a session for a project in W;
  3. call a Portal tool through the forwarder;
  4. try posting as another session;
  5. message across a paired and an unpaired workspace;
  6. remove the session;
  7. revoke the machine;
  8. stop Fleet central.
- **What it reads:**
  - the tool's effect counter at the controlled MCP server;
  - the Portal's refusal classes;
  - the decoded token claims;
  - central's lookups;
  - the board records.

The Router and Fleet central start the way `verify-codex-router`'s board-central journey starts them.

**SO2: sign-in issuance journey** (existing `verify-auth` agent journey, to update, lasting). Its target is the local T3 sign-in Worker on real workerd, D1 and Better Auth. Changes:

- Bot client credentials take their decision from a real local Fleet central, not from workspace links.
- A session grant is minted with Fleet central as the client.
- Each refusal class is observed: not a member, identity not proven, machine not allowed, unavailable.

**SO3: Tool Portal admission** (existing agent-vm host e2e suites on the production entry, extended, lasting). It covers:

- each C1 refusal class before any tool runs, read from the controlled MCP server's effect counter;
- the persona narrowing refusal;
- a forged removal notice;
- notices surviving a store restart;
- calls answered while no Fleet central exists.

**SO4: central conformance** (existing `verify-codex-router` central-runtime journey, extended, lasting). The organization authority's commands, lookups, revisions and outbox run on native Tokio and on local workerd from one core.

**SO5: deployed check** (existing private Cloudflare deploy cycle, a new row, temporary per cycle). It covers the Tool Portal, the sign-in service and Fleet central on real Workers in the private account:

- a bot token is issued and used;
- a removal is pushed and the next call is refused;
- Fleet central is made unavailable and no token issues.

Sampling covers arrival and refusal only.

## Coverage rows

| Requirement | Proven by | Reference | Target and journey | Lifetime | Passes when (and the wrong build that fails) | Reuses | Unverified |
|---|---|---|---|---|---|---|---|
| **U1**: R1 | Parse every token subject and every recorded actor | E3/E4/E7 and the C1 subject kinds | Focused tests on `Principal` and `workspaceTokenClaimsSchema`, plus SO1's decoded claims | — | Exactly one of three kinds parses. A fourth kind, or a token with no `subject_kind`, is rejected. A build that defaults an unknown kind to "bot" fails. | none | — |
| **U2**: R4 | Sign in a bot with an active, then a retired, credential | C2 outcomes; E5 states | SO2 | lasting | Active → token. Retired → `invalid_client`, and no token. The bot lookup shows the storage note. A build that keeps retired clients working fails. | `verify-auth` agent journey (updated) | How real bots store secrets (accepted limit, U2) |
| **U3, U17**: R2, R24 | A real session requests a token through its machine, then after revocation | R2; C2 "identity not proven" | SO1, plus a structural search for key generation | lasting | An enrolled machine's session gets a token. After revocation, `IdentityNotProven`, and no token. No source path generates or reads a machine private key. A build that accepts a declared session without its enrolled connection fails. | `verify-codex-router` board-central launch | Cloud VMs; agent-vm VM sessions (deferred) |
| **U4, U5**: R6, R11 | Give a bot a second membership; have a bot collaborator message, call a tool, claim a role | R6; R11 | SO4 for membership; SO1 for collaboration | lasting | The second membership is refused. The collaborator's message is delivered. Its tool call gets no token. Its role claim is refused. A build that lets a collaborator obtain a W token fails. | — | — |
| **U6**: R7, R8 | Start sessions for projects in W1 and W2, with a repository attached to both; then start on a machine not allowed for W2 | R7; C2 "machine not allowed" | SO1 | lasting | Each session's token names its project's workspace, regardless of repository. The start on the unallowed machine is refused, `MachineNotAllowed`. A build that derives the workspace from the working directory fails. | — | **R8's starter rule waits on OD1** |
| **U7, U8**: R11, R12 | Message from W1 to members of W2, with and without a W1→W2 pair | R12 | SO1 (board records) | lasting | With the pair, delivered and recorded with the bound actor. Without it, refused, and nothing recorded. A build that skips the pair check fails. | — | **R11's admission rule waits on OD3** |
| **U9**: R14 | Run each lookup after SO1's actions | R14; C4 | SO4 + SO1 | lasting | Each lookup's fields match the state SO1 created, including pending notices and shared buckets. A build that omits collaborations or buckets fails. | — | — |
| **U10, U11**: R15, R17, R9 | Call an allowed tool, a disallowed tool, with a collaborator's credential, and with a widened persona | C1; R9 | SO3 | lasting | The allowed call has 1 effect. The others are refused before any effect (0 effects), each with its class. A build that admits on a valid signature alone fails. | agent-vm host e2e (production entry) | — |
| **U12**: R16, R17 | Configure 5 and 60 minutes; try 61; call the Portal with central absent | R16; C1 expiry | Focused test on the lifetime newtype; SO3 for calls without central; SO2 for `exp - iat` | lasting (SO2, SO3) | `exp - iat` equals the configured value. 61 is unrepresentable. Calls succeed with no Fleet central present. A build that calls central per tool call, or allows over 60 minutes, fails. | — | — |
| **U13**: R19, R20, R21, R22 | For each removal reason, remove, then call. Repeat with the Portal down and restarted. Send a forged notice. | C3; revision coverage | SO1 (each reason), SO3 (forged, restart), SO5 (deployed push) | lasting (SO1, SO3); temporary (SO5) | After receipt, the next call is refused, with 0 effects. A token decided before the removal but minted after it is still refused. A token decided after is accepted. Pending notices show while the Portal is down and land after restart. A forged notice changes nothing. A build using wall-clock times instead of revisions fails the decided-before/minted-after case. | — | — |
| **U14**: R18, R25 | Stop Fleet central; request bot and session tokens; keep calling until expiry | R25; C2 unavailable | SO1, SO2, SO5 | lasting / temporary (SO5) | No token is issued. Existing calls succeed until `exp`, then are refused. A build that issues from cached membership fails. | — | — |
| **U15**: R18, R22 | Inspect where membership is stored | Program Design ownership | Structural check: the Portal store schema and sign-in persistence hold no membership. Plus SO1. | — | The Portal store holds only approval uses and notices. Sign-in holds credentials with `botId`. A build keeping a second membership copy fails. | — | — |
| **U16**: R26 | Run SO3 and SO4 on both hosts of each service | R26 | SO4 (Tokio + local workerd), SO3 (Cloudflare + Node hosts) | lasting | The same cases pass on each host. A host-specific divergence fails. | central conformance harness; agent-vm Node host suites | Production Node and Tokio deployments |
| **U18**: R23 | Start sessions with `Host` and `ProcessSandbox` isolation; read their record, token and their machine's bucket | E13; E14 | SO1 + SO4 | lasting | The isolation matches what the launcher asserted. The bucket lists the `Host` sessions' workspaces. No call is refused for isolation. A build that omits isolation from the token fails. | — | Whether the launcher's assertion is true |
| **U19**: R3 | Real Codex, Claude and Cursor sessions post naming another session | R3; C5; Fleet live findings 2026-10-23 | SO1 | lasting | Each A-as-B post is refused with a sender mismatch and nothing recorded. Own posts are recorded as the bound session. Today's build stores the false sender, so it fails. | the Fleet Advisor's live-run method (2026-10-23) | Other harnesses |
| **U20**: R5, R10 | Re-run the people sign-in design's journeys with organization admission at Fleet central | the people sign-in design | `verify-auth` bootstrap journey + SO4 | lasting | That design's passing conditions hold. A build that lets a removed person sign in fails. | `verify-auth` bootstrap | — |
| **U21**: R13 | Each admin command, with a person token and with bot and session tokens | R13 | SO4 (admin surface) | lasting | The person's command applies. Each bot or session attempt is refused, with state unchanged. A build that accepts any valid token fails. | — | — |

## Journeys to build or extend

| Journey | Status | Lifetime | Entry it drives | What it reads |
|---|---|---|---|---|
| `verify-codex-router` `fleet-identity` (SO1) | needed | lasting | Router session start, the forwarder, board posts, admin commands, stopping central | tool effect counts, refusal classes, decoded claims, board records, lookups |
| `verify-auth` agent journey (SO2) | existing, update | lasting | bot client credentials; session grant | issued claims; refusal classes |
| agent-vm host e2e admission (SO3) | existing, extend | lasting | the Portal's production entry | effect counter; refusals; store contents after restart |
| `verify-codex-router` central runtime (SO4) | existing, extend | lasting | organization authority commands and lookups on Tokio and workerd | durable readback |
| Private deploy cycle row (SO5) | new row | temporary | deployed Workers | arrival and refusal |

All of these run on sunclaw where they are heavy (workerd or whole-suite), never on the owner's Mac, except the deployed row, which runs as a network client.
