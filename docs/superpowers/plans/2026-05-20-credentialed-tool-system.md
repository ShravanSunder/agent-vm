# Credentialed Tool System Implementation Plan

Status: design reference / refresh required before execution. Do not execute this plan directly until it is rewritten as `credentialed-runner-v1` on top of the Gondolin adapter widening plan.

Current valid parts:
- Separate operator-only credential maintenance from agent-callable typed execution.
- Use a credentialed runner security context, not the standard agent-controlled Tool VM.
- Use controlled VFS mounts such as `/cred`, `/run-in`, `/run-out`, and `/scratch`.
- Keep agent input typed: known tool names and schema-validated args become argv built by trusted code.
- Treat stdout/artifacts as policy-governed outputs.

Parts to refresh before execution:
- Rebase on `docs/superpowers/plans/2026-05-22-gondolin-adapter-tool-vm-ssh-cleanup.md`, which first exposes Gondolin `vm.exec` / `vm.fs` through `ManagedVm`.
- Define the future generic `VmCapabilityLease<TTransport, TCapability>` shape deliberately instead of using the Tool VM SSH lease type.
- Add audit correlation for controller-owned Gondolin RPC execution.
- Make the VFS artifact rule explicit: runner artifacts must live in VFS mounts, not guest rootfs.
- Remove or re-evaluate any runner HTTP/service assumptions before adding new RPC; prefer native Gondolin `vm.exec` / `vm.fs` first.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a schema-driven credentialed tool system that separates operator-only credential maintenance from agent-callable CLI execution, starting with Google Calendar through `gogcli`, Notion through `ntn`, and Linear through `linear-cli`.

**Architecture:** Add `@agent-vm/credential-runner` as the shared package for catalog schemas, argv construction, output policy, batch planning, and OpenClaw tool registration helpers. `packages/agent-vm` owns controller authorization, encrypted state access, Gondolin VM creation, VFS mount wiring, runner lease lifecycle, and artifact publication. Runtime execution uses credentialed runner VMs with controlled VFS mounts and no agent SSH; host-only tools use the same contract through an explicitly enabled host backend.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm workspaces, Hono controller routes, Gondolin `VM` / VFS providers and hooks, age-encrypted state using a 1Password-held age identity, OpenClaw native tool registration.

---

## Status And Scope

This plan supersedes these earlier untracked plans in this checkout:

- `docs/superpowers/plans/2026-05-15-credentialed-tool-vm-runner.md`
- `docs/superpowers/plans/2026-05-16-controller-credential-broker.md`

Those plans were useful inputs, but they split the problem incorrectly. The target design is not "HTTP mediation for every CLI" and not "one runner VM per OAuth provider that the agent can reach." The target is one credentialed-tool abstraction with two strictly separated access paths:

1. Credential maintainer path: operator/controller only. It can initialize OAuth flows, write keyrings, and mutate encrypted credential state.
2. Agent execution path: agent-callable through typed tools only. It validates known tool names and typed args, builds argv itself, executes in a controlled backend, and returns stdout/artifacts through the controller.

The plan is stacked on the MCP Portal managed-mode direction. If the MCP Portal branch that extracts `@agent-vm/secrets` and managed effective config has not landed when this plan is executed, stop before implementation and land that substrate first. Do not re-create the old subprocess-per-agent MCP Portal model in this plan.

## Why This Shape

The discussion converged through several false starts:

1. HTTP mediation alone is too narrow.
   - It works for simple bearer-token APIs.
   - It does not work cleanly for CLIs with native OAuth, keyrings, refresh rotation, device-login caches, request signing, or file workflows.

2. A credentialed runner is not the same thing as the agent's normal Tool VM.
   - The normal Tool VM is intentionally agent-controlled: shell, workspace, SSH, mutable files.
   - A credentialed runner VM is controller-controlled: no SSH, no arbitrary shell, typed argv only, credential state mounted only for that command family.
   - Both use the same Gondolin VM/VFS/lease substrate, but they are different security contexts.

3. Per-call ephemeral VMs are safest, but warm leases matter.
   - Per-call close-after-run gives the smallest runtime residue.
   - Warm leases avoid repeated boot cost and let CLIs reuse initialized runtime state.
   - The system supports both through `lifetime: "per-call" | "warm-lease"`. The default for v1 provider tools is `warm-lease` with a short idle TTL; high-risk tools can choose `per-call`.

4. Stdout is enough for the first Google Calendar, Notion, and Linear CRUD tools, but not enough for all CLI workflows.
   - v1 implements stdout-json first.
   - The design also includes a controlled artifact channel so Drive downloads, Gmail attachments, exports, and cross-tool composition do not need a new architecture.

5. 1Password should hold the root key, not every mutable secret.
   - Runtime state is age-encrypted at rest in `stateDir`.
   - 1Password holds the age identity and public recipient, resolved by the controller.
   - No write-capable 1Password token is required for normal operation.

## Existing Evidence Anchors

These are the current seams this plan builds on:

- `packages/gondolin-adapter/src/vm-adapter.ts:50-112` exposes `ManagedVmInstance`, `ManagedVm`, and current string-only `exec(command)`.
- `packages/gondolin-adapter/src/vm-adapter.ts:94-101` defines `CreateVmOptions` with `rootfsMode`, `allowedHosts`, `secrets`, `vfsMounts`, `tcpHosts`, and env.
- `packages/gondolin-adapter/src/vm-adapter.ts:280-319` creates Gondolin VMs with `rootfs.mode`, HTTP hooks, VFS `fuseMount: "/data"`, and mounted providers.
- `packages/gondolin-adapter/src/vm-adapter.ts:220-237` maps `VfsMountSpec` to Gondolin `VirtualProvider` instances.
- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts:167-179` creates standard Tool VMs with `rootfsMode: "memory"`, allowed hosts, secrets, and VFS mounts.
- `packages/agent-vm/src/controller/leases/lease-manager.ts:87-111` prevents lease reuse when profile, work mount, workdir, or agent workspace do not match.
- `packages/agent-vm/src/controller/http/controller-http-routes.ts:181-205` resolves Tool VM profile selection from `agentToolVmProfiles`, `defaultToolVmProfile`, and request profile.
- `packages/gateway-interface/src/audience.ts:13-27` owns audience matching and `egressHostsForAudience`.
- `packages/agent-vm/src/config/system-config.ts:499-512` validates that mediated secret hosts are present in `egressHosts`.
- `node_modules/.pnpm/@earendil-works+gondolin@0.9.1/node_modules/@earendil-works/gondolin/dist/src/index.d.ts:11-18` exports `MemoryProvider`, `RealFSProvider`, `ReadonlyProvider`, `ShadowProvider`, `SandboxVfsProvider`, and VFS hook types.
- `node_modules/.pnpm/@earendil-works+gondolin@0.9.1/node_modules/@earendil-works/gondolin/dist/src/vm/types.d.ts:10-16` shows Gondolin VM VFS options support `mounts` and `hooks`.
- `docker/base-images/tool-vm/Dockerfile` is the current Tool VM base image path; this plan adds a credentialed runner image recipe next to it.
- Current CLI install evidence checked on 2026-05-20:
  - `gogcli` latest GitHub release is `v0.17.0`; Linux release archives contain a `gog` binary.
  - Official Notion CLI docs install `ntn` with `npm install --global ntn`; `pnpm view ntn version` returned `0.14.1`.
  - `@schpet/linear-cli` publishes a `linear` bin; `pnpm view @schpet/linear-cli version bin` returned `2.0.0` and `{ linear: "run-linear.js" }`.

## Architecture Diagram

```text
                 operator
                    |
                    | agent-vm credentials connect google --profile personal
                    v
        +------------------------------+
        | controller / maintainer path |
        | - resolves 1P age key        |
        | - unlocks encrypted state    |
        | - runs setup VM if needed    |
        | - writes /cred state         |
        +---------------+--------------+
                        |
                        | encrypted state only
                        v
stateDir/credential-runner/profiles/<profile>/<provider>/realfs.age


                 agent in OpenClaw
                    |
                    | native typed tool call
                    v
        +------------------------------+
        | OpenClaw credential plugin   |
        | - no secrets                 |
        | - trusted ctx.agentId        |
        | - POST execute request       |
        +---------------+--------------+
                        |
                        v
        +------------------------------+
        | controller / execution path  |
        | - authorizes agent/profile   |
        | - validates typed args       |
        | - builds argv                |
        | - creates/reuses runner VM   |
        | - captures stdout/artifacts  |
        +---------------+--------------+
                        |
                        v
        +------------------------------+
        | credentialed runner backend  |
        | VM backend first             |
        | - no SSH                     |
        | - no arbitrary shell         |
        | - controlled VFS             |
        | - provider egress only       |
        +------------------------------+
```

## Two Paths

```text
PATH A: CREDENTIAL MAINTAINER

operator CLI
  -> controller command handler
  -> resolve age identity and recipient from 1Password
  -> decrypt provider realfs
  -> start setup-mode credentialed VM
  -> run known setup command
  -> CLI writes keyring/config into /cred
  -> controller encrypts /cred back into stateDir

Properties:
  - agent cannot call this path
  - writes credentials and keyrings
  - can use OAuth localhost callback forwarding
  - can run verification probes


PATH B: AGENT EXECUTION

agent native tool call
  -> OpenClaw plugin sends controller execute request
  -> controller resolves agent profile from trusted ctx.agentId
  -> controller validates tool and args
  -> controller builds argv array
  -> runner backend executes exact argv
  -> controller redacts and returns stdout/artifact handles

Properties:
  - agent never supplies executable, cwd, env, mount paths, profile, or raw flags
  - agent can only supply schema-declared values
  - can read provider state mounted at /cred
  - can write provider state only through the CLI's own keyring paths
```

## Runner VFS Layout

The VFS layout is the execution contract. VFS control helps shape the run, but process isolation still comes from a separate backend with no agent SSH.

```text
/
  cred/       read-write provider state
              source: decrypted age state for (profile, provider)
              visible only inside credentialed runner backend
              never mounted into normal agent Tool VM

  in/         read-only inputs
              source: controller-selected artifacts or copied workspace files
              agent cannot provide absolute host paths

  cwd/        writable scratch working directory
              source: MemoryProvider
              process cwd for every command

  out/        private output directory
              source: MemoryProvider or controller-owned realfs
              not shared live with agent
              controller validates then publishes handles
```

Required VFS behavior:

- `/cred` is writable because CLIs like `gogcli`, `ntn`, and `linear-cli` may update caches or keyrings.
- `/in` is read-only and only contains controller-approved inputs.
- `/cwd` is memory-backed and starts empty for each run.
- `/out` is private until validation completes.
- Hooks reject writes outside `/cred`, `/cwd`, and `/out`.
- Hooks audit all opens, renames, unlinks, and writes.
- Symlinks, device nodes, sockets, FIFOs, hardlinks, and oversized files in `/out` are rejected before publication.

## Output And Composition

```text
single call:

  google.calendar.list_events
      output kind: stdout-json
      returns: result.json value

  google.drive.export
      output kind: artifact-dir
      returns: artifact://credential-runner/<runId>/export.pdf


batch call:

  step 1: google.calendar.list_events
      output handle: events

  step 2: notion.page.create
      input: json pointer from events
      output handle: notionPage

  step 3: linear.comment.create
      input: json pointer from notionPage
```

Composition is explicit. The agent does not get shell pipes, shared writable directories, or raw paths between tools. The controller owns handles, maps them to `/in`, validates selectors, and returns typed results.

## Backend Model

```text
CredentialToolBackend
  kind: "vm"
    - default backend
    - uses Gondolin
    - supports warm leases and per-call close
    - supports VFS policy and provider egress controls

  kind: "host"
    - disabled unless zone config explicitly enables it
    - for macOS-only tools such as Things
    - same catalog, argv, output, and authorization contract
    - weaker isolation, so every host tool requires operator opt-in
