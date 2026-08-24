# OpenClaw E2E Proof Transfer

This ledger records the proof disposition required before deleting the OpenClaw
E2E project. Product-only cases are deleted with their owner. Framework-neutral
cases retain equal-or-stronger proof through Hermes or generic VM lanes.

| Removed case | Disposition | Retained proof owner |
| --- | --- | --- |
| active operation containment | transferred | `gateway-runtime-sandbox.vm.e2e.test.ts` |
| control admission isolation | transferred | `gateway-runtime-uds-pressure.vm.e2e.test.ts` |
| control session recovery | baseline-red differential pending | retained stress case in `hermes-managed-base-environment.hermes.e2e.test.ts`; exact base-versus-cutover receipt required |
| gateway startup baseline | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| gateway subtree replacement | pending independent green proof | split the pre-reattachment restart/replacement observation from the baseline-red recovery stress case |
| lease leaf replacement | transferred | `gateway-runtime-sandbox.vm.e2e.test.ts` |
| control-link health and fatal framework replacement | pending retained proof | retained Hermes/common VM lane must observe the exact health/replacement boundary |
| healthy-attachment no replacement | pending retained proof | retained Hermes/common VM lane must observe no replacement under healthy attachment |
| observability pressure isolation | transferred | `hermes-framework-observability.hermes.e2e.test.ts` and `gateway-runtime-uds-pressure.vm.e2e.test.ts` |
| control upgrade and idle interruption | pending exact retained proof | existing generic VM coverage must be checked against the removed case; port any missing idle transition |
| default OpenClaw runtime pin | OpenClaw-only delete | none |
| G1 storage boundary | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` and retained storage integration tests |
| Gateway health stability | pending independent green proof | separate the green stability observation from the baseline-red recovery stress case |
| MCP Portal boot and discovery | transferred | `hermes-tool-portal-orientation.hermes.e2e.test.ts` |
| MCP profile isolation and unavailable provider | transferred | `hermes-tool-portal-orientation.hermes.e2e.test.ts` |
| whole Gateway process recovery | pending independent green proof | retained Hermes restart/replacement case |
| repeated replacement with Tool VM access | pending retained proof | retained Hermes/common VM lane must observe repeated replacement and current Tool VM access |
| file write/read and profile isolation | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| stale lease reacquisition | pending retained proof | explicit leaf replacement does not prove stale same-handle reacquisition |
| controller-execution workspace Git route | transferred | `hermes-tool-portal-orientation.hermes.e2e.test.ts` |
| repeated recovery without flap | pending retained proof | retained Hermes recovery lane must observe repeated recovery without sibling flap |
| exact idle Tool VM retirement | pending retained proof | explicit leaf replacement does not prove idle-TTL retirement |
| protected controller-mediated Hermes SSH | pending retained proof | real controller and Hermes VM SSH path; unit stubs and direct VM inspection are insufficient |
| managed process and bounded stream operations | pending transfer audit | confirm retained real-VM process/stream coverage and port only missing operations |
| OpenClaw plugin, channel, subagent, and native API behavior | OpenClaw-only delete | none |

`transferred` means the retained target passes after the final contract and
package deletion at the same or stronger real boundary. `pending` rows are not
cutover proof. Inventory-only skips do not satisfy this ledger. The known
baseline-red recovery stress case remains separately runnable and may establish
only exact base-versus-cutover non-regression; it is never relabeled green.
