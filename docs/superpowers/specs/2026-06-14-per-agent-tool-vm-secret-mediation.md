# Per-Agent Tool VM Secret Mediation

Date: 2026-06-14
Status: design ready for implementation planning

## Problem

OpenClaw Tool VM mediated secrets are currently zone-wide. A secret declared under
`zones[].secrets` with `audience: "tool-vm"` or `audience: "both"` and
`injection: "http-mediation"` is resolved for every Tool VM in that zone. That is
too broad for secrets such as a Sun-only GitHub token, where the raw value must
stay on the controller host and the mediated placeholder must only enter Sun's
Tool VM.

The feature should let a zone define a secret once and then bind Tool VM delivery
to specific OpenClaw agents, without turning worker `runtimeAuthHints`,
OpenClaw auth profiles, or sandbox seed files into the secret-delivery policy.

## Current Model

The current config schema keeps the zone secret catalog under `zones[].secrets`.
Mediated secrets carry source, injection, audience, and hosts. Tool VM secrets
must be mediated; raw env secrets are gateway-only. This is enforced by the
strict secret schemas in
`packages/agent-vm/src/config/system-config.ts:52` and by the Tool VM resolution
path in `packages/agent-vm/src/gateway/credential-manager.ts:31`.

OpenClaw already has agent identity at the right boundary:

1. The OpenClaw plugin derives `agentId` from the OpenClaw session key before
   requesting a lease:
   `packages/openclaw-agent-vm-plugin/src/sandbox-backend/sandbox-backend-handle-factory.ts:202`.
2. The controller validates that `agentId` matches the session key:
   `packages/agent-vm/src/controller/http/controller-http-routes.ts:166`.
3. The `/lease` route uses `agentId` for profile selection, work-mount
   resolution, sandbox seeding, and lease creation:
   `packages/agent-vm/src/controller/http/controller-http-routes.ts:409`.
4. The lease manager keys active leases by `{ zoneId, agentId }` and preserves
   `agentId` in runtime records:
   `packages/agent-vm/src/controller/leases/lease-manager.ts:276`.
5. `agentId` is then dropped at the controller runtime to Tool VM lifecycle
   handoff. `createManagedToolVm` calls `createToolVm` without `agentId`:
   `packages/agent-vm/src/controller/controller-runtime.ts:404` and
   `packages/agent-vm/src/controller/controller-runtime.ts:445`.

The Tool VM lifecycle then resolves all zone Tool VM mediated secrets:
`packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:234`. That means the
current secret intake point is agent-blind even though the caller still has
trusted lease identity one frame earlier.

## Design

Add an inline `agentAccess` field to every mediated secret that can reach Tool
VMs:

```jsonc
{
  "zones": [
    {
      "id": "sunfam",
      "secrets": {
        "GITHUB_TOKEN": {
          "source": "1password",
          "ref": "op://agent-vm/example-sun-github/credential",
          "injection": "http-mediation",
          "audience": "tool-vm",
          "hosts": ["api.github.com", "github.com"],
          "agentAccess": ["sun"]
        },
        "READWISE_ACCESS_TOKEN": {
          "source": "1password",
          "ref": "op://agent-vm/shared-readwise/credential",
          "injection": "http-mediation",
          "audience": "tool-vm",
          "hosts": ["mcp2.readwise.io"],
          "agentAccess": "all"
        }
      }
    }
  ]
}
```

`zones[].secrets` remains the single authored place for secret source,
mediation, runtime audience, allowed hosts, and agent delivery. The existing
`audience` field says which runtime surface can use the secret. The new
`agentAccess` field says which declared OpenClaw agents may receive the Tool VM
placeholder.

`agentAccess` has no hidden default:

- `"all"` delivers the Tool VM placeholder to every declared agent in the zone.
- `["sun"]` delivers the Tool VM placeholder only to Sun.
- omission is invalid for any mediated secret whose audience reaches Tool VMs.

For `audience: "both"`, `agentAccess` scopes only the Tool VM side. The gateway
side remains zone-level because the gateway is not an agent-scoped Tool VM. If a
credential should not be available to the gateway, use `audience: "tool-vm"`.

## Validation

Add schema support in `packages/agent-vm/src/config/system-config.ts`.

Recommended authored type:

