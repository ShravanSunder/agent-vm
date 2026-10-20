# Portable tool access: design entry

[Human walkthrough](index.html) · [Concept paths](walkthroughs.md)

## Governing documents

- [Requirements](requirements.md): authorized needs, scope and open decisions.
- [Specification](2026-10-14-portable-tool-portal-hosts.md): entity meanings and observable obligations.
- [Program Design](program-design.md): owners, package boundaries and contracts.
- [Verification Design](verification-design.md): planned deciding observations and their limits.

## Agent identity and access

1. [The operator's need](requirements.md#agent-and-machine-identity).
2. [Caller, credential and assignment meanings](2026-10-14-portable-tool-portal-hosts.md#entity-meanings).
3. [Enrollment and ingress](program-design.md#identity-login-and-revocation).
4. [Enrollment and revocation proof](verification-design.md#j8-enrollment-and-revocation).

## Approval across products

1. [Reusable approval surfaces](requirements.md#approval-surfaces).
2. [Exact protected action](2026-10-14-portable-tool-portal-hosts.md#c2-exact-protected-action).
3. [Authority and presenter boundaries](program-design.md#approvals-library-authority-and-presenter).
4. [Language-neutral contracts](program-design.md#contracts-across-typescript-python-rust-and-swift).
5. [Legacy retirement](program-design.md#retire-legacy-standalone-approvals).
6. [Durability proof](verification-design.md#j3-approval-durability-and-capacity), [surface/Router proof](verification-design.md#j9-approval-surfaces-and-router-isolation), and [cutover rehearsal](verification-design.md#j10-legacy-standalone-retirement).

## A cloud call reaches a computer

1. [Configured resources](requirements.md#configured-resources).
2. [Composition contract](2026-10-14-portable-tool-portal-hosts.md#c6-cloud-to-computer-composition).
3. [Call sequence](program-design.md#one-call-from-cloud-to-mac).
4. [Two-service proof](verification-design.md#j6-cloudcomputer-composition).

## Workspace scopes and administration

1. [The workspace need](requirements.md#workspace-configuration--u16-u17-u18).
2. [Union discovery, named calls and team accounts](2026-10-14-portable-tool-portal-hosts.md#c10--workspace-context-and-team-resources).
3. [Protected administration and audit](2026-10-14-portable-tool-portal-hosts.md#c11--workspace-administration-and-audit).
4. [React package and host route ownership](program-design.md#workspace-configuration-and-the-react-control-surface).
5. [Control and audit proof](verification-design.md#j11--workspace-administration-named-calls-and-react-cutover).
6. [Current review prototype and evidence](../../wip/2026-10-18-agent-vm-review/review.md).
