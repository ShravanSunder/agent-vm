# Agent identity and workspace access

The agent entry to this design set. People start at [index.html](index.html), a page over the same files. This index is navigation only; every rule lives in the document it links to.

## Documents

- Requirements: [requirements.md](requirements.md). Whose need, in the owner's words, and the open owner decisions.
- Specification: [specification.md](specification.md). The entities, obligations, observable contracts, failures and proof obligations.
- Program Design: [program-design.md](program-design.md). The owners, shapes, flows, state, failure handling and trust boundaries.
- Verification Design: [verification-design.md](verification-design.md). How each requirement will be shown to hold. Planned, not observed.
- Alternatives: [alternatives.md](alternatives.md). Every option weighed, drawn. It decides nothing.

The set is one concern, so it has no capability through-lines. The task paths below cross it.

## Reading path: a session calls a tool

1. [Requirements: needs U3, U6, U10–U12](requirements.md#needs)
2. [Specification: identity and proof](specification.md#identity-and-proof)
3. [Specification: tokens and tool calls](specification.md#tokens-and-tool-calls)
4. [Specification: C1 workspace token](specification.md#c1-workspace-token)
5. [Program Design: how a session gets and uses its token](program-design.md#how-a-session-gets-and-uses-its-token)
6. [Verification Design: coverage rows](verification-design.md#coverage-rows)

## Reading path: you remove access

1. [Requirements: need U13](requirements.md#needs)
2. [Specification: removal](specification.md#removal)
3. [Specification: C3 removal notice](specification.md#c3-removal-notice)
4. [Program Design: how a removal reaches the Tool Portal](program-design.md#how-a-removal-reaches-the-tool-portal)
5. [Program Design: removal across owners](program-design.md#removal-across-owners-r19r21)
6. [Program Design: state](program-design.md#state)
7. [Verification Design: coverage rows](verification-design.md#coverage-rows)
8. [Alternatives: keeping a removal and a token in order](alternatives.md#6-how-do-a-removal-and-a-token-minted-at-about-the-same-time-stay-in-order)

## Reading path: a bot gets a token

1. [Requirements: needs U2, U5](requirements.md#needs)
2. [Specification: identity and proof](specification.md#identity-and-proof)
3. [Specification: membership and collaboration](specification.md#membership-and-collaboration)
4. [Specification: C2 token issuance](specification.md#c2-token-issuance)
5. [Program Design: how a bot gets its tokens](program-design.md#how-a-bot-gets-its-tokens)
6. [Verification Design: coverage rows](verification-design.md#coverage-rows)

## Reading path: a session messages another workspace

1. [Requirements: needs U7, U8, U19](requirements.md#needs)
2. [Specification: membership and collaboration](specification.md#membership-and-collaboration)
3. [Specification: C5 collaboration attribution and messaging](specification.md#c5-collaboration-attribution-and-messaging)
4. [Program Design: collaboration admission](program-design.md#collaboration-admission-router--fleet-central-r28)
5. [Program Design: how a collaboration call is attributed](program-design.md#how-a-collaboration-call-is-attributed)
6. [Alternatives: where collaboration is checked](alternatives.md#18-where-is-a-collaboration-message-or-board-write-checked)
7. [Verification Design: coverage rows](verification-design.md#coverage-rows)

## Reading path: Fleet central is down

1. [Requirements: need U14](requirements.md#needs)
2. [Specification: hosts, outages and service requests](specification.md#hosts-outages-and-service-requests)
3. [Specification: failure and partial outcomes](specification.md#failure-and-partial-outcomes)
4. [Program Design: failure, recovery and concurrency](program-design.md#failure-recovery-and-concurrency)
5. [Verification Design: coverage rows](verification-design.md#coverage-rows)

## Reading path: machines and what they share

1. [Requirements: needs U17, U18](requirements.md#needs)
2. [Specification: machines and exposure](specification.md#machines-and-exposure)
3. [Program Design: trust boundaries](program-design.md#trust-boundaries)
4. [Verification Design: coverage rows](verification-design.md#coverage-rows)
5. [Alternatives: how a machine proves it is yours](alternatives.md#7-how-does-a-machine-prove-it-is-yours)
6. [Alternatives: sessions sharing a machine](alternatives.md#13-what-about-sessions-sharing-a-machine)

## Reading path: services calling each other

1. [Requirements: needs U13, U15, U16](requirements.md#needs)
2. [Specification: R27](specification.md#hosts-outages-and-service-requests)
3. [Specification: C7 service requests](specification.md#c7-service-requests)
4. [Program Design: service requests](program-design.md#service-requests-r27-c7)
5. [Verification Design: shared observations (SO7)](verification-design.md#shared-observations)
6. [Alternatives: how services prove who's calling](alternatives.md#16-how-do-the-services-prove-whos-calling-each-other)

## Open owner decisions

- [Requirements: open owner decisions](requirements.md#open-owner-decisions) (OD1, OD2, OD3)
- [Alternatives: OD1 drawn](alternatives.md#14-open-who-may-start-a-session-in-a-workspace-od1)
- [Alternatives: OD3 drawn](alternatives.md#15-open-is-a-bot-automatically-a-collaborator-of-every-other-workspace-od3)