```

This avoids building a third system for host-only tools. The host backend is another execution backend under the same policy model.

## Security Invariants

1. The agent cannot call the maintainer path.
2. The agent cannot choose its profile. Profile resolution comes from trusted OpenClaw `ctx.agentId` and zone config.
3. The agent cannot provide executable paths, flags, env vars, cwd, mount paths, host paths, or output absolute paths.
4. The controller builds argv from catalog schema and typed args.
5. Runner VMs have no SSH and no general shell surface.
6. Provider egress is restricted to catalog-declared hosts that are also allowed by the zone.
7. 1Password is read-only during normal operation and stores only the age identity/recipient plus optional bootstrap import references.
8. All mutable provider secrets and CLI keyrings are age-encrypted in `stateDir`.
9. The normal agent Tool VM never receives `/cred`.
10. Artifacts are not exposed until controller validation succeeds.

## Config Shape

The config is split by reason to change:

- `system.jsonc` owns zone binding, 1Password refs for the state key, backend enablement, and agent profile binding.
- `credential-tools.config.jsonc` owns providers, tools, argv templates, output policy, and setup commands.

Example `system.jsonc` zone fields:

```jsonc
{
  "zones": [
    {
      "id": "shravan-claw",
      "type": "openclaw",
      "credentialRunner": {
        "configDir": "./config/credential-runner",
        "stateKey": {
          "identityRef": "op://agent-vm/credential-runner/age-identity",
          "recipientRef": "op://agent-vm/credential-runner/age-recipient"
        },
        "hostBackend": {
          "enabled": false
        },
        "profileBindings": {
          "codex-runner": "personal",
          "research-agent": "work"
        }
      },
      "egressHosts": [
        { "host": "accounts.google.com", "audience": "tool-vm" },
        { "host": "oauth2.googleapis.com", "audience": "tool-vm" },
        { "host": "calendar.googleapis.com", "audience": "tool-vm" },
        { "host": "api.notion.com", "audience": "tool-vm" },
        { "host": "api.linear.app", "audience": "tool-vm" }
      ]
    }
  ]
}
```

Example `config/credential-runner/credential-tools.config.jsonc`:

```jsonc
{
  "providers": {
    "google": {
      "backend": {
        "kind": "vm",
        "imageProfile": "credentialed-tool-vm",
        "lifetime": "warm-lease",
        "idleTtlMs": 300000
      },
      "stateScope": "profile-provider",
      "credentialMount": "/cred",
      "audienceHosts": [
        "accounts.google.com",
        "oauth2.googleapis.com",
        "calendar.googleapis.com"
      ],
      "setup": {
        "tool": "google.auth.connect",
        "requiresOperatorBrowser": true,
        "tcpHosts": {
          "oauth-callback.localhost": "127.0.0.1:0"
        }
      }
    },
    "notion": {
      "backend": {
        "kind": "vm",
        "imageProfile": "credentialed-tool-vm",
        "lifetime": "warm-lease",
        "idleTtlMs": 300000
      },
      "stateScope": "profile-provider",
      "credentialMount": "/cred",
      "audienceHosts": ["api.notion.com"]
    },
    "linear": {
      "backend": {
        "kind": "vm",
        "imageProfile": "credentialed-tool-vm",
        "lifetime": "warm-lease",
        "idleTtlMs": 300000
      },
      "stateScope": "profile-provider",
      "credentialMount": "/cred",
      "audienceHosts": ["api.linear.app"]
    }
  },
  "tools": {
    "google.calendar.list_events": {
      "provider": "google",
      "description": "List Google Calendar events as JSON.",
      "execution": {
        "executable": "/usr/local/bin/gog",
        "argv": [
          "calendar",
          "events",
          "--json",
          { "param": "calendarId", "flag": "--calendar" },
          { "param": "timeMin", "flag": "--time-min" },
          { "param": "timeMax", "flag": "--time-max" },
          { "param": "maxResults", "flag": "--max-results" }
        ],
        "cwd": "/cwd",
        "timeoutMs": 30000
      },
      "args": {
        "calendarId": { "type": "string", "minLength": 1, "maxLength": 256 },
        "timeMin": { "type": "string", "format": "date-time", "optional": true },
        "timeMax": { "type": "string", "format": "date-time", "optional": true },
        "maxResults": { "type": "integer", "minimum": 1, "maximum": 100, "optional": true }
      },
      "output": {
        "kind": "stdout-json",
        "maxStdoutBytes": 1048576,
        "redact": true
      }
    }
  }
}
```

## File Structure

Create these files:

```text
packages/credential-runner/
  package.json
  tsconfig.json
  tsconfig.build.json
  tsdown.config.ts
  src/index.ts
  src/catalog/credential-tool-catalog.ts
  src/catalog/credential-tool-catalog.test.ts
  src/policy/argv-builder.ts
  src/policy/argv-builder.test.ts
  src/policy/output-policy.ts
  src/policy/output-policy.test.ts
  src/policy/run-context.ts
  src/policy/run-context.test.ts
  src/execution/credential-tool-executor.ts
  src/execution/credential-tool-executor.test.ts
  src/execution/batch-planner.ts
  src/execution/batch-planner.test.ts
  src/maintainer/credential-maintainer.ts
  src/maintainer/credential-maintainer.test.ts
  src/openclaw/openclaw-tool-registration.ts
  src/openclaw/openclaw-tool-registration.test.ts
  src/testing.ts

packages/config-contracts/src/credential-runner-config.ts
packages/config-contracts/src/credential-runner-config.test.ts

packages/agent-vm/src/controller/credential-runner/
  artifact-store.ts
  artifact-store.test.ts
  credential-runner-routes.ts
  credential-runner-routes.test.ts
  credentialed-runner-lease-manager.ts
  credentialed-runner-lease-manager.test.ts
  credentialed-vm-factory.ts
  credentialed-vm-factory.test.ts
  encrypted-credential-state.ts
  encrypted-credential-state.test.ts
  maintainer-command.ts
  maintainer-command.test.ts

packages/openclaw-agent-vm-plugin/src/credential-runner-tools.ts
packages/openclaw-agent-vm-plugin/src/credential-runner-tools.test.ts

docker/base-images/credentialed-tool-vm/Dockerfile
```

Modify these files:

```text
package.json
packages/agent-vm/package.json
packages/agent-vm/src/config/system-config.ts
packages/agent-vm/src/config/system-config.test.ts
packages/agent-vm/src/controller/controller-runtime.ts
packages/agent-vm/src/controller/http/controller-http-routes.ts
packages/agent-vm/src/cli/manual-templates.ts
packages/agent-vm/src/cli/manual-templates.test.ts
packages/agent-vm/managed-images.json
packages/gondolin-adapter/src/vm-adapter.ts
packages/gondolin-adapter/src/vm-adapter.test.ts
packages/openclaw-agent-vm-plugin/package.json
packages/openclaw-agent-vm-plugin/tsdown.config.ts
docs/reference/configuration/system-json.md
docs/reference/validate-and-doctor.md
docs/subsystems/secrets-and-credentials.md
docs/architecture/openclaw-gateway.md
```

## Implementation Tasks

### Task 1: Add the credential runner package skeleton

**Files:**

- Create: `packages/credential-runner/package.json`
- Create: `packages/credential-runner/tsconfig.json`
- Create: `packages/credential-runner/tsconfig.build.json`
- Create: `packages/credential-runner/tsdown.config.ts`
- Create: `packages/credential-runner/src/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Create package manifest**

Write `packages/credential-runner/package.json`:

```json
{
	"name": "@agent-vm/credential-runner",
	"version": "0.0.58",
	"description": "Schema-driven credentialed CLI catalog, policy, and execution contracts for agent-vm.",
	"homepage": "https://github.com/ShravanSunder/agent-vm#readme",
	"bugs": {
		"url": "https://github.com/ShravanSunder/agent-vm/issues"
	},
	"license": "MIT",
	"author": "Shravan Sunder <ShravanSunder@users.noreply.github.com>",
	"repository": {
		"type": "git",
		"url": "git+https://github.com/ShravanSunder/agent-vm.git",
		"directory": "packages/credential-runner"
	},
	"files": ["dist"],
	"type": "module",
	"main": "./dist/index.js",
	"types": "./dist/index.d.ts",
	"exports": {
		".": {
			"types": "./dist/index.d.ts",
			"import": "./dist/index.js"
		},
		"./testing": {
			"types": "./dist/testing.d.ts",
			"import": "./dist/testing.js"
		}
	},
	"publishConfig": {
		"access": "public"
	},
	"scripts": {
		"build": "tsdown",
		"prepack": "pnpm -C ../.. build",
		"typecheck": "tsc -p tsconfig.json --noEmit",
		"test": "pnpm test:unit",
		"test:unit": "vitest run --root ../../ --config vitest.config.ts packages/credential-runner/src"
	},
	"dependencies": {
		"@agent-vm/config-contracts": "workspace:*",
		"zod": "^4.4.3"
	},
	"devDependencies": {
		"vitest": "^4.1.5"
	}
}
```

- [ ] **Step 2: Create TypeScript build files**

Write `packages/credential-runner/tsconfig.json`:

```json
{
	"extends": "../../tsconfig.json",
	"compilerOptions": {
		"rootDir": "src",
		"outDir": "dist",
		"composite": true
	},
	"include": ["src/**/*.ts"]
}
```

Write `packages/credential-runner/tsconfig.build.json`:

```json
{
	"extends": "./tsconfig.json",
	"exclude": ["src/**/*.test.ts"]
}
```

Write `packages/credential-runner/tsdown.config.ts`:

```ts
import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: ['src/index.ts', 'src/testing.ts'],
	format: 'esm',
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
```

- [ ] **Step 3: Create initial exports**

Write `packages/credential-runner/src/index.ts`:

```ts
export type {
	ArgvToken,
	CredentialToolCatalog,
	CredentialToolDefinition,
	CredentialToolProvider,
} from './catalog/credential-tool-catalog.js';
```

Write `packages/credential-runner/src/testing.ts`:

```ts
export const credentialRunnerTestingPackageMarker = '@agent-vm/credential-runner/testing';
```

- [ ] **Step 4: Verify package builds**

Run:

```bash
pnpm --filter @agent-vm/credential-runner build
```

Expected result: `tsdown` succeeds and writes `packages/credential-runner/dist/index.js` and `dist/index.d.ts`.

### Task 2: Add catalog and config contracts

**Files:**

- Create: `packages/config-contracts/src/credential-runner-config.ts`
- Create: `packages/config-contracts/src/credential-runner-config.test.ts`
- Modify: `packages/config-contracts/src/index.ts`
- Create: `packages/credential-runner/src/catalog/credential-tool-catalog.ts`
- Create: `packages/credential-runner/src/catalog/credential-tool-catalog.test.ts`
- Modify: `packages/credential-runner/src/index.ts`

- [ ] **Step 1: Write failing config-contract tests**

Create `packages/config-contracts/src/credential-runner-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { credentialRunnerConfigSchema } from './credential-runner-config.js';

describe('credentialRunnerConfigSchema', () => {
	it('accepts a vm provider with a stdout-json tool', () => {
		const result = credentialRunnerConfigSchema.safeParse({
			providers: {
				google: {
					backend: {
						kind: 'vm',
						imageProfile: 'credentialed-tool-vm',
						lifetime: 'warm-lease',
						idleTtlMs: 300_000,
					},
					stateScope: 'profile-provider',
					credentialMount: '/cred',
					audienceHosts: ['calendar.googleapis.com'],
				},
			},
			tools: {
				'google.calendar.list_events': {
					provider: 'google',
					description: 'List Google Calendar events.',
					execution: {
						executable: '/usr/local/bin/gog',
						argv: ['calendar', 'events', '--json', { param: 'calendarId', flag: '--calendar' }],
						cwd: '/cwd',
						timeoutMs: 30_000,
					},
					args: {
						calendarId: { type: 'string', minLength: 1, maxLength: 256 },
					},
					output: {
						kind: 'stdout-json',
						maxStdoutBytes: 1_048_576,
						redact: true,
					},
				},
			},
		});

		expect(result.success).toBe(true);
	});

	it('rejects agent-controlled executable paths outside /usr/local/bin', () => {
		const result = credentialRunnerConfigSchema.safeParse({
			providers: {
				bad: {
					backend: {
						kind: 'vm',
						imageProfile: 'credentialed-tool-vm',
						lifetime: 'per-call',
					},
					stateScope: 'profile-provider',
					credentialMount: '/cred',
					audienceHosts: ['example.com'],
				},
			},
			tools: {
				'bad.tool': {
					provider: 'bad',
					description: 'Bad tool.',
					execution: {
						executable: '/bin/sh',
						argv: ['-c', { param: 'command' }],
						cwd: '/cwd',
						timeoutMs: 30_000,
					},
					args: {
						command: { type: 'string', minLength: 1, maxLength: 10 },
					},
					output: {
						kind: 'stdout-text',
						maxStdoutBytes: 1024,
						redact: true,
					},
				},
			},
		});

		expect(result.success).toBe(false);
	});
});
```

- [ ] **Step 2: Implement config schema**

Create `packages/config-contracts/src/credential-runner-config.ts`:

