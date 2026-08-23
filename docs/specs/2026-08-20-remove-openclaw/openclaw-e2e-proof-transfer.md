# OpenClaw E2E Proof Transfer

This ledger records the proof disposition required before deleting the OpenClaw
E2E project. Product-only cases are deleted with their owner. Framework-neutral
cases retain equal-or-stronger proof through Hermes or generic VM lanes.

| Removed case | Disposition | Retained proof owner |
| --- | --- | --- |
| active operation containment | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| control admission isolation | transferred | `gateway-runtime-uds-pressure.vm.e2e.test.ts` |
| control session recovery | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| gateway startup baseline | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| gateway subtree replacement | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| lease leaf replacement | transferred | `gateway-runtime-sandbox.vm.e2e.test.ts` |
| control-link health and fatal framework replacement | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| healthy-attachment no replacement | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| observability pressure isolation | transferred | `hermes-framework-observability.hermes.e2e.test.ts` and `gateway-runtime-uds-pressure.vm.e2e.test.ts` |
| control upgrade and idle interruption | transferred | `gateway-runtime-vm-boundary.vm.e2e.test.ts` and `hermes-managed-base-environment.hermes.e2e.test.ts` |
| default OpenClaw runtime pin | OpenClaw-only delete | none |
| G1 storage boundary | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` and retained storage integration tests |
| Gateway health stability | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| MCP Portal boot and discovery | transferred | `hermes-tool-portal-orientation.hermes.e2e.test.ts` |
| MCP profile isolation and unavailable provider | transferred | `hermes-tool-portal-orientation.hermes.e2e.test.ts` |
| whole Gateway process recovery | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| repeated replacement with Tool VM access | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` and `gateway-runtime-sandbox.vm.e2e.test.ts` |
| file write/read and profile isolation | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| stale lease reacquisition | transferred | `gateway-runtime-sandbox.vm.e2e.test.ts` |
| controller-execution workspace Git route | transferred | `hermes-tool-portal-orientation.hermes.e2e.test.ts` |
| repeated recovery without flap | transferred | `hermes-managed-base-environment.hermes.e2e.test.ts` |
| exact idle Tool VM retirement | transferred | `gateway-runtime-sandbox.vm.e2e.test.ts` |
| OpenClaw plugin, channel, subagent, and native API behavior | OpenClaw-only delete | none |

The retained targets must pass after the final contract and package deletion.
Inventory-only skips do not satisfy this ledger.
