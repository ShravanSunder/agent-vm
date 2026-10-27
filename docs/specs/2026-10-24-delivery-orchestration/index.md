# Delivery orchestration design

The order of work across agent-vm and codex-router for the Tool Portal remediation, the sign-in revision and agent identity.

- Requirements: [requirements.md](requirements.md)
- Specification: [specification.md](specification.md)
- Program Design: [program-design.md](program-design.md)
- Verification Design: [verification-design.md](verification-design.md)
- People: [index.html](index.html)

It orders the work these designs define: [Tool Portal remediation](../2026-10-24-tool-portal-remediation/index.md), [agent identity](../2026-10-24-agent-identity/index.md), [people sign-in](../2026-10-20-people-sign-in/requirements.md).

## Reading path: what runs first

1. [Requirements: U1, U3](requirements.md#needs)
2. [Program Design: the order in one picture](program-design.md#the-order-in-one-picture)
3. [Program Design: slices and dependency points](program-design.md#slices-and-dependency-points)

## Reading path: why the token change can't break calls again

1. [Requirements: what went wrong without one](requirements.md#what-went-wrong-without-one)
2. [Specification: R4 contracts go live whole](specification.md#obligations)
3. [Program Design: why B4b and P1a meet only at JC2](program-design.md#slices-and-dependency-points)
4. [Verification Design: U4](verification-design.md#u4--no-half-shipped-contract)

## Reading path: the real joint proof

1. [Requirements: U6](requirements.md#needs)
2. [Program Design: joint proofs](program-design.md#joint-proofs-the-real-path)
3. [Verification Design: U6](verification-design.md#u6--the-real-joint-path)

## Reading path: decisions waiting on the owner

1. [Program Design: what happens to #262 and #263](program-design.md#what-happens-to-262-and-263)
2. [Program Design: cross-repository contracts (OD-R3)](program-design.md#cross-repository-contracts)
3. [Program Design: parked work this touches (OD-R4)](program-design.md#parked-work-this-touches)