```ts
type AgentAccess = 'all' | readonly AgentId[];

type HttpMediatedToolVmReachableSecret = SecretSource & {
	readonly injection: 'http-mediation';
	readonly audience: 'tool-vm' | 'both';
	readonly hosts: readonly string[];
	readonly agentAccess: AgentAccess;
};

type HttpMediatedGatewayOnlySecret = SecretSource & {
	readonly injection: 'http-mediation';
	readonly audience: 'gateway';
	readonly hosts: readonly string[];
};
```

Validation rules:

1. If a zone secret uses `injection: "http-mediation"` and `audience:
   "tool-vm"` or `"both"`, `agentAccess` is required.
2. `agentAccess` must be exactly `"all"` or a non-empty array of valid agent IDs.
3. The OpenClaw zone must declare at least one `zones[].agents[]` entry before a
   Tool VM-reaching mediated secret can use `agentAccess`.
4. Every listed agent ID must exist in `zones[].agents[]`. Secret isolation
   should fail on typos.
5. `agentAccess` is OpenClaw-only. Worker zones must reject Tool VM-reachable
   secrets with `agentAccess` because worker zones do not boot OpenClaw Tool VMs.
6. If a secret uses `audience: "gateway"`, reject `agentAccess`.
7. Existing mediated-host validation remains canonical:
   `packages/agent-vm/src/config/system-config.ts:967`.
8. Tool VM reserved environment name rejection remains in the Tool VM bootstrap
   path. New tests should preserve the existing guard covered in
   `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.unit.test.ts:437`.

The schema should prefer type-level structure where practical by splitting
gateway-only mediated secrets from Tool VM-reachable mediated secrets. Use
`superRefine` for cross-object checks that need the zone's declared agent list
or gateway type.

`agentAccess` should also be surfaced by `agent-vm validate` and `agent-vm
doctor` diagnostics. Deployment authors need actionable validation output for
missing `agentAccess`, unknown agent IDs, invalid gateway-only usage, and stale
configs that still rely on the old implicit zone-wide Tool VM behavior.

## Runtime Flow

Thread `agentId` into Tool VM creation:

1. Extend the dependency type used by `createManagedToolVm` in
   `packages/agent-vm/src/controller/controller-runtime-types.ts`.
2. Pass `leaseOptions.agentId` through
   `packages/agent-vm/src/controller/controller-runtime.ts:447`.
3. Add `agentId` to `createToolVm` options in
   `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:200`.

Resolve only the selected secrets:

1. Add a helper such as `secretTargetsToolVmAgent`.
2. The helper reads the secret config and `agentId`.
3. A secret with `agentAccess: "all"` targets every declared zone agent.
4. A secret with `agentAccess: ["sun"]` targets only those listed agents.
5. Selection rejects Tool VM-mediated secret access for undeclared lease agents.
6. Omitted `agentAccess` is already invalid for Tool VM-reachable mediated
   secrets, so runtime selection does not need legacy fallback behavior.
7. Pass the selected name set into a resolver before `resolveAll`, so secrets
   for other agents are not resolved in host memory just to be discarded later.
8. Reject resolver output that contains Tool VM secret names outside the selected
   set, so an over-returning cache or resolver cannot install unauthorized
   placeholders.

This can be implemented either by adding an optional name filter to
`resolveZoneSecrets` or by adding a Tool VM-specific resolver next to it. The
important boundary is that filtering happens before `SecretResolver.resolveAll`.

Do not add `agentAccess` logic to `GatewayZoneConfig` unless a later gateway
runtime actually needs it. Tool VM creation already receives `LoadedSystemConfig`
and can enforce this policy without changing OpenClaw gateway VM config assembly.

## Security Invariants

The feature preserves the existing mediation model:

- raw secret values resolve only on the controller host.
- Tool VMs receive placeholder values only.
- placeholders are capabilities inside the Tool VM for allowed hosts; this
  feature limits which Tool VM receives which placeholders, but it does not stop
  code inside an authorized Tool VM from using its own placeholder.
- gateway raw env secrets and OpenClaw auth-profile files remain separate
  mechanisms.
- worker `runtimeAuthHints` remain worker-only. OpenClaw zones still must not
  declare them; see `docs/subsystems/secrets-and-credentials.md:302` and
  `packages/agent-vm/src/config/system-config.ts:1096`.
- `host.githubToken` remains controller-only for host git operations and never
  enters a VM; see the boundary table in
  `docs/subsystems/secrets-and-credentials.md:320`.

