# Tool VM Mediated CLI Auth Implementation Plan

Status: shipped baseline / reference-only for future credentialed runner work. Do not execute this plan as a new implementation plan.

Use this for:
- Audience-scoped egress and secret mediation vocabulary.
- The rule that Tool VMs never receive raw `env` secrets.
- Understanding the shipped HTTP-mediation substrate that later credentialed designs can reuse.

Do not use this for:
- Full credentialed CLI runner design.
- Controller-owned Gondolin `vm.exec` / `vm.fs` execution.
- Generic lease capability design.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or
> `superpowers:executing-plans` to implement this plan task-by-task. Use TDD for
> behavior changes. Do not commit unless the human explicitly asks for git write
> operations.

**Goal:** Let OpenClaw Tool VMs use explicitly scoped Gondolin
HTTP-mediated service tokens and egress hosts, so CLIs like `gh`, `linear`, and
`readwise` work without raw secrets entering Tool VMs.

**Revised premise:** Gateway VMs and Tool VMs do not implicitly share egress or
secret policy. Every host and zone secret must declare an explicit `audience`.
Missing audience is invalid configuration.

**Audience values:**

- `gateway` — visible only to the gateway VM.
- `tool-vm` — visible only to OpenClaw Tool VMs.
- `both` — visible to both gateway and Tool VMs.

**Security boundary:**

- Gateway VMs receive egress hosts with audience `gateway | both`.
- Tool VMs receive egress hosts with audience `tool-vm | both`.
- Gateway VMs receive `env` secrets with audience `gateway`.
- Gateway VMs receive `http-mediation` secrets with audience `gateway | both`.
- Tool VMs receive only `http-mediation` secrets with audience `tool-vm | both`.
- Tool VMs never resolve or receive `env` secrets.

## Problem Model

Current Tool VMs are created in
`packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts` with:

```ts
allowedHosts: [],
secrets: {},
```

The original fix proposed passing the zone's entire `allowedHosts` and all
zone `http-mediation` secrets into Tool VMs. That is too broad: gateway
infrastructure and agent workloads have different trust boundaries.

The correct fix is a hard cutover to explicit scoped policy:

```jsonc
"egressHosts": [
  { "host": "api.github.com", "audience": "both" },
  { "host": "api.linear.app", "audience": "tool-vm" },
  { "host": "mcp2.readwise.io", "audience": "tool-vm" },
  { "host": "discord.com", "audience": "gateway" }
]
```

```jsonc
"secrets": {
  "GITHUB_TOKEN": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-github/credential",
    "injection": "http-mediation",
    "audience": "both",
    "hosts": ["api.github.com"]
  },
  "LINEAR_API_KEY": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-linear/credential",
    "injection": "http-mediation",
    "audience": "tool-vm",
    "hosts": ["api.linear.app"]
  },
  "READWISE_ACCESS_TOKEN": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-shravan-readwise/credential",
    "injection": "http-mediation",
    "audience": "tool-vm",
    "hosts": ["mcp2.readwise.io"]
  },
  "DISCORD_BOT_TOKEN": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-discord/bot-token",
    "injection": "env",
    "audience": "gateway"
  }
}
```

## Design Decisions

- Replace `zones[].allowedHosts: string[]` with
  `zones[].egressHosts: { host: string; audience: "gateway" | "tool-vm" | "both" }[]`.
- Add required `audience` to every zone secret.
- Keep `injection` explicit. Do not add defaults for `injection` or `audience`.
- Reject `env` secrets unless `audience: "gateway"`.
- Treat `runtimeAuthHints` as worker-gateway runtime instructions only. Reject
  them on OpenClaw zones until there is a real OpenClaw Tool VM instruction
  surface. Worker hints must reference `injection: "http-mediation"` secrets
  with audience `gateway | both`.
- Resolve only Tool VM mediated secrets for Tool VM leases. Do not resolve
  gateway-only or raw `env` secrets on the Tool VM path.
- Use `mcp2.readwise.io` for Readwise CLI auth. The Readwise CLI stores the
  placeholder token and sends it to `https://mcp2.readwise.io/mcp` in the
  `Authorization` header, which Gondolin can substitute.

## Implementation Status

This plan has been implemented. xhigh GPT reviewer passes found P2 issues, and
all P2 findings were fixed before final verification:

- `resolveZoneSecrets()` now requires an explicit runtime audience at the
  exported TypeScript API boundary.
- The worker getting-started guide no longer shows OpenClaw-only Tool VM
  profile fields in a worker zone.
- Schema tests now prove the actual missing-secret-audience case and the
  worker-specific `runtimeAuthHints` audience rules for `gateway`, `both`, and
  rejected Tool VM-only secrets.
- The generated OpenClaw channels manual no longer tells users to add
  `runtimeAuthHints`, and a regression test covers that guidance.

The full unit, smoke, typecheck, lint, format, and diff whitespace gates pass.
The live integration command still has two QEMU/network failures unrelated to
the audience policy work:

- `live-sandbox-e2e.integration.test.ts` receives `400 Bad Request` from the
  controller health probe inside the gateway VM.
