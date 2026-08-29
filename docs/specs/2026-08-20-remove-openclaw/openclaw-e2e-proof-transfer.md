# OpenClaw E2E Proof Transfer

This ledger records the proof disposition required before deleting the OpenClaw
E2E project. Product-only cases are deleted with their owner. Framework-neutral
cases retain equal-or-stronger proof through Hermes or generic VM lanes.

| Removed case | Disposition | Retained proof owner |
| --- | --- | --- |
| active operation containment | transferred | `gateway-runtime-sandbox.vm.e2e.test.ts` |
| control admission isolation | transferred | `gateway-runtime-uds-pressure.vm.e2e.test.ts` |
| control session recovery | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` proves the first post-reattachment Tool VM operation succeeds through the integrated upstream recovery without creating a replacement Tool VM process |
| gateway startup baseline | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| gateway subtree replacement | transferred | `controller-restart-cleanup.vm.e2e.test.ts` fails closed on ambiguous ownership, destroys the exact C1 Tool leaves before Gateway, and publishes C2; `live-controller-restart-vm-ownership.vm.e2e.test.ts` independently proves the controller-front-door successor |
| lease leaf replacement | transferred | `gateway-runtime-sandbox.vm.e2e.test.ts` |
| control-link health and fatal framework replacement | deferred runtime-owner qualification | current Hermes health/startup/stability proof is retained; fatal-framework automatic replacement qualification is recorded in `docs/wip/2026-08-26-post-openclaw-removal-follow-ups.md` and does not authorize runtime changes here |
| healthy-attachment no replacement | transferred | the green restart case in `hermes-managed-base-environment.hermes.e2e.test.ts` proves stable Gateway VM ownership and unchanged framework/Tool Portal sibling process identities while the accepted attachment remains healthy |
| observability pressure isolation | transferred | `hermes-framework-observability.hermes.e2e.test.ts` and `gateway-runtime-uds-pressure.vm.e2e.test.ts` |
| control upgrade and idle interruption | deferred runtime-owner qualification | the removed OpenClaw transport/lifecycle sequence is not adopted as a new Hermes cutover contract; current Hermes reattachment recovery is transferred above while non-equivalent upgrade and idle semantics remain separate |
| default OpenClaw runtime pin | OpenClaw-only delete | none |
| G1 storage boundary | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` and retained storage integration tests |
| Gateway health stability | transferred | the green restart case in `hermes-managed-base-environment.hermes.e2e.test.ts` is independently runnable with the reattachment stress gate closed and proves root API health plus stable sibling identities |
| MCP Portal boot and discovery | transferred | `hermes-tool-portal-orientation.hermes.e2e.test.ts` |
| MCP profile isolation and unavailable provider | transferred | `hermes-tool-portal-orientation.hermes.e2e.test.ts` |
| whole Gateway process recovery | deferred runtime-owner qualification | current Hermes clean restart and healthy-attachment stability are green; fatal-framework automatic recovery remains separate qualification |
| repeated replacement with Tool VM access | deferred runtime-owner qualification | repeated automatic replacement plus fresh Tool VM access is recorded for the separate runtime owner |
| file write/read and profile isolation | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| stale lease reacquisition | deferred runtime-owner qualification | stock Hermes cached-environment reacquisition semantics are not changed by this cutover; explicit leaf replacement remains the retained green proof |
| controller-execution workspace Git route | transferred | `hermes-tool-portal-orientation.hermes.e2e.test.ts` |
| repeated recovery without flap | deferred runtime-owner qualification | the removed three-recovery sequence is recorded for separate Hermes runtime qualification; current healthy-attachment no-flap proof remains green |
| exact idle Tool VM retirement | deferred runtime-owner qualification | the removed stateless OpenClaw call does not map mechanically to Hermes' cached active environment; the source-backed mismatch is recorded in the WIP |
| protected controller-mediated Hermes SSH | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` exercises wrong-token denial, controller-issued access, real SSH, and the Hermes shell environment through the live Gateway VM |
| managed process and bounded stream operations | transferred | `gateway-runtime-sandbox.vm.e2e.test.ts` exercises real private-UDS process start/wait plus strict-SSH stream write/close/read |
| OpenClaw plugin, channel, subagent, and native API behavior | OpenClaw-only delete | none |

`transferred` means the retained target passes after the final contract and
package deletion at the same or stronger real boundary. `deferred runtime-owner
qualification` means the removed scenario is not an equivalent current Hermes
contract, its strongest retained evidence and gap are explicit, and this branch
does not change Hermes to manufacture parity. No `pending` row remains.
Inventory-only skips do not satisfy this ledger. The post-control-reattachment
case is green because its separately owned recovery entered through the
integrated master baseline, not because this cutover weakened or relabeled a
failing assertion.