```ts
import { z } from 'zod';

const safeIdentifierSchema = z
	.string()
	.regex(/^[a-z][a-z0-9_-]*$/, 'Use lowercase letters, numbers, underscores, and dashes.');

const safeToolNameSchema = z
	.string()
	.regex(
		/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/,
		'Tool names must be dotted identifiers like google.calendar.list_events.',
	);

const runnerPathSchema = z
	.string()
	.regex(/^\/[A-Za-z0-9._/-]+$/, 'Runner paths must be absolute POSIX paths.');

const executablePathSchema = z
	.string()
	.regex(
		/^\/usr\/local\/bin\/[A-Za-z0-9._-]+$/,
		'Credentialed tools must run packaged executables from /usr/local/bin.',
	);

export const argvTokenSchema = z.union([
	z.string().min(1),
	z.object({
		param: safeIdentifierSchema,
		flag: z.string().regex(/^--[A-Za-z0-9][A-Za-z0-9-]*$/),
	}),
]);

export const toolArgSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('string'),
		minLength: z.number().int().min(0).optional(),
		maxLength: z.number().int().min(1).max(65_536),
		format: z.enum(['date-time', 'email']).optional(),
		pattern: z.string().optional(),
		optional: z.boolean().optional(),
	}),
	z.object({
		type: z.literal('integer'),
		minimum: z.number().int(),
		maximum: z.number().int(),
		optional: z.boolean().optional(),
	}),
	z.object({
		type: z.literal('boolean'),
		optional: z.boolean().optional(),
	}),
]);

export const outputPolicySchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('stdout-json'),
		maxStdoutBytes: z.number().int().min(1).max(16 * 1024 * 1024),
		redact: z.boolean(),
	}),
	z.object({
		kind: z.literal('stdout-text'),
		maxStdoutBytes: z.number().int().min(1).max(16 * 1024 * 1024),
		redact: z.boolean(),
	}),
	z.object({
		kind: z.literal('artifact-dir'),
		maxArtifactBytes: z.number().int().min(1).max(512 * 1024 * 1024),
		allowedExtensions: z.array(z.string().regex(/^\.[A-Za-z0-9]+$/)).min(1),
		redactTextArtifacts: z.boolean(),
	}),
]);

export const credentialProviderBackendSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('vm'),
		imageProfile: safeIdentifierSchema,
		lifetime: z.enum(['per-call', 'warm-lease']),
		idleTtlMs: z.number().int().min(1_000).max(3_600_000).optional(),
	}),
	z.object({
		kind: z.literal('host'),
		requiresHostBackendEnabled: z.literal(true),
	}),
]);

export const credentialToolProviderSchema = z.object({
	backend: credentialProviderBackendSchema,
	stateScope: z.literal('profile-provider'),
	credentialMount: z.literal('/cred'),
	audienceHosts: z.array(z.string().min(1)).min(1),
	setup: z
		.object({
			tool: safeToolNameSchema,
			requiresOperatorBrowser: z.boolean(),
			tcpHosts: z.record(z.string().min(1), z.string().min(1)).optional(),
		})
		.optional(),
});

export const credentialToolDefinitionSchema = z.object({
	provider: safeIdentifierSchema,
	description: z.string().min(1),
	execution: z.object({
		executable: executablePathSchema,
		argv: z.array(argvTokenSchema),
		cwd: runnerPathSchema.refine((value) => value === '/cwd', 'cwd must be /cwd'),
		timeoutMs: z.number().int().min(1_000).max(600_000),
	}),
	args: z.record(safeIdentifierSchema, toolArgSchema),
	output: outputPolicySchema,
});

export const credentialRunnerConfigSchema = z
	.object({
		providers: z.record(safeIdentifierSchema, credentialToolProviderSchema),
		tools: z.record(safeToolNameSchema, credentialToolDefinitionSchema),
	})
	.superRefine((config, context) => {
		for (const [toolName, tool] of Object.entries(config.tools)) {
			if (!config.providers[tool.provider]) {
				context.addIssue({
					code: 'custom',
					path: ['tools', toolName, 'provider'],
					message: `Unknown credential provider '${tool.provider}'.`,
				});
			}
			for (const token of tool.execution.argv) {
				if (typeof token === 'string') {
					if (token === '-c' || token.startsWith(';') || token.includes('\0')) {
						context.addIssue({
							code: 'custom',
							path: ['tools', toolName, 'execution', 'argv'],
							message: 'Unsafe argv literal.',
						});
					}
					continue;
				}
				if (!tool.args[token.param]) {
					context.addIssue({
						code: 'custom',
						path: ['tools', toolName, 'execution', 'argv'],
						message: `Argv references unknown param '${token.param}'.`,
					});
				}
			}
		}
	});

export type CredentialRunnerConfig = z.infer<typeof credentialRunnerConfigSchema>;
export type CredentialToolDefinition = z.infer<typeof credentialToolDefinitionSchema>;
export type CredentialToolProvider = z.infer<typeof credentialToolProviderSchema>;
export type ArgvToken = z.infer<typeof argvTokenSchema>;
```

- [ ] **Step 3: Export schema**

Modify `packages/config-contracts/src/index.ts`:

```ts
export * from './credential-runner-config.js';
```

- [ ] **Step 4: Re-export types from credential-runner**

Create `packages/credential-runner/src/catalog/credential-tool-catalog.ts`:

```ts
import type {
	ArgvToken,
	CredentialRunnerConfig,
	CredentialToolDefinition,
	CredentialToolProvider,
} from '@agent-vm/config-contracts';

export type CredentialToolCatalog = CredentialRunnerConfig;
export type { ArgvToken, CredentialToolDefinition, CredentialToolProvider };
```

Create `packages/credential-runner/src/catalog/credential-tool-catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { CredentialToolCatalog } from './credential-tool-catalog.js';

describe('CredentialToolCatalog', () => {
	it('is a narrow public type for credential catalogs', () => {
		const catalog = {
			providers: {},
			tools: {},
		} satisfies CredentialToolCatalog;

		expect(catalog.tools).toEqual({});
	});
});
```

- [ ] **Step 5: Run targeted tests**

Run:

```bash
pnpm test:unit -- packages/config-contracts/src/credential-runner-config.test.ts packages/credential-runner/src/catalog/credential-tool-catalog.test.ts
```

Expected result: both test files pass.

### Task 3: Implement safe argv construction

**Files:**

- Create: `packages/credential-runner/src/policy/argv-builder.ts`
- Create: `packages/credential-runner/src/policy/argv-builder.test.ts`
- Modify: `packages/credential-runner/src/index.ts`

- [ ] **Step 1: Write failing argv tests**

Create `packages/credential-runner/src/policy/argv-builder.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildCredentialToolArgv } from './argv-builder.js';
import type { CredentialToolDefinition } from '../catalog/credential-tool-catalog.js';

const listEventsTool = {
	provider: 'google',
	description: 'List events.',
	execution: {
		executable: '/usr/local/bin/gog',
		argv: ['calendar', 'events', '--json', { param: 'calendarId', flag: '--calendar' }],
		cwd: '/cwd',
		timeoutMs: 30_000,
	},
	args: {
		calendarId: { type: 'string', minLength: 1, maxLength: 256 },
	},
	output: { kind: 'stdout-json', maxStdoutBytes: 1_048_576, redact: true },
} satisfies CredentialToolDefinition;

describe('buildCredentialToolArgv', () => {
	it('builds argv from schema-declared params only', () => {
		expect(
			buildCredentialToolArgv({
				tool: listEventsTool,
				args: { calendarId: 'primary' },
			}),
		).toEqual(['/usr/local/bin/gog', 'calendar', 'events', '--json', '--calendar', 'primary']);
	});

	it('rejects unknown params', () => {
		expect(() =>
			buildCredentialToolArgv({
				tool: listEventsTool,
				args: { calendarId: 'primary', debug: true },
			}),
		).toThrow("Unknown argument 'debug'");
	});

	it('rejects flag-shaped string values', () => {
		expect(() =>
			buildCredentialToolArgv({
				tool: listEventsTool,
				args: { calendarId: '--debug' },
			}),
		).toThrow("Argument 'calendarId' must not start with '-'");
	});
});
```

- [ ] **Step 2: Implement argv builder**

Create `packages/credential-runner/src/policy/argv-builder.ts`:

```ts
import type { CredentialToolDefinition } from '../catalog/credential-tool-catalog.js';

export type CredentialToolArgs = Record<string, boolean | number | string | undefined>;

export interface BuildCredentialToolArgvOptions {
	readonly tool: CredentialToolDefinition;
	readonly args: CredentialToolArgs;
}

function assertKnownArgs(tool: CredentialToolDefinition, args: CredentialToolArgs): void {
	for (const argName of Object.keys(args)) {
		if (!tool.args[argName]) {
			throw new Error(`Unknown argument '${argName}'`);
		}
	}
}

function validateStringArg(argName: string, value: string): string {
	if (value.startsWith('-')) {
		throw new Error(`Argument '${argName}' must not start with '-'`);
	}
	if (value.includes('\0')) {
		throw new Error(`Argument '${argName}' must not contain NUL bytes`);
	}
	return value;
}

function valueToArgvString(argName: string, value: boolean | number | string): string {
	if (typeof value === 'string') {
		return validateStringArg(argName, value);
	}
	return String(value);
}

export function buildCredentialToolArgv(options: BuildCredentialToolArgvOptions): readonly string[] {
	assertKnownArgs(options.tool, options.args);

	const argv: string[] = [options.tool.execution.executable];
	for (const token of options.tool.execution.argv) {
		if (typeof token === 'string') {
			argv.push(token);
			continue;
		}

		const value = options.args[token.param];
		if (value === undefined) {
			continue;
		}
		argv.push(token.flag, valueToArgvString(token.param, value));
	}
	return argv;
}
```

- [ ] **Step 3: Export argv builder**

Modify `packages/credential-runner/src/index.ts`:

```ts
export { buildCredentialToolArgv } from './policy/argv-builder.js';
export type { BuildCredentialToolArgvOptions, CredentialToolArgs } from './policy/argv-builder.js';
```

- [ ] **Step 4: Run argv tests**

Run:

```bash
pnpm test:unit -- packages/credential-runner/src/policy/argv-builder.test.ts
```

Expected result: all argv tests pass.

### Task 4: Implement output policy and artifact validation

**Files:**

- Create: `packages/credential-runner/src/policy/output-policy.ts`
- Create: `packages/credential-runner/src/policy/output-policy.test.ts`
- Modify: `packages/credential-runner/src/index.ts`

- [ ] **Step 1: Write failing output policy tests**

Create `packages/credential-runner/src/policy/output-policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { normalizeCredentialToolOutput } from './output-policy.js';

describe('normalizeCredentialToolOutput', () => {
	it('parses bounded stdout JSON', () => {
		expect(
			normalizeCredentialToolOutput({
				policy: { kind: 'stdout-json', maxStdoutBytes: 1024, redact: true },
				stdout: '{"ok":true}',
				stderr: '',
			}),
		).toEqual({
			kind: 'json',
			value: { ok: true },
			stderr: '',
		});
	});

	it('rejects oversized stdout', () => {
		expect(() =>
			normalizeCredentialToolOutput({
				policy: { kind: 'stdout-text', maxStdoutBytes: 2, redact: true },
				stdout: 'abc',
				stderr: '',
			}),
		).toThrow('stdout exceeded 2 bytes');
	});
});
```

- [ ] **Step 2: Implement output normalization**

Create `packages/credential-runner/src/policy/output-policy.ts`:

```ts
import type { CredentialToolDefinition } from '../catalog/credential-tool-catalog.js';

export type CredentialToolOutput =
	| {
			readonly kind: 'json';
			readonly value: unknown;
			readonly stderr: string;
	  }
	| {
			readonly kind: 'text';
			readonly value: string;
			readonly stderr: string;
	  }
	| {
			readonly kind: 'artifacts';
			readonly artifacts: readonly CredentialToolArtifact[];
			readonly stderr: string;
	  };

export interface CredentialToolArtifact {
	readonly name: string;
	readonly uri: string;
	readonly sizeBytes: number;
}

export interface NormalizeCredentialToolOutputOptions {
	readonly policy: CredentialToolDefinition['output'];
	readonly stdout: string;
	readonly stderr: string;
	readonly artifacts?: readonly CredentialToolArtifact[];
}

function assertStdoutWithinLimit(stdout: string, maxStdoutBytes: number): void {
	const byteLength = Buffer.byteLength(stdout, 'utf8');
	if (byteLength > maxStdoutBytes) {
		throw new Error(`stdout exceeded ${maxStdoutBytes} bytes`);
	}
}

export function normalizeCredentialToolOutput(
	options: NormalizeCredentialToolOutputOptions,
): CredentialToolOutput {
	switch (options.policy.kind) {
		case 'stdout-json': {
			assertStdoutWithinLimit(options.stdout, options.policy.maxStdoutBytes);
			return {
				kind: 'json',
				value: JSON.parse(options.stdout),
				stderr: options.stderr,
			};
		}
		case 'stdout-text': {
			assertStdoutWithinLimit(options.stdout, options.policy.maxStdoutBytes);
			return {
				kind: 'text',
				value: options.stdout,
				stderr: options.stderr,
			};
		}
		case 'artifact-dir': {
			return {
				kind: 'artifacts',
				artifacts: options.artifacts ?? [],
				stderr: options.stderr,
			};
		}
	}
}
```