## Non-Goals

- Do not add raw env injection for Tool VM secrets.
- Do not make OpenClaw consume worker `runtimeAuthHints`.
- Do not store per-agent secret source definitions under `agents[]`.
- Do not add a separate zone-level binding table. The secret's agent access
  belongs next to the secret's source, audience, mediation mode, and hosts.
- Do not solve gateway compromise. The gateway VM remains a higher-privilege
  runtime because it can hold gateway raw env secrets and read auth profile files.
- Do not broaden HTTP mediation to unsupported transports or body/path auth.

## Testing And Proof Gates

Unit tests:

- `packages/agent-vm/src/config/system-config.unit.test.ts`
  - accepts `agentAccess: "all"` on a Tool VM mediated secret when the zone has
    declared agents.
  - accepts `agentAccess: ["sun"]` on a Tool VM mediated secret.
  - accepts `agentAccess` on `audience: "both"` and documents that it scopes
    only Tool VM delivery.
  - rejects missing `agentAccess` on `audience: "tool-vm"` or `"both"`.
  - rejects `agentAccess` on `audience: "gateway"`.
  - rejects unknown agent IDs.
  - rejects empty agent-access arrays.
  - rejects worker-zone Tool VM agent access.
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.unit.test.ts`
  - selected agent receives secrets with `agentAccess: "all"` plus secrets whose
    `agentAccess` includes that agent.
  - undeclared lease agents cannot select Tool VM-mediated secrets, including
    `agentAccess: "all"` secrets.
  - a different agent does not receive another agent's scoped secret.
  - unauthorized scoped secrets are not resolved at all.
  - placeholder bootstrap never contains raw secret values.
  - reserved env-name rejection still applies.
- `packages/agent-vm/src/controller/controller-runtime.unit.test.ts`
  - `leaseOptions.agentId` is forwarded into Tool VM creation.

Integration tests:

- Add a config-validation integration case for the new field so generated
  validation output is useful for deployment authors.
- Add or update doctor coverage so `agent-vm doctor` reports stale/missing
  `agentAccess` configuration clearly.
- If the controller HTTP route test surface already captures lease creation
  options, prove the `/lease` path preserves `agentId` into the Tool VM create
  dependency.

Live proof before release:

- Keep existing VM mediation proofs that raw values do not enter Tool VM env and
  allowed-host mediation works:
  `packages/agent-vm/src/integration-tests/live-http-mediation.vm.e2e.test.ts`
  and
  `packages/agent-vm/src/integration-tests/live-tool-vm-mediated-env.vm.e2e.test.ts`.
- Add an OpenClaw or VM mediation proof with two agents and two local test
  tokens before claiming the real product path. Agent A must not receive or
  resolve agent B's scoped secret.

Quality gates:

- targeted unit and integration tests while iterating.
- `pnpm validate` or the repo-local validation command for a generated/sample
  config that exercises `agentAccess`.
- `pnpm check`.
- `mise exec -- pnpm test:e2e:vm-mediation` or the narrower live mediation lane
  if the implementation touches the VM mediation path.

Docs and generated surfaces:

- Update `docs/reference/configuration/system-json.md`.
- Update `docs/subsystems/secrets-and-credentials.md`.
- Update `packages/agent-vm/src/cli/manual-templates.ts`.
- Update `packages/agent-vm/src/cli/manual-templates.unit.test.ts`.
- Update any generated JSON schema or config reference output if this repo emits
  one for deployment validation.

## Deployment Cutover

Before this feature ships, a Sun-only GitHub token should not be declared as a
shared Tool VM zone secret. Keep `host.githubToken` for controller-owned git
pushes and remove the shared `zones[].secrets.GITHUB_TOKEN` entry.

After this feature ships, a Sun-only GitHub token can be configured as:

```jsonc
{
  "secrets": {
    "GITHUB_TOKEN": {
      "source": "1password",
      "ref": "op://agent-vm/example-sun-github/credential",
      "injection": "http-mediation",
      "audience": "tool-vm",
      "hosts": ["api.github.com", "github.com"],
      "agentAccess": ["sun"]
    }
  }
}
```

That configuration gives Sun's Tool VM a mediated placeholder for GitHub hosts.
Mak and Ember do not receive the placeholder and the controller should not
resolve that secret for their Tool VM leases.
