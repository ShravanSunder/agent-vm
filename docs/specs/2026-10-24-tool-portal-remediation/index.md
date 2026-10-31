# Switchboard remediation design

Fixes the Switchboard code from PR #262 so it follows the owner's rules: one core every runtime injects into, Drizzle on SQLite, strong types, deterministic tests, the owner's gates, one version of each dependency, and the known defects fixed.

- Requirements: [requirements.md](requirements.md)
- Specification: [specification.md](specification.md)
- Program Design: [program-design.html](program-design.html), authored in program-design.source.html, one section per heading
- Verification Design: [verification-design.md](verification-design.md)
- People: [index.html](index.html)

Beside it: the [agent identity](../2026-10-24-agent-identity/index.md) and [people sign-in](../2026-10-20-people-sign-in/requirements.md) designs (revised in place), and the [delivery orchestration](../2026-10-24-delivery-orchestration/index.md) set that orders the work across agent-vm and codex-router.

## Through-line: `one-core`

1. [Requirements: U1, U6](requirements.md#needs)
2. [Specification: one core, injected](specification.md#one-core-one-core-injected)
3. [Program Design: platform capabilities](program-design.html#program-design--platform-capabilities-the-one-list)
4. [Verification Design: U1, U6](verification-design.md#u1--one-core-every-runtime-only-injects)

## Through-line: `storage`

1. [Requirements: U2–U5](requirements.md#needs)
2. [Specification: Drizzle on SQLite](specification.md#storage-drizzle-on-sqlite)
3. [Program Design: the workspace store](program-design.html#program-design--the-workspace-store)
4. [Verification Design: U2–U5](verification-design.md#u5--nothing-that-must-survive-is-lost-on-restart)

## Through-line: `type-safety`

1. [Requirements: U7, U8](requirements.md#needs)
2. [Specification: types that say what is valid](specification.md#type-safety-types-that-say-what-is-valid)
3. [Program Design: platform capabilities and store results](program-design.html#program-design--operations-and-results)
4. [Verification Design: U7, U8](verification-design.md#u7--type-safety-discriminated-unions-the-type-check-guard)

## Through-line: `deterministic-tests`

1. [Requirements: U9, U11, U15](requirements.md#needs)
2. [Specification: tests that never read the clock](specification.md#deterministic-tests-tests-that-never-read-the-clock)
3. [Program Design: what moves behind the capabilities](program-design.html#program-design--platform-capabilities-the-one-list)
4. [Verification Design: U9, U11, U15](verification-design.md#u9--no-wall-clock-in-tests)

## Through-line: `build-hygiene`

1. [Requirements: U10, U12](requirements.md#needs)
2. [Specification: clean build, owner's gates](specification.md#build-hygiene-clean-build-owners-gates)
3. [Program Design: clean build and gates](program-design.html#program-design--clean-build-and-gates)
4. [Verification Design: U10, U12](verification-design.md#u10--gates-as-approved)

## Through-line: `known-defects`

1. [Requirements: U13, U14](requirements.md#needs)
2. [Specification: findings and deployed failures fixed](specification.md#known-defects-findings-and-deployed-failures-fixed)
3. [Program Design: the defects and their owners](program-design.html#program-design--the-defects-and-their-owners)
4. [Verification Design: U13, U14](verification-design.md#u13--known-defects-fixed)

## Reading path: a used approval after a restart

1. [Requirements: U5 and the change from the Switchboard design](requirements.md#what-this-work-changes-from-the-switchboard-design)
2. [Specification: R7, R8](specification.md#storage-drizzle-on-sqlite)
3. [Program Design: how each decision stays atomic](program-design.html#program-design--how-each-decision-stays-atomic)
4. [Program Design: approval-use lifecycle](program-design.html#program-design--approval-use-lifecycle)
5. [Verification Design: O2 restart and redeploy](verification-design.md#shared-observations)