- [ ] **Step 3: Export output policy**

Modify `packages/credential-runner/src/index.ts`:

```ts
export { normalizeCredentialToolOutput } from './policy/output-policy.js';
export type {
	CredentialToolArtifact,
	CredentialToolOutput,
	NormalizeCredentialToolOutputOptions,
} from './policy/output-policy.js';
```

- [ ] **Step 4: Run output tests**

Run:

```bash
pnpm test:unit -- packages/credential-runner/src/policy/output-policy.test.ts
```

Expected result: output tests pass.

### Task 5: Define runner VFS run context

**Files:**

- Create: `packages/credential-runner/src/policy/run-context.ts`
- Create: `packages/credential-runner/src/policy/run-context.test.ts`
- Modify: `packages/credential-runner/src/index.ts`

- [ ] **Step 1: Write failing run-context tests**

Create `packages/credential-runner/src/policy/run-context.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { buildCredentialRunContext } from './run-context.js';

describe('buildCredentialRunContext', () => {
	it('creates the fixed guest mount layout', () => {
		expect(
			buildCredentialRunContext({
				decryptedCredentialHostPath: '/state/credential-runner/profiles/personal/google/decrypted',
				inputHostPath: '/tmp/in',
				outputHostPath: '/tmp/out',
			}),
		).toEqual({
			cwd: '/cwd',
			mounts: {
				'/cred': {
					kind: 'realfs',
					hostPath: '/state/credential-runner/profiles/personal/google/decrypted',
				},
				'/in': {
					kind: 'realfs-readonly',
					hostPath: '/tmp/in',
				},
				'/cwd': {
					kind: 'memory',
				},
				'/out': {
					kind: 'realfs',
					hostPath: '/tmp/out',
				},
			},
			allowedWritePrefixes: ['/cred', '/cwd', '/out'],
		});
	});
});
```

- [ ] **Step 2: Implement run context**

Create `packages/credential-runner/src/policy/run-context.ts`:

```ts
export interface CredentialRunContext {
	readonly cwd: '/cwd';
	readonly mounts: Record<string, CredentialRunMountSpec>;
	readonly allowedWritePrefixes: readonly string[];
}

export type CredentialRunMountSpec =
	| {
			readonly kind: 'memory';
	  }
	| {
			readonly kind: 'realfs' | 'realfs-readonly';
			readonly hostPath: string;
	  };

export interface BuildCredentialRunContextOptions {
	readonly decryptedCredentialHostPath: string;
	readonly inputHostPath: string;
	readonly outputHostPath: string;
}

export function buildCredentialRunContext(
	options: BuildCredentialRunContextOptions,
): CredentialRunContext {
	return {
		cwd: '/cwd',
		mounts: {
			'/cred': {
				kind: 'realfs',
				hostPath: options.decryptedCredentialHostPath,
			},
			'/in': {
				kind: 'realfs-readonly',
				hostPath: options.inputHostPath,
			},
			'/cwd': {
				kind: 'memory',
			},
			'/out': {
				kind: 'realfs',
				hostPath: options.outputHostPath,
			},
		},
		allowedWritePrefixes: ['/cred', '/cwd', '/out'],
	};
}
```

- [ ] **Step 3: Export run context**

Modify `packages/credential-runner/src/index.ts`:

```ts
export { buildCredentialRunContext } from './policy/run-context.js';
export type {
	BuildCredentialRunContextOptions,
	CredentialRunContext,
	CredentialRunMountSpec,
} from './policy/run-context.js';
```

- [ ] **Step 4: Run run-context tests**

Run:

```bash
pnpm test:unit -- packages/credential-runner/src/policy/run-context.test.ts
```

Expected result: run-context tests pass.

### Task 6: Add encrypted credential state in the controller

**Files:**

- Create: `packages/agent-vm/src/controller/credential-runner/encrypted-credential-state.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/encrypted-credential-state.test.ts`
- Modify: `packages/agent-vm/package.json`

- [ ] **Step 1: Write failing encrypted-state tests**

Create `packages/agent-vm/src/controller/credential-runner/encrypted-credential-state.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createCredentialStatePath, writeEncryptedCredentialState } from './encrypted-credential-state.js';

describe('encrypted credential state paths', () => {
	it('keeps profile/provider state under stateDir', () => {
		expect(
			createCredentialStatePath({
				stateDir: '/state',
				profileId: 'personal',
				providerId: 'google',
			}),
		).toBe('/state/credential-runner/profiles/personal/google/realfs.age');
	});
});

describe('writeEncryptedCredentialState', () => {
	it('writes ciphertext atomically without plaintext JSON on disk', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'credential-runner-state-'));
		try {
			const statePath = join(dir, 'realfs.age');
			await writeEncryptedCredentialState({
				statePath,
				ciphertext: Buffer.from('age-encrypted-payload'),
			});

			expect(await readFile(statePath, 'utf8')).toBe('age-encrypted-payload');
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});
});
```

- [ ] **Step 2: Implement path and atomic write helper**

Create `packages/agent-vm/src/controller/credential-runner/encrypted-credential-state.ts`:

```ts
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface CredentialStatePathOptions {
	readonly stateDir: string;
	readonly profileId: string;
	readonly providerId: string;
}

export interface WriteEncryptedCredentialStateOptions {
	readonly statePath: string;
	readonly ciphertext: Buffer;
}

function assertSafeStateSegment(name: string, value: string): void {
	if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
		throw new Error(`${name} must contain only letters, numbers, underscores, and dashes`);
	}
}

export function createCredentialStatePath(options: CredentialStatePathOptions): string {
	assertSafeStateSegment('profileId', options.profileId);
	assertSafeStateSegment('providerId', options.providerId);
	return join(
		options.stateDir,
		'credential-runner',
		'profiles',
		options.profileId,
		options.providerId,
		'realfs.age',
	);
}

export async function writeEncryptedCredentialState(
	options: WriteEncryptedCredentialStateOptions,
): Promise<void> {
	await mkdir(dirname(options.statePath), { recursive: true, mode: 0o700 });
	const tempPath = `${options.statePath}.${process.pid}.tmp`;
	await writeFile(tempPath, options.ciphertext, { mode: 0o600 });
	await rename(tempPath, options.statePath);
}
```

- [ ] **Step 3: Add age command adapter**

Add functions to `encrypted-credential-state.ts`:

```ts
export interface AgeCommandRunner {
	readonly run: (command: string, args: readonly string[], stdin: Buffer) => Promise<Buffer>;
}

export interface EncryptCredentialStateOptions {
	readonly ageRecipient: string;
	readonly plaintextTarball: Buffer;
	readonly runner: AgeCommandRunner;
}

export interface DecryptCredentialStateOptions {
	readonly ageIdentity: string;
	readonly ciphertext: Buffer;
	readonly runner: AgeCommandRunner;
}

export async function encryptCredentialState(
	options: EncryptCredentialStateOptions,
): Promise<Buffer> {
	return await options.runner.run('age', ['--encrypt', '--recipient', options.ageRecipient], options.plaintextTarball);
}

export async function decryptCredentialState(
	options: DecryptCredentialStateOptions,
): Promise<Buffer> {
	return await options.runner.run(
		'age',
		['--decrypt', '--identity', '-'],
		Buffer.concat([Buffer.from(`${options.ageIdentity}\n`), options.ciphertext]),
	);
}
```

The production runner must pass the identity on stdin. It must not write the age identity to a temp file.

- [ ] **Step 4: Run encrypted-state tests**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/controller/credential-runner/encrypted-credential-state.test.ts
```

Expected result: encrypted-state tests pass.

### Task 7: Add maintainer command contracts

**Files:**

- Create: `packages/credential-runner/src/maintainer/credential-maintainer.ts`
- Create: `packages/credential-runner/src/maintainer/credential-maintainer.test.ts`
- Modify: `packages/credential-runner/src/index.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/maintainer-command.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/maintainer-command.test.ts`

- [ ] **Step 1: Add package maintainer types**

Create `packages/credential-runner/src/maintainer/credential-maintainer.ts`:

```ts
export type CredentialMaintainerOperation =
	| {
			readonly kind: 'connect';
			readonly zoneId: string;
			readonly profileId: string;
			readonly providerId: string;
	  }
	| {
			readonly kind: 'verify';
			readonly zoneId: string;
			readonly profileId: string;
			readonly providerId: string;
	  }
	| {
			readonly kind: 'revoke';
			readonly zoneId: string;
			readonly profileId: string;
			readonly providerId: string;
	  };

export interface CredentialMaintainerResult {
	readonly ok: boolean;
	readonly message: string;
}
```

Create `packages/credential-runner/src/maintainer/credential-maintainer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { CredentialMaintainerOperation } from './credential-maintainer.js';

describe('CredentialMaintainerOperation', () => {
	it('keeps maintainer operations explicit and operator-scoped', () => {
		const operation = {
			kind: 'connect',
			zoneId: 'shravan-claw',
			profileId: 'personal',
			providerId: 'google',
		} satisfies CredentialMaintainerOperation;

		expect(operation.kind).toBe('connect');
	});
});
```

- [ ] **Step 2: Export maintainer types**

Modify `packages/credential-runner/src/index.ts`:

```ts
export type {
	CredentialMaintainerOperation,
	CredentialMaintainerResult,
} from './maintainer/credential-maintainer.js';
```

- [ ] **Step 3: Add controller maintainer guard test**

Create `packages/agent-vm/src/controller/credential-runner/maintainer-command.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { assertMaintainerOperationIsOperatorOnly } from './maintainer-command.js';

describe('assertMaintainerOperationIsOperatorOnly', () => {
	it('rejects agent-originated maintainer operations', () => {
		expect(() =>
			assertMaintainerOperationIsOperatorOnly({
				origin: 'agent-tool',
			}),
		).toThrow('Credential maintainer operations are operator-only');
	});
});
```

- [ ] **Step 4: Implement controller maintainer guard**

Create `packages/agent-vm/src/controller/credential-runner/maintainer-command.ts`:

```ts
export interface MaintainerOrigin {
	readonly origin: 'operator-cli' | 'controller-startup' | 'agent-tool';
}

export function assertMaintainerOperationIsOperatorOnly(origin: MaintainerOrigin): void {
	if (origin.origin === 'agent-tool') {
		throw new Error('Credential maintainer operations are operator-only');
	}
}
```

- [ ] **Step 5: Run maintainer tests**

Run:

```bash
pnpm test:unit -- packages/credential-runner/src/maintainer/credential-maintainer.test.ts packages/agent-vm/src/controller/credential-runner/maintainer-command.test.ts
```

Expected result: maintainer tests pass.

### Task 8: Add direct argv execution to the Gondolin adapter

**Files:**

- Modify: `packages/gondolin-adapter/src/vm-adapter.ts`
- Modify: `packages/gondolin-adapter/src/vm-adapter.test.ts`

- [ ] **Step 1: Write failing adapter test**

Add to `packages/gondolin-adapter/src/vm-adapter.test.ts`:

```ts
it('exposes execDirect for argv execution without shell string joining', async () => {
	const execDirectCalls: readonly string[][][] = [];
	const managedVm = await createManagedVm(
		{
			imagePath: '',
			memory: '256M',
			cpus: 1,
			rootfsMode: 'memory',
			allowedHosts: [],
			secrets: {},
			vfsMounts: {},
		},
		{
			...createTestManagedVmDependencies(),
			createVm: async () => ({
				id: 'vm-argv',
				exec: async () => ({ exitCode: 99 }),
				execDirect: async (argv: readonly string[]) => {
					execDirectCalls.push([argv]);
					return { exitCode: 0, stdout: 'ok', stderr: '' };
				},
				enableSsh: async () => ({ host: '127.0.0.1', port: 2222 }),
				enableIngress: async () => ({ host: '127.0.0.1', port: 3000 }),
				setIngressRoutes: () => {},
				close: async () => {},
			}),
		},
	);

	await expect(managedVm.execDirect(['/usr/local/bin/gog', 'calendar'])).resolves.toEqual({
		exitCode: 0,
		stdout: 'ok',
		stderr: '',
	});
	expect(execDirectCalls).toEqual([[['/usr/local/bin/gog', 'calendar']]]);
});
```

- [ ] **Step 2: Extend adapter types and wrapper**

Modify `packages/gondolin-adapter/src/vm-adapter.ts`:

```ts
export interface ManagedVmInstance {
	readonly id: string;
	exec(command: string): Promise<{
		readonly exitCode: number;
		readonly stdout?: string;
		readonly stderr?: string;
	}>;
	execDirect?(argv: readonly string[]): Promise<{
		readonly exitCode: number;
		readonly stdout?: string;
		readonly stderr?: string;
	}>;
	// existing methods stay unchanged
}

