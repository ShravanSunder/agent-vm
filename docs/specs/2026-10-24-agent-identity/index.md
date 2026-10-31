# Agent identity and workspace access

The agent entry to this design set. People start at [index.html](index.html), a page over the same files. This index is navigation only; every rule lives in the document it links to.

**Item two (the owner's steps 1 and 2) has its own design:** [../2026-10-30-item-two/index.html](../2026-10-30-item-two/index.html). This set is the whole identity design, with its history; steps 3–5 still live here.

## Documents

- Requirements: [requirements.md](requirements.md). Whose need, in the owner's words, and the open owner decisions.
- Specification: [specification.md](specification.md). The entities, obligations, observable contracts, failures and proof obligations.
- Program Design: [program-design.html](program-design.html), authored in program-design.source.html, one section per heading. The owners, shapes, flows, state, failure handling and trust boundaries.
- Verification Design: [verification-design.md](verification-design.md). How each requirement will be shown to hold. Planned, not observed.
- Alternatives: [alternatives.md](alternatives.md). Every option weighed, drawn. It decides nothing.
- Item two delivery plan: now with item two's own design, at [../2026-10-30-item-two/plans/2026-10-30-item-two-delivery.html](../2026-10-30-item-two/plans/2026-10-30-item-two-delivery.html).
- Earlier delivery plan: [plans/2026-10-27-agent-identity-delivery.html](plans/2026-10-27-agent-identity-delivery.html). Replaced for D1 by the item two plan; it still records D2–D7 until steps 3–5 are planned.

The set is one concern, so it has no capability through-lines. The task paths below cross it.

## Reading path: a session calls a tool

1. [Requirements: needs U3, U6, U10–U12](requirements.md#needs)
2. [Specification: identity and proof](specification.md#identity-and-proof)
3. [Specification: tokens and tool calls](specification.md#tokens-and-tool-calls)
4. [Specification: C1 workspace token](specification.md#c1-workspace-token)
5. [Program Design: how a session gets and uses its token](program-design.html#program-design--how-a-session-gets-and-uses-its-token)
6. [Verification Design: coverage rows](verification-design.md#coverage-rows)

## Reading path: you remove access

1. [Requirements: need U13](requirements.md#needs)
2. [Specification: removal](specification.md#removal)
3. [Specification: C3 removal notice](specification.md#c3-removal-notice)
4. [Program Design: how a removal reaches the Switchboard](program-design.html#program-design--how-a-removal-reaches-the-tool-portal)
5. [Program Design: removal across owners](program-design.html#program-design--removal-across-owners-r19-r21)
6. [Program Design: state](program-design.html#program-design--state)
7. [Verification Design: coverage rows](verification-design.md#coverage-rows)
8. [Alternatives: keeping a removal and a token in order](alternatives.md#6-how-do-a-removal-and-a-token-minted-at-about-the-same-time-stay-in-order)

## Reading path: a bot gets a token

1. [Requirements: needs U2, U5](requirements.md#needs)
2. [Specification: identity and proof](specification.md#identity-and-proof)
3. [Specification: membership and collaboration](specification.md#membership-and-collaboration)
4. [Specification: C2 token issuance](specification.md#c2-token-issuance)
5. [Program Design: how a bot gets its tokens](program-design.html#program-design--how-a-bot-gets-its-tokens)
6. [Verification Design: coverage rows](verification-design.md#coverage-rows)

## Reading path: a session messages another workspace

1. [Requirements: needs U7, U8, U19](requirements.md#needs)
2. [Specification: membership and collaboration](specification.md#membership-and-collaboration)
3. [Specification: C5 collaboration attribution and messaging](specification.md#c5-collaboration-attribution-and-messaging)
4. [Program Design: collaboration admission](program-design.html#program-design--collaboration-admission-router-fleet-central-r28)
5. [Program Design: how a collaboration call is attributed](program-design.html#program-design--how-a-collaboration-call-is-attributed)
6. [Alternatives: where collaboration is checked](alternatives.md#18-where-is-a-collaboration-message-or-board-write-checked)
7. [Verification Design: coverage rows](verification-design.md#coverage-rows)

## Reading path: Fleet central is down

1. [Requirements: need U14](requirements.md#needs)
2. [Specification: hosts, outages and service requests](specification.md#hosts-outages-and-service-requests)
3. [Specification: failure and partial outcomes](specification.md#failure-and-partial-outcomes)
4. [Program Design: failure, recovery and concurrency](program-design.html#program-design--failure-recovery-and-concurrency)
5. [Verification Design: coverage rows](verification-design.md#coverage-rows)

## Reading path: organizations, who is in what

1. [Requirements: needs U26–U30, U36, U37](requirements.md#needs)
2. [Specification: entities (organizations and who is in them)](specification.md#entities)
3. [Specification: organizations](specification.md#organizations)
4. [Program Design: organizations, admission first, nothing across](program-design.html#program-design--organizations-admission-first-nothing-across-r34-r38)
5. [Verification Design: coverage rows](verification-design.md#coverage-rows)
6. [Alternatives: how organizations' Fleet data are kept apart (OD8)](alternatives.md#21-decided-how-are-organizations-fleet-data-kept-apart-od8)

## Reading path: a machine logs in

1. [Requirements: needs U17, U31–U33, U35](requirements.md#needs)
2. [Specification: machine login](specification.md#machine-login)
3. [Specification: C8 machine login by device code](specification.md#c8-machine-login-by-device-code)
4. [Specification: C9 machine token](specification.md#c9-machine-token)
5. [Program Design: machine login](program-design.html#program-design--machine-login-r39-r43-c8-c9)
6. [Program Design: how the owner logs a machine in by device code](program-design.html#program-design--how-the-owner-logs-a-machine-in-by-device-code)
7. [Verification Design: shared observations (SO8, SO9)](verification-design.md#shared-observations)
8. [Alternatives: how a machine logs in](alternatives.md#19-how-does-a-machine-log-in)

## Reading path: a session starts a helper on another machine

1. [Requirements: need U39](requirements.md#needs)
2. [Specification: R8 and R46 (membership and collaboration)](specification.md#membership-and-collaboration)
3. [Specification: C11 starting a session on another machine](specification.md#c11-starting-a-session-on-another-machine)
4. [Program Design: starting a session on another machine](program-design.html#program-design--starting-a-session-on-another-machine-r46-c11)
5. [Program Design: how a session starts a helper on another machine](program-design.html#program-design--how-a-session-starts-a-helper-on-another-machine)
6. [Verification Design: shared observations (SO11)](verification-design.md#shared-observations)
7. [Alternatives: how a session starts a helper on another machine](alternatives.md#22-how-does-a-session-start-a-helper-on-another-machine)

## Reading path: the three steps off Cloudflare Access

1. [Requirements: need U34](requirements.md#needs)
2. [Specification: machine login (R43)](specification.md#machine-login)
3. [Program Design: changes and cutover](program-design.html#program-design--changes-and-cutover)
4. [Verification Design: shared observations (SO10)](verification-design.md#shared-observations)
5. [Alternatives: how the switch happens](alternatives.md#20-how-does-the-switch-to-the-new-login-happen)
6. [Delivery plan](plans/2026-10-27-agent-identity-delivery.html)

## Reading path: who is logged in (item two)

1. [Requirements: need U40](requirements.md#needs)
2. [Requirements: item two and the later steps](requirements.md#item-two-and-the-later-steps)
3. [Specification: entities (E24 machine connection, E7 session)](specification.md#entities)
4. [Specification: who is logged in](specification.md#who-is-logged-in)
5. [Specification: C12 who is logged in](specification.md#c12-who-is-logged-in-admin-view)
6. [Specification: proof obligations (V39–V42)](specification.md#proof-obligations)
7. [Program Design: how the owner sees who is logged in](program-design.html#program-design--how-the-owner-sees-who-is-logged-in)
8. [Program Design: requests over the machine's connection (presence and activity)](program-design.html#program-design--requests-over-the-machine-s-connection-router-fleet-central)
9. [Program Design: admin commands and lookups (`WhoIsLoggedIn`)](program-design.html#program-design--admin-commands-and-lookups-person-fleet-central)
10. [Verification Design: shared observations (SO12)](verification-design.md#shared-observations)

## Reading path: machines and what they share

1. [Requirements: needs U17, U18](requirements.md#needs)
2. [Specification: machines and exposure](specification.md#machines-and-exposure)
3. [Program Design: trust boundaries](program-design.html#program-design--trust-boundaries)
4. [Verification Design: coverage rows](verification-design.md#coverage-rows)
5. [Alternatives: sessions sharing a machine](alternatives.md#13-what-about-sessions-sharing-a-machine)

## Reading path: services calling each other

1. [Requirements: needs U13, U15, U16](requirements.md#needs)
2. [Specification: R27](specification.md#hosts-outages-and-service-requests)
3. [Specification: C7 service requests](specification.md#c7-service-requests)
4. [Program Design: service requests](program-design.html#program-design--service-requests-r27-c7)
5. [Verification Design: shared observations (SO7)](verification-design.md#shared-observations)
6. [Alternatives: how services prove who's calling](alternatives.md#16-how-do-the-services-prove-whos-calling-each-other)

## Owner decisions

- [Requirements: owner decisions](requirements.md#owner-decisions) (OD2, OD4 and OD14 open; the rest decided)
- [Requirements: item two and the later steps](requirements.md#item-two-and-the-later-steps) (the owner's 2026-10-30 order of work)
- [Alternatives: OD8, decided](alternatives.md#21-decided-how-are-organizations-fleet-data-kept-apart-od8)
- [Item two delivery plan: what waits on you](../2026-10-30-item-two/plans/2026-10-30-item-two-delivery.html#item2--waiting-on-you)