- `live-cross-vm-ssh.integration.test.ts` receives SSH exit code `255` from
  gateway-to-tool VM SSH.

## File Structure

- Modify `packages/agent-vm/src/config/system-config.ts`
  - Add audience schemas.
  - Replace `allowedHosts` with `egressHosts`.
  - Validate secret and runtime auth audience rules.

- Modify `packages/gateway-interface/src/gateway-lifecycle.ts`
  - Add `VmAudience`, `EgressHostConfig`, and audience-bearing secret config
    types to `GatewayZoneConfig`.

- Add or modify gateway-interface helpers
  - Provide `egressHostsForAudience()`.
  - Provide audience-aware secret splitting.
  - Keep `splitResolvedGatewaySecrets()` as the gateway wrapper.

- Modify gateway lifecycles
  - `packages/openclaw-gateway/src/openclaw-lifecycle.ts`
  - `packages/worker-gateway/src/worker-lifecycle.ts`
  - Pass only gateway egress hosts and gateway-scoped secrets to Gondolin.

- Modify Tool VM lifecycle
  - `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
  - Add `secretResolver`.
  - Resolve only mediated secrets with audience `tool-vm | both`.
  - Pass only Tool VM egress hosts to Gondolin.

- Modify controller runtime
  - `packages/agent-vm/src/controller/controller-runtime-types.ts`
  - `packages/agent-vm/src/controller/controller-runtime.ts`
  - Thread the controller `secretResolver` into Tool VM creation.

- Modify worker runtime instruction builder
  - Add Linear recipe.
  - Add Readwise recipe using `readwise login-with-token "$READWISE_ACCESS_TOKEN"`.
  - Use Readwise smoke command
    `readwise reader-search-documents --query "test"`.

- Modify init/default config generation
  - `packages/agent-vm/src/cli/init-command.ts`
  - Generate `egressHosts` entries with explicit audience.
  - Generate secrets with explicit `injection` and `audience`.

- Update docs and generated manual templates
  - `docs/reference/configuration/system-json.md`
  - `docs/subsystems/secrets-and-credentials.md`
  - `docs/subsystems/gateway-lifecycle.md`
  - `docs/subsystems/gondolin-vm-layer.md`
  - `docs/architecture/overview.md`
  - `docs/getting-started/*.md`
  - `packages/agent-vm/src/cli/manual-templates.ts`

## Task 1: Schema Tests First

- [x] Add failing tests in `packages/agent-vm/src/config/system-config.test.ts`
  proving:
  - `allowedHosts` is no longer accepted.
  - `egressHosts` requires explicit `audience`.
  - zone secrets require explicit `audience`.
  - `env` secrets reject `tool-vm` and `both`.
  - `http-mediation` secrets require `hosts`.
  - OpenClaw `runtimeAuthHints` are rejected because they do not reach Tool VMs.
  - Worker `runtimeAuthHints` reject Tool VM-only secrets.
  - Worker `runtimeAuthHints` accept `gateway` and `both` mediated secrets.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/config/system-config.test.ts --testNamePattern "audience|egressHosts|runtimeAuthHints"
```

Expected: FAIL for missing schema support.

## Task 2: Gateway-Interface Audience Helpers

- [x] Add failing tests for:
  - `egressHostsForAudience()` returns only `gateway | both` for gateway.
  - `egressHostsForAudience()` returns only `tool-vm | both` for Tool VM.
  - `splitResolvedSecretsByInjection(..., { audience: "gateway" })` returns
    gateway env and mediated secrets only.
  - `splitResolvedSecretsByInjection(..., { audience: "tool-vm" })` returns
    only Tool VM mediated secrets.
  - resolved secrets outside the requested audience are ignored without warning.
  - resolved secrets missing from config still warn.

Suggested files:

- `packages/gateway-interface/src/audience.test.ts`
- `packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts`

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/gateway-interface/src/audience.test.ts packages/gateway-interface/src/split-resolved-gateway-secrets.test.ts
```

Expected: FAIL for missing helpers/types.

## Task 3: Implement Schema And Helpers

- [x] Add `audience` schemas and types.
- [x] Replace `allowedHosts` with `egressHosts`.
- [x] Remove default injection behavior from zone secrets if present.
- [x] Export reusable audience and splitting helpers.
- [x] Update `GatewayZoneConfig` to carry `egressHosts` and secret audience.

Run the Task 1 and Task 2 tests. Expected: PASS.

## Task 4: Wire Gateway Runtime

- [x] Update OpenClaw and Worker gateway lifecycle tests so gateway VM specs
  receive only `gateway | both` egress hosts and secrets.
- [x] Update `buildGatewayZoneSupport()` and lifecycle code to pass scoped
  hosts/secrets.
- [x] Keep `env` injection gateway-only.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/openclaw-gateway/src/openclaw-lifecycle.test.ts packages/worker-gateway/src/worker-lifecycle.test.ts packages/agent-vm/src/gateway/gateway-zone-orchestrator.test.ts
```

Expected: PASS.

## Task 5: Wire Tool VM Runtime

- [x] Add Tool VM tests proving:
  - Tool VM creation receives only `tool-vm | both` egress hosts.
  - Tool VM creation receives only `tool-vm | both` mediated secrets.
  - Gateway-only mediated secrets are not passed.
  - `env` secrets are not passed.
  - `env` secrets are not resolved by the Tool VM path.
- [x] Add `secretResolver` to `createToolVm()` options.
- [x] Resolve only Tool VM mediated secrets.
- [x] Pass Tool VM egress hosts and mediated secrets into `createManagedVm()`.
- [x] Thread `secretResolver` from controller runtime into Tool VM leases.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/tool-vm/tool-vm-lifecycle.test.ts packages/agent-vm/src/controller/controller-runtime.test.ts
```

Expected: PASS.

## Task 6: Worker Runtime Auth Recipes

- [x] Add failing tests for Linear and Readwise recipes.
- [x] Add Linear recipe using `LINEAR_API_KEY`.
- [x] Add Readwise recipe using
  `readwise login-with-token "$READWISE_ACCESS_TOKEN"`.
- [x] Keep these recipes scoped to the worker runtime instruction builder; do
  not claim they configure OpenClaw Tool VM instructions.
- [x] Make examples use `mcp2.readwise.io`.

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/runtime-instructions-builder.test.ts
```

Expected: PASS.

## Task 7: Init Defaults And Fixtures

- [x] Update generated configs from `allowedHosts` to `egressHosts`.
- [x] Add explicit secret `audience` everywhere generated config emits secrets.
- [x] Update all tests and fixtures for the hard cutover.

Run targeted CLI/init/config tests:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/cli/init-command.test.ts packages/agent-vm/src/operations/config-validation.test.ts
```

Expected: PASS.

## Task 8: Docs And Manuals

- [x] Update docs from `allowedHosts` to `egressHosts`.
- [x] Explain audience rules in the configuration reference.
- [x] Explain gateway-vs-Tool-VM secret behavior in subsystem docs.
- [x] Update manual templates and manual template tests if generated manuals
  mention allowlists.

Run:

```bash
pnpm fmt:check
```

Expected: PASS.

## Task 9: Full Validation And Review

- [x] Run focused unit tests for touched packages.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm check`.
- [x] Request an xhigh GPT reviewer pass on the final diff.
- [x] Fix all P0/P1/P2 findings or explicitly reconverge before proceeding.

Final verification evidence:

- `pnpm check`: exit 0.
- `pnpm test:unit`: exit 0; 126 files passed, 1087 tests passed, 1 skipped.
- `pnpm test:smoke`: exit 0; 5 files passed, 6 tests passed.
- `git diff --check`: exit 0.
- `pnpm test:integration`: exit 1; 8 files passed, 1 skipped, 17 tests passed,
  2 skipped, 2 live VM tests failed as noted in Implementation Status.

## Deployment Notes for shravan-claw

After publish/install, use explicit audiences:

```jsonc
"secrets": {
  "GITHUB_TOKEN": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-github/credential",
    "injection": "http-mediation",
    "audience": "both",
    "hosts": ["api.github.com"]
  },
  "LINEAR_API_KEY": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-linear/credential",
    "injection": "http-mediation",
    "audience": "tool-vm",
    "hosts": ["api.linear.app"]
  },
  "READWISE_ACCESS_TOKEN": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-shravan-readwise/credential",
    "injection": "http-mediation",
    "audience": "tool-vm",
    "hosts": ["mcp2.readwise.io"]
  },
  "DISCORD_BOT_TOKEN": {
    "source": "1password",
    "ref": "op://agent-vm/sunfam-discord/bot-token",
    "injection": "env",
    "audience": "gateway"
  }
},
"egressHosts": [
  { "host": "api.github.com", "audience": "both" },
  { "host": "github.com", "audience": "both" },
  { "host": "api.linear.app", "audience": "tool-vm" },
  { "host": "mcp2.readwise.io", "audience": "tool-vm" },
  { "host": "discord.com", "audience": "gateway" }
]
```

Do not add `runtimeAuthHints` to an OpenClaw zone. They are currently worker
gateway runtime instructions only. OpenClaw Tool VM auth comes from the
Tool VM audience secrets and egress hosts above.

Manual smoke test in a fresh OpenClaw sandbox:

```bash
printf '%s\n' "$GITHUB_TOKEN" | grep '^GONDOLIN_SECRET_'
GH_TOKEN="$GITHUB_TOKEN" gh api user --jq .login

printf '%s\n' "$LINEAR_API_KEY" | grep '^GONDOLIN_SECRET_'
LINEAR_API_KEY="$LINEAR_API_KEY" linear auth whoami

printf '%s\n' "$READWISE_ACCESS_TOKEN" | grep '^GONDOLIN_SECRET_'
readwise login-with-token "$READWISE_ACCESS_TOKEN"
readwise reader-search-documents --query "test"
```

Expected:

- Env vars print placeholder prefixes, not raw secrets.
- `gh api user` succeeds.
- `linear auth whoami` succeeds if the token has workspace access.
- Readwise login succeeds and subsequent commands can reach `mcp2.readwise.io`.