export interface ManagedVm {
	readonly id: string;
	exec(command: string): Promise<ExecResult>;
	execDirect(argv: readonly string[]): Promise<ExecResult>;
	// existing methods stay unchanged
}
```

Add to the returned object in `createManagedVm`:

```ts
async execDirect(argv: readonly string[]): Promise<ExecResult> {
	if (!vmInstance.execDirect) {
		throw new Error('Gondolin VM instance does not support direct argv execution');
	}
	const executionResult = await vmInstance.execDirect(argv);
	return {
		exitCode: executionResult.exitCode,
		stdout: executionResult.stdout ?? '',
		stderr: executionResult.stderr ?? '',
	};
},
```

- [ ] **Step 3: Run adapter tests**

Run:

```bash
pnpm test:unit -- packages/gondolin-adapter/src/vm-adapter.test.ts
```

Expected result: adapter tests pass. If Gondolin 0.9.1 does not expose `execDirect`, keep the method as an adapter seam that throws and implement credentialed runner execution with a temporary generated argv JSON wrapper in the runner image. Do not join agent values into a shell string.

### Task 9: Add credentialed runner lease manager

**Files:**

- Create: `packages/agent-vm/src/controller/credential-runner/credentialed-runner-lease-manager.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/credentialed-runner-lease-manager.test.ts`

- [ ] **Step 1: Write failing lease manager tests**

Create `packages/agent-vm/src/controller/credential-runner/credentialed-runner-lease-manager.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createCredentialedRunnerLeaseManager } from './credentialed-runner-lease-manager.js';

describe('createCredentialedRunnerLeaseManager', () => {
	it('reuses a warm lease for the same zone/profile/provider/backend key', async () => {
		const createRunner = vi.fn(async () => ({
			id: `runner-${createRunner.mock.calls.length}`,
			close: vi.fn(async () => {}),
		}));
		const manager = createCredentialedRunnerLeaseManager({
			createRunner,
			now: () => 1000,
		});

		const first = await manager.acquire({
			zoneId: 'shravan-claw',
			profileId: 'personal',
			providerId: 'google',
			lifetime: 'warm-lease',
			idleTtlMs: 300_000,
		});
		const second = await manager.acquire({
			zoneId: 'shravan-claw',
			profileId: 'personal',
			providerId: 'google',
			lifetime: 'warm-lease',
			idleTtlMs: 300_000,
		});

		expect(second.id).toBe(first.id);
		expect(createRunner).toHaveBeenCalledTimes(1);
	});

	it('closes per-call runners after release', async () => {
		const close = vi.fn(async () => {});
		const manager = createCredentialedRunnerLeaseManager({
			createRunner: async () => ({ id: 'runner-1', close }),
			now: () => 1000,
		});

		const lease = await manager.acquire({
			zoneId: 'shravan-claw',
			profileId: 'personal',
			providerId: 'google',
			lifetime: 'per-call',
		});
		await manager.releaseAfterRun(lease);

		expect(close).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 2: Implement lease manager**

Create `packages/agent-vm/src/controller/credential-runner/credentialed-runner-lease-manager.ts`:

```ts
export interface CredentialedRunnerHandle {
	readonly id: string;
	close(): Promise<void>;
}

export interface CredentialedRunnerLeaseRequest {
	readonly zoneId: string;
	readonly profileId: string;
	readonly providerId: string;
	readonly lifetime: 'per-call' | 'warm-lease';
	readonly idleTtlMs?: number;
}

export interface CredentialedRunnerLease extends CredentialedRunnerLeaseRequest {
	readonly id: string;
	readonly runner: CredentialedRunnerHandle;
	readonly lastUsedAt: number;
}

export interface CredentialedRunnerLeaseManager {
	acquire(request: CredentialedRunnerLeaseRequest): Promise<CredentialedRunnerLease>;
	releaseAfterRun(lease: CredentialedRunnerLease): Promise<void>;
	closeExpiredWarmLeases(): Promise<void>;
}

function leaseKey(request: CredentialedRunnerLeaseRequest): string {
	return `${request.zoneId}\0${request.profileId}\0${request.providerId}`;
}

export function createCredentialedRunnerLeaseManager(options: {
	readonly createRunner: (request: CredentialedRunnerLeaseRequest) => Promise<CredentialedRunnerHandle>;
	readonly now: () => number;
}): CredentialedRunnerLeaseManager {
	const warmLeases = new Map<string, CredentialedRunnerLease>();

	return {
		async acquire(request): Promise<CredentialedRunnerLease> {
			const key = leaseKey(request);
			if (request.lifetime === 'warm-lease') {
				const existing = warmLeases.get(key);
				if (existing) {
					const touched = { ...existing, lastUsedAt: options.now() };
					warmLeases.set(key, touched);
					return touched;
				}
			}

			const runner = await options.createRunner(request);
			const lease = {
				...request,
				id: `${request.zoneId}-${request.profileId}-${request.providerId}-${options.now()}`,
				runner,
				lastUsedAt: options.now(),
			};
			if (request.lifetime === 'warm-lease') {
				warmLeases.set(key, lease);
			}
			return lease;
		},
		async releaseAfterRun(lease): Promise<void> {
			if (lease.lifetime === 'per-call') {
				await lease.runner.close();
			}
		},
		async closeExpiredWarmLeases(): Promise<void> {
			for (const [key, lease] of warmLeases.entries()) {
				if (lease.idleTtlMs !== undefined && options.now() - lease.lastUsedAt >= lease.idleTtlMs) {
					warmLeases.delete(key);
					await lease.runner.close();
				}
			}
		},
	};
}
```

- [ ] **Step 3: Run lease manager tests**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/controller/credential-runner/credentialed-runner-lease-manager.test.ts
```

Expected result: lease manager tests pass.

### Task 10: Build credentialed VM factory

**Files:**

- Create: `packages/agent-vm/src/controller/credential-runner/credentialed-vm-factory.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/credentialed-vm-factory.test.ts`

- [ ] **Step 1: Write failing VM factory test**

Create `packages/agent-vm/src/controller/credential-runner/credentialed-vm-factory.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createCredentialedRunnerVm } from './credentialed-vm-factory.js';

describe('createCredentialedRunnerVm', () => {
	it('creates a VM without SSH and with credential runner mounts', async () => {
		const createManagedVm = vi.fn(async () => ({
			id: 'runner-vm',
			exec: vi.fn(),
			execDirect: vi.fn(),
			enableSsh: vi.fn(),
			enableIngress: vi.fn(),
			getVmInstance: vi.fn(),
			setIngressRoutes: vi.fn(),
			close: vi.fn(),
		}));

		await createCredentialedRunnerVm({
			createManagedVm,
			imagePath: '/images/credentialed-tool-vm.img',
			memory: '1024M',
			cpus: 2,
			allowedHosts: ['calendar.googleapis.com'],
			vfsMounts: {
				'/cred': { kind: 'realfs', hostPath: '/state/cred' },
				'/in': { kind: 'realfs-readonly', hostPath: '/tmp/in' },
				'/cwd': { kind: 'memory' },
				'/out': { kind: 'realfs', hostPath: '/tmp/out' },
			},
			sessionLabel: 'credential-runner-google',
		});

		expect(createManagedVm).toHaveBeenCalledWith(
			expect.objectContaining({
				rootfsMode: 'memory',
				allowedHosts: ['calendar.googleapis.com'],
				secrets: {},
				vfsMounts: expect.objectContaining({
					'/cred': { kind: 'realfs', hostPath: '/state/cred' },
					'/in': { kind: 'realfs-readonly', hostPath: '/tmp/in' },
					'/cwd': { kind: 'memory' },
					'/out': { kind: 'realfs', hostPath: '/tmp/out' },
				}),
			}),
		);
	});
});
```

- [ ] **Step 2: Implement VM factory**

Create `packages/agent-vm/src/controller/credential-runner/credentialed-vm-factory.ts`:

```ts
import type { CreateVmOptions, ManagedVm, VfsMountSpec } from '@agent-vm/gondolin-adapter';

export interface CreateCredentialedRunnerVmOptions {
	readonly createManagedVm: (options: CreateVmOptions) => Promise<ManagedVm>;
	readonly imagePath: string;
	readonly memory: string;
	readonly cpus: number;
	readonly allowedHosts: readonly string[];
	readonly vfsMounts: Record<string, VfsMountSpec>;
	readonly sessionLabel: string;
}

export async function createCredentialedRunnerVm(
	options: CreateCredentialedRunnerVmOptions,
): Promise<ManagedVm> {
	return await options.createManagedVm({
		imagePath: options.imagePath,
		memory: options.memory,
		cpus: options.cpus,
		rootfsMode: 'memory',
		allowedHosts: options.allowedHosts,
		secrets: {},
		vfsMounts: options.vfsMounts,
		sessionLabel: options.sessionLabel,
	});
}
```

- [ ] **Step 3: Run VM factory tests**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/controller/credential-runner/credentialed-vm-factory.test.ts
```

Expected result: VM factory tests pass.

### Task 11: Add controller execute route

**Files:**

- Create: `packages/credential-runner/src/execution/credential-tool-executor.ts`
- Create: `packages/credential-runner/src/execution/credential-tool-executor.test.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-routes.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-routes.test.ts`
- Modify: `packages/agent-vm/src/controller/http/controller-http-routes.ts`
- Modify: `packages/credential-runner/src/index.ts`

- [ ] **Step 1: Define executor result types**

Create `packages/credential-runner/src/execution/credential-tool-executor.ts`:

```ts
import type { CredentialToolOutput } from '../policy/output-policy.js';

export interface CredentialToolExecuteRequest {
	readonly zoneId: string;
	readonly agentId: string;
	readonly toolName: string;
	readonly args: Record<string, unknown>;
}

export type CredentialToolExecuteResult =
	| {
			readonly ok: true;
			readonly runId: string;
			readonly output: CredentialToolOutput;
			readonly durationMs: number;
	  }
	| {
			readonly ok: false;
			readonly runId: string;
			readonly errorCode:
				| 'agent-not-authorized'
				| 'tool-not-found'
				| 'invalid-args'
				| 'backend-disabled'
				| 'execution-failed'
				| 'output-rejected';
			readonly message: string;
	  };
```

Create `packages/credential-runner/src/execution/credential-tool-executor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { CredentialToolExecuteResult } from './credential-tool-executor.js';

describe('CredentialToolExecuteResult', () => {
	it('distinguishes policy failures from successful outputs', () => {
		const result = {
			ok: false,
			runId: 'run-1',
			errorCode: 'invalid-args',
			message: 'calendarId is required',
		} satisfies CredentialToolExecuteResult;

		expect(result.ok).toBe(false);
	});
});
```

- [ ] **Step 2: Export executor types**

Modify `packages/credential-runner/src/index.ts`:

```ts
export type {
	CredentialToolExecuteRequest,
	CredentialToolExecuteResult,
} from './execution/credential-tool-executor.js';
```

- [ ] **Step 3: Add controller route tests**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-routes.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { createCredentialRunnerExecuteHandler } from './credential-runner-routes.js';

describe('createCredentialRunnerExecuteHandler', () => {
	it('rejects a request whose agentId is not trusted by the route context', async () => {
		const handler = createCredentialRunnerExecuteHandler({
			executeCredentialTool: vi.fn(),
		});

		const result = await handler({
			trustedAgentId: 'agent-a',
			body: {
				zoneId: 'zone',
				agentId: 'agent-b',
				toolName: 'google.calendar.list_events',
				args: {},
			},
		});

		expect(result).toEqual({
			status: 403,
			body: {
				ok: false,
				errorCode: 'agent-not-authorized',
				message: 'Request agentId does not match trusted route context.',
			},
		});
	});
});
```

- [ ] **Step 4: Implement route handler seam**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-routes.ts`:

```ts
import type {
	CredentialToolExecuteRequest,
	CredentialToolExecuteResult,
} from '@agent-vm/credential-runner';

export interface CredentialRunnerRouteRequest {
	readonly trustedAgentId: string;
	readonly body: CredentialToolExecuteRequest;
}

export type CredentialRunnerRouteResponse =
	| {
			readonly status: 200;
			readonly body: CredentialToolExecuteResult;
	  }
	| {
			readonly status: 403;
			readonly body: {
				readonly ok: false;
				readonly errorCode: 'agent-not-authorized';
				readonly message: string;
			};
	  };

export function createCredentialRunnerExecuteHandler(options: {
	readonly executeCredentialTool: (
		request: CredentialToolExecuteRequest,
	) => Promise<CredentialToolExecuteResult>;
}): (request: CredentialRunnerRouteRequest) => Promise<CredentialRunnerRouteResponse> {
	return async (request) => {
		if (request.body.agentId !== request.trustedAgentId) {
			return {
				status: 403,
				body: {
					ok: false,
					errorCode: 'agent-not-authorized',
					message: 'Request agentId does not match trusted route context.',
				},
			};
		}

		return {
			status: 200,
			body: await options.executeCredentialTool(request.body),
		};
	};
}
```

- [ ] **Step 5: Wire route into controller HTTP**

Modify `packages/agent-vm/src/controller/http/controller-http-routes.ts`:

- Add an internal route under the zone route group:

```ts
app.post('/zones/:zoneId/credential-runner/execute', async (context) => {
	const zoneId = context.req.param('zoneId');
	const trustedAgentId = context.req.header('x-agent-vm-agent-id');
	if (!trustedAgentId) {
		return context.json({ error: 'missing trusted agent id' }, 401);
	}
	const body = await context.req.json();
	const result = await credentialRunnerExecuteHandler({
		trustedAgentId,
		body: {
			...body,
			zoneId,
		},
	});
	return context.json(result.body, result.status);
});
```

The final code must use the repo's existing authorization/header conventions. The route must not accept model-supplied `agentId` as trusted identity.

- [ ] **Step 6: Run route tests**

Run:

```bash
pnpm test:unit -- packages/credential-runner/src/execution/credential-tool-executor.test.ts packages/agent-vm/src/controller/credential-runner/credential-runner-routes.test.ts
```

Expected result: route tests pass.

### Task 12: Add artifact store and output publication

**Files:**

- Create: `packages/agent-vm/src/controller/credential-runner/artifact-store.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/artifact-store.test.ts`

- [ ] **Step 1: Write artifact validation tests**

Create `packages/agent-vm/src/controller/credential-runner/artifact-store.test.ts`:

```ts
import { mkdir, symlink, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { publishCredentialRunnerArtifacts } from './artifact-store.js';

describe('publishCredentialRunnerArtifacts', () => {
	it('publishes regular allowed files as artifact URIs', async () => {
		const root = await mkdtemp(join(tmpdir(), 'credential-artifacts-'));
		try {
			const outDir = join(root, 'out');
			await mkdir(outDir);
			await writeFile(join(outDir, 'events.json'), '{"ok":true}');

			await expect(
				publishCredentialRunnerArtifacts({
					runId: 'run-1',
					outDir,
					maxArtifactBytes: 1024,
					allowedExtensions: ['.json'],
				}),
			).resolves.toEqual([
				{
					name: 'events.json',
					uri: 'artifact://credential-runner/run-1/events.json',
					sizeBytes: 11,
				},
			]);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	it('rejects symlinks before exposing artifacts', async () => {
		const root = await mkdtemp(join(tmpdir(), 'credential-artifacts-'));
		try {
			const outDir = join(root, 'out');
			await mkdir(outDir);
			await symlink('/etc/passwd', join(outDir, 'leak.json'));

			await expect(
				publishCredentialRunnerArtifacts({
					runId: 'run-1',
					outDir,
					maxArtifactBytes: 1024,
					allowedExtensions: ['.json'],
				}),
			).rejects.toThrow('Artifact leak.json is not a regular file');
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
```

- [ ] **Step 2: Implement artifact store**

Create `packages/agent-vm/src/controller/credential-runner/artifact-store.ts`:

```ts
import { readdir, stat } from 'node:fs/promises';
import { extname } from 'node:path';

import type { CredentialToolArtifact } from '@agent-vm/credential-runner';

export interface PublishCredentialRunnerArtifactsOptions {
	readonly runId: string;
	readonly outDir: string;
	readonly maxArtifactBytes: number;
	readonly allowedExtensions: readonly string[];
}

export async function publishCredentialRunnerArtifacts(
	options: PublishCredentialRunnerArtifactsOptions,
): Promise<readonly CredentialToolArtifact[]> {
	const entries = await readdir(options.outDir, { withFileTypes: true });
	const artifacts: CredentialToolArtifact[] = [];
	let totalBytes = 0;

	for (const entry of entries) {
		if (!entry.isFile()) {
			throw new Error(`Artifact ${entry.name} is not a regular file`);
		}
		if (!options.allowedExtensions.includes(extname(entry.name))) {
			throw new Error(`Artifact ${entry.name} has an extension that is not allowed`);
		}
		const fullPath = `${options.outDir}/${entry.name}`;
		const fileStats = await stat(fullPath);
		totalBytes += fileStats.size;
		if (totalBytes > options.maxArtifactBytes) {
			throw new Error(`Artifacts exceeded ${options.maxArtifactBytes} bytes`);
		}
		artifacts.push({
			name: entry.name,
			uri: `artifact://credential-runner/${options.runId}/${entry.name}`,
			sizeBytes: fileStats.size,
		});
	}

	return artifacts;
}
```

- [ ] **Step 3: Run artifact tests**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/controller/credential-runner/artifact-store.test.ts
```

