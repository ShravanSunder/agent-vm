# Lead disposition of the baseline design findings

2026-10-15 follow-up. This records source verification and draft correction,
not a replacement for independent review. The [baseline report](reviews/three-artifact-review.md)
remains unmodified with its historical `needs-revision` verdict; the subsequent
[verification](reviews/three-artifact-verification-1.md) is **ready**.

| Finding | Lead disposition | Baseline failure and decisive evidence inspected |
| --- | --- | --- |
| TA1 admission payload | Accepted; verified closed | Program Design's intent lacks canonical invocation fields required by its record/challenge. [Current protected-call schema](../../../packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-approval.ts) lines 17–47 carries full call arguments, showing the missing boundary payload rather than a new service requirement. |
| TA2 pre-send expiry | Accepted; verified closed | Program Design checks policy at arm but omits an explicit expiry guard. [Controller ledger](../../../packages/agent-vm/src/controller/approval/controller-approval-ledger.ts) lines 607–626 checks expiry before and after asynchronous input-authority validation. A live delayed reservation is not covered by restart fencing. |
| TA3 artifact binding | Accepted; verified closed | [Artifact store](../../../packages/gateway-runtime/src/artifacts/artifact-store.ts) lines 57–141 has concrete writer/range/remove interfaces and four quotas; [artifact authority](../../../packages/gateway-runtime/src/artifacts/artifact-read-authority.ts) lines 15–39 and 268–291 uses managed identity/surface/current-authority checks. [Standalone projection](../../../packages/tool-portal/src/standalone-entrypoint/standalone-tool-portal-mcp-projection.ts) lines 51–54/110–115 has a distinct caller/read contract. The proposed public caller cannot acquire managed identity by implication. |
| TA4 public result mapping | Accepted; verified closed | [Authored result schema](../../../packages/agent-portal-sdk/src/portal-call-surface/models/portal-call-result-schema.ts) lines 45–179 distinguishes success/error/approval-required and includes ambiguous error outcomes. Program Design's new pending/running/result-expired states need explicit public mappings, and its completed payload must exclude pending/ambiguous cases. |

The Lead re-opened the decisive source anchors before accepting these findings.
The corrected [Program Design](../../specs/2026-10-14-portable-tool-portal-hosts/program-design.md)
and new [boundary-contract chapter](../../specs/2026-10-14-portable-tool-portal-hosts/public-host-contracts.md)
now contain the bounded corrections. The old baseline report is preserved;
the same reviewer has verified every finding closed in the linked
[closure report](reviews/three-artifact-verification-1.md). The Lead accepted
that bounded result after source/manifest checks. No product code changed.

The pass also corrects the public-Mac-only network assumption and binds host HTTP
dispatch for ordinary fetch or VPC, separating resource and issuer credentials.
These new semantics are explicitly included in the verification commission;
they do not inherit baseline review coverage. Four changed/new SVGs were
rendered and inspected; no runtime tests or deployment proof are claimed.

The bounded three-artifact review is ready and admits library implementation
planning. It does not authorize implementation or certify deployed networking.
No second approval store, workflow engine, artifact product or result taxonomy
was added. Fleet network selection remains open for owner discussion, separate
from the network-portable library contract.