Expected result: artifact tests pass.

### Task 13: Add OpenClaw tool registration helper

**Files:**

- Create: `packages/credential-runner/src/openclaw/openclaw-tool-registration.ts`
- Create: `packages/credential-runner/src/openclaw/openclaw-tool-registration.test.ts`
- Modify: `packages/credential-runner/src/index.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/credential-runner-tools.ts`
- Create: `packages/openclaw-agent-vm-plugin/src/credential-runner-tools.test.ts`
- Modify: `packages/openclaw-agent-vm-plugin/package.json`

- [ ] **Step 1: Add package-level registration helper**

Create `packages/credential-runner/src/openclaw/openclaw-tool-registration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { credentialToolNameToOpenClawToolName } from './openclaw-tool-registration.js';

describe('credentialToolNameToOpenClawToolName', () => {
	it('uses a stable prefix for generated OpenClaw tools', () => {
		expect(credentialToolNameToOpenClawToolName('google.calendar.list_events')).toBe(
			'credential_google_calendar_list_events',
		);
	});
});
```

Create `packages/credential-runner/src/openclaw/openclaw-tool-registration.ts`:

```ts
export function credentialToolNameToOpenClawToolName(toolName: string): string {
	return `credential_${toolName.replaceAll('.', '_').replaceAll('-', '_')}`;
}
```

Modify `packages/credential-runner/src/index.ts`:

```ts
export { credentialToolNameToOpenClawToolName } from './openclaw/openclaw-tool-registration.js';
```

- [ ] **Step 2: Add plugin helper**

Create `packages/openclaw-agent-vm-plugin/src/credential-runner-tools.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { registerCredentialRunnerTools } from './credential-runner-tools.js';

describe('registerCredentialRunnerTools', () => {
	it('registers one OpenClaw tool per credential tool', () => {
		const registerTool = vi.fn();

		registerCredentialRunnerTools({
			catalog: {
				providers: {},
				tools: {
					'google.calendar.list_events': {
						provider: 'google',
						description: 'List events.',
						execution: {
							executable: '/usr/local/bin/gog',
							argv: ['calendar', 'events', '--json'],
							cwd: '/cwd',
							timeoutMs: 30_000,
						},
						args: {},
						output: { kind: 'stdout-json', maxStdoutBytes: 1024, redact: true },
					},
				},
			},
			registerTool,
			postExecute: async () => ({ ok: true, runId: 'run-1', output: { kind: 'json', value: {}, stderr: '' }, durationMs: 1 }),
		});

		expect(registerTool).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'credential_google_calendar_list_events',
				description: 'List events.',
			}),
			expect.any(Function),
		);
	});
});
```

Create `packages/openclaw-agent-vm-plugin/src/credential-runner-tools.ts`:

```ts
import {
	credentialToolNameToOpenClawToolName,
	type CredentialToolCatalog,
	type CredentialToolExecuteResult,
} from '@agent-vm/credential-runner';

export interface RegisterCredentialRunnerToolsOptions {
	readonly catalog: CredentialToolCatalog;
	readonly registerTool: (
		tool: { readonly name: string; readonly description: string },
		handler: (args: Record<string, unknown>, context: { readonly agentId: string }) => Promise<CredentialToolExecuteResult>,
	) => void;
	readonly postExecute: (request: {
		readonly agentId: string;
		readonly toolName: string;
		readonly args: Record<string, unknown>;
	}) => Promise<CredentialToolExecuteResult>;
}

export function registerCredentialRunnerTools(options: RegisterCredentialRunnerToolsOptions): void {
	for (const [toolName, tool] of Object.entries(options.catalog.tools)) {
		options.registerTool(
			{
				name: credentialToolNameToOpenClawToolName(toolName),
				description: tool.description,
			},
			async (args, context) =>
				await options.postExecute({
					agentId: context.agentId,
					toolName,
					args,
				}),
		);
	}
}
```

- [ ] **Step 3: Add dependency**

Modify `packages/openclaw-agent-vm-plugin/package.json`:

```json
"dependencies": {
	"@agent-vm/credential-runner": "workspace:*"
}
```

Keep existing dependencies intact.

- [ ] **Step 4: Run registration tests**

Run:

```bash
pnpm test:unit -- packages/credential-runner/src/openclaw/openclaw-tool-registration.test.ts packages/openclaw-agent-vm-plugin/src/credential-runner-tools.test.ts
```

Expected result: registration tests pass.

### Task 14: Add controlled batch planning

**Files:**

- Create: `packages/credential-runner/src/execution/batch-planner.ts`
- Create: `packages/credential-runner/src/execution/batch-planner.test.ts`
- Modify: `packages/credential-runner/src/index.ts`

- [ ] **Step 1: Write failing batch planner tests**

Create `packages/credential-runner/src/execution/batch-planner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { validateCredentialToolBatch } from './batch-planner.js';

describe('validateCredentialToolBatch', () => {
	it('allows later steps to reference prior output handles', () => {
		expect(
			validateCredentialToolBatch({
				steps: [
					{
						id: 'events',
						toolName: 'google.calendar.list_events',
						args: {},
					},
					{
						id: 'page',
						toolName: 'notion.page.create',
						args: {
							titleFrom: { fromStep: 'events', jsonPointer: '/0/summary' },
						},
					},
				],
			}),
		).toEqual({ ok: true });
	});

	it('rejects references to unknown future handles', () => {
		expect(
			validateCredentialToolBatch({
				steps: [
					{
						id: 'page',
						toolName: 'notion.page.create',
						args: {
							titleFrom: { fromStep: 'events', jsonPointer: '/0/summary' },
						},
					},
				],
			}),
		).toEqual({
			ok: false,
			message: "Step 'page' references unknown prior step 'events'",
		});
	});
});
```

- [ ] **Step 2: Implement batch planner**

Create `packages/credential-runner/src/execution/batch-planner.ts`:

```ts
export interface CredentialToolBatch {
	readonly steps: readonly CredentialToolBatchStep[];
}

export interface CredentialToolBatchStep {
	readonly id: string;
	readonly toolName: string;
	readonly args: Record<string, unknown>;
}

export type CredentialToolBatchValidation =
	| { readonly ok: true }
	| { readonly ok: false; readonly message: string };

function isStepReference(value: unknown): value is { readonly fromStep: string; readonly jsonPointer: string } {
	return (
		typeof value === 'object' &&
		value !== null &&
		'fromStep' in value &&
		'jsonPointer' in value &&
		typeof value.fromStep === 'string' &&
		typeof value.jsonPointer === 'string'
	);
}

export function validateCredentialToolBatch(batch: CredentialToolBatch): CredentialToolBatchValidation {
	const priorStepIds = new Set<string>();
	for (const step of batch.steps) {
		for (const value of Object.values(step.args)) {
			if (isStepReference(value) && !priorStepIds.has(value.fromStep)) {
				return {
					ok: false,
					message: `Step '${step.id}' references unknown prior step '${value.fromStep}'`,
				};
			}
		}
		priorStepIds.add(step.id);
	}
	return { ok: true };
}
```

- [ ] **Step 3: Export batch planner**

Modify `packages/credential-runner/src/index.ts`:

```ts
export { validateCredentialToolBatch } from './execution/batch-planner.js';
export type {
	CredentialToolBatch,
	CredentialToolBatchStep,
	CredentialToolBatchValidation,
} from './execution/batch-planner.js';
```

- [ ] **Step 4: Run batch tests**

Run:

```bash
pnpm test:unit -- packages/credential-runner/src/execution/batch-planner.test.ts
```

Expected result: batch tests pass.

### Task 15: Add system config integration

**Files:**

- Modify: `packages/agent-vm/src/config/system-config.ts`
- Modify: `packages/agent-vm/src/config/system-config.test.ts`
- Modify: `docs/reference/configuration/system-json.md`

- [ ] **Step 1: Write failing system config tests**

Add to `packages/agent-vm/src/config/system-config.test.ts`:

```ts
it('accepts credentialRunner config on OpenClaw zones', () => {
	const config = parseSystemConfig({
		host: { controllerPort: 3000 },
		toolVmProfiles: {
			default: { imageProfile: 'tool-vm', memory: '1G', cpus: 2 },
		},
		zones: [
			{
				id: 'shravan-claw',
				type: 'openclaw',
				gatewayProfile: 'openclaw',
				defaultToolVmProfile: 'default',
				credentialRunner: {
					configDir: './config/credential-runner',
					stateKey: {
						identityRef: 'op://agent-vm/credential-runner/age-identity',
						recipientRef: 'op://agent-vm/credential-runner/age-recipient',
					},
					hostBackend: { enabled: false },
					profileBindings: { 'agent-a': 'personal' },
				},
				egressHosts: [{ host: 'calendar.googleapis.com', audience: 'tool-vm' }],
			},
		],
	});

	expect(config.zones[0]?.credentialRunner?.profileBindings['agent-a']).toBe('personal');
});

it('rejects credentialRunner host backend when enabled outside OpenClaw zones', () => {
	expect(() =>
		parseSystemConfig({
			host: { controllerPort: 3000 },
			zones: [
				{
					id: 'worker-zone',
					type: 'worker',
					gatewayProfile: 'worker',
					credentialRunner: {
						configDir: './config/credential-runner',
						stateKey: {
							identityRef: 'op://agent-vm/credential-runner/age-identity',
							recipientRef: 'op://agent-vm/credential-runner/age-recipient',
						},
						hostBackend: { enabled: true },
						profileBindings: {},
					},
				},
			],
		}),
	).toThrow('credentialRunner is only supported on OpenClaw zones');
});
```

- [ ] **Step 2: Implement schema fields**

Add a `credentialRunner` zone schema object in `packages/agent-vm/src/config/system-config.ts`:

```ts
const credentialRunnerZoneSchema = z.object({
	configDir: z.string().min(1),
	stateKey: z.object({
		identityRef: z.string().regex(/^op:\/\//),
		recipientRef: z.string().regex(/^op:\/\//),
	}),
	hostBackend: z.object({
		enabled: z.boolean(),
	}),
	profileBindings: z.record(z.string().min(1), z.string().min(1)),
});
```

Thread it into the OpenClaw zone schema:

```ts
credentialRunner: credentialRunnerZoneSchema.optional(),
```

In cross-field validation, reject it for non-OpenClaw zones:

```ts
if (zone.type !== 'openclaw' && zone.credentialRunner) {
	throw new Error('credentialRunner is only supported on OpenClaw zones');
}
```

- [ ] **Step 3: Document config**

Update `docs/reference/configuration/system-json.md` with:

```markdown
### `zones[].credentialRunner`

OpenClaw-only. Configures the credentialed tool system. The controller uses
this block to locate the credential tool catalog, resolve the age state key
from 1Password, and bind trusted OpenClaw agent ids to credential profiles.

The agent does not choose a credential profile. The OpenClaw plugin passes the
trusted `ctx.agentId`; the controller maps that id through
`profileBindings`.
```

- [ ] **Step 4: Run system config tests**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/config/system-config.test.ts
```

Expected result: system config tests pass.

### Task 16: Add fake CLI integration before real providers

**Files:**

- Create: `packages/agent-vm/src/controller/credential-runner/credential-runner-routes.integration.test.ts`
- Create: `packages/credential-runner/src/testing.ts`

- [ ] **Step 1: Add fake CLI catalog fixture**

Extend `packages/credential-runner/src/testing.ts`:

```ts
export { buildCredentialToolArgv } from './policy/argv-builder.js';
export { normalizeCredentialToolOutput } from './policy/output-policy.js';

import type { CredentialToolCatalog } from './catalog/credential-tool-catalog.js';

export const credentialRunnerTestingPackageMarker = '@agent-vm/credential-runner/testing';

export const fakeCredentialToolCatalog = {
	providers: {
		fake: {
			backend: {
				kind: 'vm',
				imageProfile: 'credentialed-tool-vm',
				lifetime: 'per-call',
			},
			stateScope: 'profile-provider',
			credentialMount: '/cred',
			audienceHosts: ['api.example.test'],
		},
	},
	tools: {
		'fake.echo_json': {
			provider: 'fake',
			description: 'Echo JSON for credential-runner integration tests.',
			execution: {
				executable: '/usr/local/bin/fake-credential-cli',
				argv: ['echo-json', { param: 'message', flag: '--message' }],
				cwd: '/cwd',
				timeoutMs: 5_000,
			},
			args: {
				message: { type: 'string', minLength: 1, maxLength: 100 },
			},
			output: {
				kind: 'stdout-json',
				maxStdoutBytes: 4096,
				redact: true,
			},
		},
	},
} satisfies CredentialToolCatalog;
```

- [ ] **Step 2: Add integration test seam**

Create `packages/agent-vm/src/controller/credential-runner/credential-runner-routes.integration.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

import { buildCredentialToolArgv, fakeCredentialToolCatalog, normalizeCredentialToolOutput } from '@agent-vm/credential-runner/testing';

describe('credential runner fake CLI integration', () => {
	it('builds argv, executes the backend, and parses stdout JSON', async () => {
		const tool = fakeCredentialToolCatalog.tools['fake.echo_json'];
		const execDirect = vi.fn(async () => ({
			exitCode: 0,
			stdout: '{"message":"hello"}',
			stderr: '',
		}));

		const argv = buildCredentialToolArgv({
			tool,
			args: { message: 'hello' },
		});
		const result = await execDirect(argv);
		const output = normalizeCredentialToolOutput({
			policy: tool.output,
			stdout: result.stdout,
			stderr: result.stderr,
		});

		expect(argv).toEqual(['/usr/local/bin/fake-credential-cli', 'echo-json', '--message', 'hello']);
		expect(output).toEqual({
			kind: 'json',
			value: { message: 'hello' },
			stderr: '',
		});
	});
});
```

- [ ] **Step 3: Run fake integration**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/controller/credential-runner/credential-runner-routes.integration.test.ts
```

Expected result: fake integration passes.

### Task 17: Add provider catalog entries for gogcli, ntn, and linear-cli

**Files:**

- Create: `config/credential-runner/credential-tools.config.jsonc`
- Create: `packages/credential-runner/src/catalog/provider-catalog.test.ts`

- [ ] **Step 1: Add real provider catalog**

Create `config/credential-runner/credential-tools.config.jsonc` with initial stdout-only tools:

```jsonc
{
  "providers": {
    "google": {
      "backend": {
        "kind": "vm",
        "imageProfile": "credentialed-tool-vm",
        "lifetime": "warm-lease",
        "idleTtlMs": 300000
      },
      "stateScope": "profile-provider",
      "credentialMount": "/cred",
      "audienceHosts": [
        "accounts.google.com",
        "oauth2.googleapis.com",
        "calendar.googleapis.com"
      ],
      "setup": {
        "tool": "google.auth.connect",
        "requiresOperatorBrowser": true,
        "tcpHosts": {
          "oauth-callback.localhost": "127.0.0.1:0"
        }
      }
    },
    "notion": {
      "backend": {
        "kind": "vm",
        "imageProfile": "credentialed-tool-vm",
        "lifetime": "warm-lease",
        "idleTtlMs": 300000
      },
      "stateScope": "profile-provider",
      "credentialMount": "/cred",
      "audienceHosts": ["api.notion.com"]
    },
    "linear": {
      "backend": {
        "kind": "vm",
        "imageProfile": "credentialed-tool-vm",
        "lifetime": "warm-lease",
        "idleTtlMs": 300000
      },
      "stateScope": "profile-provider",
      "credentialMount": "/cred",
      "audienceHosts": ["api.linear.app"]
    }
  },
  "tools": {
    "google.calendar.list_events": {
      "provider": "google",
      "description": "List Google Calendar events as JSON.",
      "execution": {
        "executable": "/usr/local/bin/gog",
        "argv": [
          "calendar",
          "events",
          "--json",
          { "param": "calendarId", "flag": "--calendar" },
          { "param": "timeMin", "flag": "--time-min" },
          { "param": "timeMax", "flag": "--time-max" },
          { "param": "maxResults", "flag": "--max-results" }
        ],
        "cwd": "/cwd",
        "timeoutMs": 30000
      },
      "args": {
        "calendarId": { "type": "string", "minLength": 1, "maxLength": 256 },
        "timeMin": { "type": "string", "format": "date-time", "optional": true, "maxLength": 64 },
        "timeMax": { "type": "string", "format": "date-time", "optional": true, "maxLength": 64 },
        "maxResults": { "type": "integer", "minimum": 1, "maximum": 100, "optional": true }
      },
      "output": { "kind": "stdout-json", "maxStdoutBytes": 1048576, "redact": true }
    },
    "notion.search": {
      "provider": "notion",
      "description": "Search Notion and return JSON.",
      "execution": {
        "executable": "/usr/local/bin/ntn",
        "argv": ["search", "--json", { "param": "query", "flag": "--query" }],
        "cwd": "/cwd",
        "timeoutMs": 30000
      },
      "args": {
        "query": { "type": "string", "minLength": 1, "maxLength": 512 }
      },
      "output": { "kind": "stdout-json", "maxStdoutBytes": 1048576, "redact": true }
    },
    "linear.issue.list": {
      "provider": "linear",
      "description": "List Linear issues and return JSON.",
      "execution": {
        "executable": "/usr/local/bin/linear",
        "argv": ["issue", "list", "--json", { "param": "query", "flag": "--query" }],
        "cwd": "/cwd",
        "timeoutMs": 30000
      },
      "args": {
        "query": { "type": "string", "minLength": 1, "maxLength": 512, "optional": true }
      },
      "output": { "kind": "stdout-json", "maxStdoutBytes": 1048576, "redact": true }
    }
  }
}
```

- [ ] **Step 2: Validate provider catalog in tests**

Create `packages/credential-runner/src/catalog/provider-catalog.test.ts`:

```ts
import { readFile } from 'node:fs/promises';

import { credentialRunnerConfigSchema } from '@agent-vm/config-contracts';
import { describe, expect, it } from 'vitest';

describe('checked-in credential tools catalog', () => {
	it('matches the credential runner config schema', async () => {
		const configText = await readFile('config/credential-runner/credential-tools.config.jsonc', 'utf8');
		const jsonText = configText.replaceAll(/\/\/.*$/gm, '');
		const parsed = credentialRunnerConfigSchema.safeParse(JSON.parse(jsonText));

		expect(parsed.success).toBe(true);
	});
});
```

- [ ] **Step 3: Run catalog test**

Run:

```bash
pnpm test:unit -- packages/credential-runner/src/catalog/provider-catalog.test.ts
```

Expected result: provider catalog test passes.

### Task 18: Add credentialed runner image

**Files:**

- Create: `docker/base-images/credentialed-tool-vm/Dockerfile`
- Modify: `packages/agent-vm/managed-images.json`
- Create: `packages/agent-vm/src/operations/credential-runner-doctor.ts`
- Create: `packages/agent-vm/src/operations/credential-runner-doctor.test.ts`

- [ ] **Step 1: Create image recipe**

Create `docker/base-images/credentialed-tool-vm/Dockerfile`:

```dockerfile
FROM node:24-slim

ARG TARGETARCH=amd64
ARG GOGCLI_VERSION=0.17.0
ARG NTN_VERSION=0.14.1
ARG SCHPET_LINEAR_CLI_VERSION=2.0.0

RUN set -eux; \
    case "$TARGETARCH" in amd64|arm64) ;; *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl tar; \
    rm -rf /var/lib/apt/lists/*; \
    update-ca-certificates; \
    corepack enable; \
    corepack prepare pnpm@10.33.0 --activate; \
    mkdir -p /usr/local/bin /cred /in /cwd /out

RUN set -eux; \
    asset="gogcli_${GOGCLI_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    release_url="https://github.com/openclaw/gogcli/releases/download/v${GOGCLI_VERSION}"; \
    curl -fsSLO "${release_url}/${asset}"; \
    curl -fsSLO "${release_url}/checksums.txt"; \
    grep " ${asset}$" checksums.txt | sha256sum -c -; \
    tar -xzf "${asset}"; \
    install -m 0755 gog /usr/local/bin/gog; \
    rm -f "${asset}" checksums.txt CHANGELOG.md LICENSE README.md gog

RUN set -eux; \
    pnpm add -g "ntn@${NTN_VERSION}" "@schpet/linear-cli@${SCHPET_LINEAR_CLI_VERSION}"

RUN set -eux; \
    command -v gog; \
    command -v ntn; \
    command -v linear; \
    gog --version; \
    ntn --version; \
    linear --version
```

The Dockerfile must not include tokens, `.npmrc`, `_authToken`, `_password`, or `_secret` strings. The `gogcli` archive checksum must be validated with upstream `checksums.txt`.

- [ ] **Step 2: Add managed image metadata**

Modify `packages/agent-vm/managed-images.json` to add an image profile:

```json
{
	"schemaVersion": 1,
	"baseImages": {
		"credentialed-tool-vm": {
			"repository": "ghcr.io/shravansunder/agent-vm-managed-credentialed-tool-vm-base",
			"tag": "2026.05.20.1"
		}
	}
}
```

Keep the existing `baseImages` entries intact and add only the new `credentialed-tool-vm` entry. Managed image tags are a separate release train from npm package versions.

- [ ] **Step 3: Add doctor coverage for installed CLIs**

Create `packages/agent-vm/src/operations/credential-runner-doctor.ts`:

```ts
export const requiredCredentialRunnerBinaries = ['gog', 'ntn', 'linear'] as const;

export interface CredentialRunnerBinaryCheck {
	readonly binary: (typeof requiredCredentialRunnerBinaries)[number];
	readonly command: readonly string[];
}

export function buildCredentialRunnerBinaryChecks(): readonly CredentialRunnerBinaryCheck[] {
	return requiredCredentialRunnerBinaries.map((binary) => ({
		binary,
		command: [binary, '--version'],
	}));
}
```

Create `packages/agent-vm/src/operations/credential-runner-doctor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
	buildCredentialRunnerBinaryChecks,
	requiredCredentialRunnerBinaries,
} from './credential-runner-doctor.js';

describe('credential runner doctor', () => {
	it('requires gog, ntn, and linear binaries in credentialed-tool-vm images', () => {
		expect(requiredCredentialRunnerBinaries).toEqual(['gog', 'ntn', 'linear']);
	});

	it('builds version probes for each required binary', () => {
		expect(buildCredentialRunnerBinaryChecks()).toEqual([
			{ binary: 'gog', command: ['gog', '--version'] },
			{ binary: 'ntn', command: ['ntn', '--version'] },
			{ binary: 'linear', command: ['linear', '--version'] },
		]);
	});
});
```

- [ ] **Step 4: Run image metadata checks**

Run:

```bash
pnpm check
```

Expected result: package version sync, lint, formatting, typecheck, and configured checks pass.

### Task 19: Add host backend guard

**Files:**

- Create: `packages/agent-vm/src/controller/credential-runner/host-backend-guard.ts`
- Create: `packages/agent-vm/src/controller/credential-runner/host-backend-guard.test.ts`

- [ ] **Step 1: Write host backend guard tests**

Create `packages/agent-vm/src/controller/credential-runner/host-backend-guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { assertHostCredentialBackendAllowed } from './host-backend-guard.js';

describe('assertHostCredentialBackendAllowed', () => {
	it('rejects host backend when zone config has not enabled it', () => {
		expect(() =>
			assertHostCredentialBackendAllowed({
				hostBackendEnabled: false,
				toolName: 'things.task.create',
			}),
		).toThrow("Host credential backend is disabled for tool 'things.task.create'");
	});

	it('allows host backend when zone config has enabled it', () => {
		expect(() =>
			assertHostCredentialBackendAllowed({
				hostBackendEnabled: true,
				toolName: 'things.task.create',
			}),
		).not.toThrow();
	});
});
```

- [ ] **Step 2: Implement host backend guard**

Create `packages/agent-vm/src/controller/credential-runner/host-backend-guard.ts`:

```ts
export interface HostCredentialBackendGuardOptions {
	readonly hostBackendEnabled: boolean;
	readonly toolName: string;
}

export function assertHostCredentialBackendAllowed(
	options: HostCredentialBackendGuardOptions,
): void {
	if (!options.hostBackendEnabled) {
		throw new Error(`Host credential backend is disabled for tool '${options.toolName}'`);
	}
}
```

- [ ] **Step 3: Run host backend guard tests**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/controller/credential-runner/host-backend-guard.test.ts
```

Expected result: guard tests pass.

### Task 20: Documentation and generated manuals

**Files:**

- Modify: `docs/subsystems/secrets-and-credentials.md`
- Modify: `docs/architecture/openclaw-gateway.md`
- Modify: `docs/reference/validate-and-doctor.md`
- Modify: `packages/agent-vm/src/cli/manual-templates.ts`
- Modify: `packages/agent-vm/src/cli/manual-templates.test.ts`

- [ ] **Step 1: Add canonical subsystem docs**

Add a `Credentialed Tool System` section to `docs/subsystems/secrets-and-credentials.md` covering:

```markdown
## Credentialed Tool System

Credentialed tools have two paths:

1. Maintainer path: operator-only credential setup and encrypted state writes.
2. Execution path: agent-callable typed CLI execution through controller policy.

The maintainer path can write `/cred`. The agent execution path cannot choose
profile, executable, env, cwd, mounts, host paths, or flags. The controller
builds argv from catalog schema and runs the command in a credentialed backend.

1Password stores the age identity and public recipient. Provider secrets,
keyrings, OAuth refresh material, static API tokens, and CLI config are stored
in age-encrypted `stateDir/credential-runner/**` state.
```

- [ ] **Step 2: Add OpenClaw architecture docs**

Add to `docs/architecture/openclaw-gateway.md`:

```markdown
### Credentialed Tools

Credentialed tools are native OpenClaw tools registered from the credential
runner catalog. The OpenClaw plugin never sees provider credentials. It passes
trusted `ctx.agentId` and typed args to the controller, and the controller maps
the agent id to a credential profile.

Credentialed runner VMs are not normal Tool VMs. They have no agent SSH, no
general shell, and no live workspace mount. They run controller-built argv in a
fixed VFS layout.
```

- [ ] **Step 3: Add generated manual text**

Update `packages/agent-vm/src/cli/manual-templates.ts` with a concise generated manual section:

```ts
const credentialedToolsManual = `
## Credentialed Tools

Agents can call credentialed tools only through registered OpenClaw tools.
Do not run OAuth setup from an agent shell. Use:

agent-vm credentials connect <provider> --profile <profile>

The controller stores credential state under encrypted stateDir storage. The
agent cannot choose its credential profile, executable path, flags, output
directory, or host backend.
`;
```

- [ ] **Step 4: Test manual content**

Add to `packages/agent-vm/src/cli/manual-templates.test.ts`:

```ts
it('documents credentialed tools as controller-mediated and operator-maintained', () => {
	const manuals = renderManualTemplates();
	const combined = Object.values(manuals).join('\n');

	expect(combined).toContain('Credentialed Tools');
	expect(combined).toContain('agent-vm credentials connect <provider> --profile <profile>');
	expect(combined).toContain('The agent cannot choose its credential profile');
});
```

- [ ] **Step 5: Run docs/manual tests**

Run:

```bash
pnpm test:unit -- packages/agent-vm/src/cli/manual-templates.test.ts
pnpm fmt:check docs/subsystems/secrets-and-credentials.md docs/architecture/openclaw-gateway.md docs/reference/validate-and-doctor.md packages/agent-vm/src/cli/manual-templates.ts packages/agent-vm/src/cli/manual-templates.test.ts
```

Expected result: tests and formatting pass.

### Task 21: End-to-end smoke with one fake command

**Files:**

- Create: `packages/agent-vm/src/integration-tests/credential-runner.smoke.test.ts`

- [ ] **Step 1: Write smoke test**

Create `packages/agent-vm/src/integration-tests/credential-runner.smoke.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

describe('credential runner smoke', () => {
	it('documents the required black-box flow for fake credentialed CLI execution', () => {
		const flow = [
			'load credentialRunner zone config',
			'load credential tools catalog',
			'map trusted agentId to profile',
			'build argv from typed args',
			'acquire credentialed runner lease',
			'execute direct argv',
			'parse bounded stdout',
			'release per-call lease or keep warm lease',
		];

		expect(flow).toHaveLength(8);
	});
});
```

Replace the documentation assertion in this same task with a real black-box controller test once the route is wired. The finished smoke must call the actual controller route with a fake VM factory and assert the returned JSON.

- [ ] **Step 2: Run smoke lane**

Run:

```bash
pnpm test:smoke -- packages/agent-vm/src/integration-tests/credential-runner.smoke.test.ts
```

Expected result: credential runner smoke passes.

### Task 22: Full quality gate

**Files:** all files changed by this plan.

- [ ] **Step 1: Run package tests**

Run:

```bash
pnpm --filter @agent-vm/credential-runner test:unit
pnpm --filter @agent-vm/config-contracts test:unit
pnpm --filter @agent-vm/gondolin-adapter test:unit
pnpm --filter @agent-vm/agent-vm test:unit
pnpm --filter @agent-vm/openclaw-agent-vm-plugin test:unit
```

Expected result: every command exits 0.

- [ ] **Step 2: Run integration and smoke**

Run:

```bash
pnpm test:integration
pnpm test:smoke
```

Expected result: both commands exit 0. If a credentialed live-provider smoke requires real OAuth, keep it out of the default integration lane and document the named opt-in command.

- [ ] **Step 3: Run full check**

Run:

```bash
pnpm check
```

Expected result: package version sync, zod version check, type-aware lint, format check, typecheck, and package typechecks all pass.

## Edge Cases To Test Explicitly

1. Agent sends `agentId` that differs from trusted OpenClaw context.
2. Agent sends unknown tool name.
3. Agent sends unknown arg key.
4. Agent sends flag-shaped value such as `--debug`.
5. Agent sends NUL bytes in arg value.
6. Tool catalog references a param not declared in `args`.
7. Tool catalog references a provider not declared in `providers`.
8. Provider `audienceHosts` includes a host missing from zone `egressHosts`.
9. Host backend tool runs while `hostBackend.enabled` is false.
10. Warm lease is reused for same zone/profile/provider and not reused across profiles.
11. Per-call lease closes even when command exits non-zero.
12. CLI writes rotated keyring state under `/cred`.
13. CLI tries to write outside `/cred`, `/cwd`, or `/out`.
14. CLI writes symlink in `/out`.
15. CLI writes artifact over max bytes.
16. CLI writes disallowed extension.
17. Stdout exceeds `maxStdoutBytes`.
18. Stdout-json command prints invalid JSON.
19. Controller times out the command and closes the runner VM.
20. Batch step references a future or unknown output handle.
21. Batch step tries to treat an artifact handle as an absolute path.
22. 1Password age identity resolution fails.
23. Age decryption fails due to wrong identity.
24. Google OAuth consent screen remains in testing mode and refresh tokens expire after 7 days; maintainer must surface this warning.
25. Generated manuals mention credentialed tools but do not teach forbidden SSH or shell command shapes.

## Out Of Scope For This Plan

- Giving agents direct SSH or shell access to credentialed runner VMs.
- Storing mutable provider secrets in 1Password through a write-capable token.
- Live-mounting runner `/out` into the normal agent Tool VM before validation.
- Raw shell pipelines between credentialed tools.
- Making the host backend default.
- Drive/Gmail binary workflows as first shipped tools. The artifact channel supports them, but the first provider tools are stdout-json.

## Execution Notes

- Stay in the `secrets-source` worktree unless the user explicitly changes lanes.
- Do not commit during implementation unless the user explicitly asks for git writes.
- Re-read `docs/architecture/storage-model.md` before changing `stateDir`, `cacheDir`, or backup behavior.
- If the MCP Portal managed-mode branch is not merged when implementation begins, stop and reconcile the base before coding. The credentialed runner should mirror the managed native-tool pattern, not the old subprocess MCP server pattern.
