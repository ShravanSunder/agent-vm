# SDK Secret Resolution Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make controller and gateway startup resolve multiple 1Password-backed zone secrets through one SDK batch request on the production resolver path, while keeping the `op` CLI fallback serial and preserving per-secret failure context.

**Architecture:** Production startup resolves the 1Password service-account token once, creates the SDK-first resolver, then wraps it in `createCompositeSecretResolver(...)`. The composite resolver is therefore the batching choke point: it must partition secret refs by source, resolve environment refs locally, and forward the 1Password subset to the wrapped resolver's `resolveAll(...)` once. Gateway startup should collect the selected zone refs and call `secretResolver.resolveAll(...)` once, then the startup smoke must build the resolver through `createSecretResolverFromSystemConfig(...)` so a false fake cannot bypass the composite layer.

**Tech Stack:** TypeScript, Node 24, Vitest, `@1password/sdk@0.4.0`, existing `SecretResolver` interface, existing gateway startup orchestration.

---

## Scope And Boundaries

This plan changes secret-resolution plumbing only. It does not change config schema, secret storage, runtime secret injection, OpenClaw bootstrap quoting, auth-profile file semantics, or controller admin authorization.

The `op` CLI fallback stays serial. Current production code documents that serial `op read` avoids concurrent failures with the same service-account token, and this plan does not have evidence strong enough to reverse that decision. The SDK batch API is the fast path; the CLI path is a conservative fallback.

Execution worktree:

```bash
/Users/shravansunder/Documents/dev/project-dev/agent-vm.plan-sdk-secret-resolution-startup
```

Branch:

```bash
plan/sdk-secret-resolution-startup
```

Base:

```bash
origin/master
```

## Production Path To Protect

Startup currently wires the resolver through this path:

```text
packages/agent-vm/src/controller/controller-runtime.ts
  -> createSecretResolver(...)
packages/agent-vm/src/controller/controller-runtime-support.ts
  -> createSecretResolverFromSystemConfig(...)
  -> createCompositeSecretResolver(onePasswordResolver)
packages/agent-vm/src/controller/composite-secret-resolver.ts
  -> resolveAll(...)
packages/agent-vm/src/gateway/credential-manager.ts
  -> resolveZoneSecrets(...)
```

The implementation is only successful when a gateway zone with multiple 1Password secrets reaches the wrapped SDK resolver as one `resolveAll(...)` call from the composite resolver. A test that injects a hand-built `SecretResolver` directly into `startGatewayZone(...)` is not enough because it bypasses the composite layer.

## File Structure

- Modify: `packages/gondolin-adapter/src/secret-resolver.ts`
  - Owns 1Password SDK client construction, SDK `resolveAll` response mapping, and existing serial `op` CLI fallback.

- Modify: `packages/gondolin-adapter/src/secret-resolver.test.ts`
  - Unit tests for SDK `resolveAll`, malformed SDK batch responses, SDK batch rejection fallback, and serial `op` fallback.

- Modify: `packages/agent-vm/src/controller/composite-secret-resolver.ts`
  - Production resolver wrapper. Must partition refs by source and forward 1Password refs through wrapped `resolveAll(...)`.

- Modify: `packages/agent-vm/src/controller/composite-secret-resolver.test.ts`
  - Unit tests proving mixed-source batches resolve env locally and call wrapped 1Password `resolveAll(...)` exactly once.

- Modify: `packages/agent-vm/src/gateway/credential-manager.ts`
  - Build selected zone secret refs and call `secretResolver.resolveAll(...)` once. Preserve validation before resolution and render per-secret details from aggregate failures.

- Modify: `packages/agent-vm/src/gateway/credential-manager.test.ts`
  - Unit tests proving gateway zone resolution calls `resolveAll(...)` once and failure messages still include zone, secret name, and source ref.

- Create: `packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts`
  - Smoke-level startup pipeline test that constructs the resolver through `createSecretResolverFromSystemConfig(...)` and proves the wrapped 1Password resolver receives one `resolveAll(...)` call.

- Modify: `packages/agent-vm/src/cli/agent-vm-cli-support.ts`
  - Change default CLI/controller dependency from op-cli-only resolver to SDK-first resolver.

- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`
  - Change direct controller fallback default from op-cli-only resolver to SDK-first resolver.

- Verify existing tests that mock `createSecretResolver`:
  - `packages/agent-vm/src/controller/controller-runtime.test.ts`
  - `packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts`
  - `packages/agent-vm/src/cli/backup-commands.test.ts`
  - `packages/agent-vm/src/cli/ssh-commands.test.ts`
  - `packages/agent-vm/src/cli/auth-interactive-command.test.ts`

---

### Task 1: Make SDK `resolveAll` The 1Password Fast Path

**Files:**
- Modify: `packages/gondolin-adapter/src/secret-resolver.ts`
- Modify: `packages/gondolin-adapter/src/secret-resolver.test.ts`

- [ ] **Step 1: Write the failing SDK batch test**

Replace the existing test named `resolves a record of secret references and preserves keys` in `packages/gondolin-adapter/src/secret-resolver.test.ts` with:

```ts
it('resolves all refs through the sdk batch API and preserves caller keys', async () => {
	const batchCalls: readonly string[][] = [];
	const singleResolveCalls: string[] = [];
	const fakeClient: SecretResolverClient = {
		secrets: {
			resolve: async (secretReference: string): Promise<string> => {
				singleResolveCalls.push(secretReference);
				return `single:${secretReference}`;
			},
			resolveAll: async (secretReferences: readonly string[]) => {
				batchCalls.push([...secretReferences]);
				return {
					individualResponses: Object.fromEntries(
						secretReferences.map((secretReference) => [
							secretReference,
							{
								content: {
									secret: `batch:${secretReference}`,
									itemId: `item:${secretReference}`,
									vaultId: 'vault-id',
								},
							},
						]),
					),
				};
			},
		},
	};

	const secretResolver = await createSecretResolver(
		{ serviceAccountToken: 'op-token' },
		{
			createClient: async (): Promise<SecretResolverClient> => fakeClient,
		},
	);

	await expect(
		secretResolver.resolveAll({
			DISCORD_BOT_TOKEN: {
				source: '1password',
				ref: 'op://agent-vm/agent-discord-app/bot-token',
			},
			OPENCLAW_GATEWAY_TOKEN: {
				source: '1password',
				ref: 'op://agent-vm/agent-gateway/token',
			},
		}),
	).resolves.toEqual({
		DISCORD_BOT_TOKEN: 'batch:op://agent-vm/agent-discord-app/bot-token',
		OPENCLAW_GATEWAY_TOKEN: 'batch:op://agent-vm/agent-gateway/token',
	});
	expect(batchCalls).toEqual([
		[
			'op://agent-vm/agent-discord-app/bot-token',
			'op://agent-vm/agent-gateway/token',
		],
	]);
	expect(singleResolveCalls).toEqual([]);
});
```

- [ ] **Step 2: Run the failing SDK batch test**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/gondolin-adapter/src/secret-resolver.test.ts -t "sdk batch API"
```

Expected: FAIL because `createSecretResolver(...).resolveAll(...)` currently loops through `client.secrets.resolve(...)` and never calls `client.secrets.resolveAll(...)`.

- [ ] **Step 3: Add typed SDK batch response helpers**

In `packages/gondolin-adapter/src/secret-resolver.ts`, replace the SDK import with:

```ts
import {
	createClient,
	type ResolveAllResponse,
	type ResolveReferenceError,
} from '@1password/sdk';
```

Change the local client interface:

```ts
export interface SecretResolverClient {
	readonly secrets: {
		resolve(secretReference: string): Promise<string>;
		resolveAll(secretReferences: readonly string[]): Promise<ResolveAllResponse>;
	};
}
```

Add these helpers above `createSecretResolver`:

```ts
function formatResolveReferenceError(error: ResolveReferenceError): string {
	return 'message' in error && typeof error.message === 'string'
		? `${error.type}: ${error.message}`
		: error.type;
}

function readSdkBatchSecret(options: {
	readonly response: ResolveAllResponse;
	readonly secretName: string;
	readonly secretReference: string;
}): string {
	const individualResponse = options.response.individualResponses[options.secretReference];
	if (!individualResponse) {
		throw new Error(
			`1Password SDK resolveAll response omitted '${options.secretName}' (${options.secretReference}).`,
		);
	}
	if (individualResponse.content !== undefined) {
		return individualResponse.content.secret;
	}
	if (individualResponse.error !== undefined) {
		throw new Error(
			`1Password SDK resolveAll failed for '${options.secretName}' (${options.secretReference}): ${formatResolveReferenceError(individualResponse.error)}`,
		);
	}
	throw new Error(
		`1Password SDK resolveAll returned neither content nor error for '${options.secretName}' (${options.secretReference}).`,
	);
}

function mapSdkResolveAllResponse(
	refs: Record<string, SecretRef>,
	response: ResolveAllResponse,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(refs).map(([secretName, secretRef]) => [
			secretName,
			readSdkBatchSecret({
				response,
				secretName,
				secretReference: secretRef.ref,
			}),
		]),
	);
}
```

Note: the upstream SDK method accepts `string[]`; the local interface keeps `readonly string[]` so callers cannot mutate inputs. This matches the current local interface style and remains assignable for the SDK client method shape.

- [ ] **Step 4: Use SDK `resolveAll` in `createSecretResolver`**

Replace the SDK-backed `resolveAll` body in `createSecretResolver` with:

```ts
resolveAll: async (refs: Record<string, SecretRef>): Promise<Record<string, string>> => {
	try {
		const response = await client.secrets.resolveAll(
			Object.values(refs).map((secretRef) => secretRef.ref),
		);
		return mapSdkResolveAllResponse(refs, response);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeStderr(
			`[secret-resolver] 1Password SDK resolveAll failed; falling back to serial op CLI reads: ${message}`,
		);
		return await resolveAllSecretsWithOpCli(options.serviceAccountToken, refs, exec);
	}
},
```

Partial-success choice: if any SDK per-entry response is an error or malformed, this code falls back through the existing serial `op` path for the whole requested batch. That trades extra fallback reads for a simple all-or-fallback contract.

- [ ] **Step 5: Add SDK malformed-batch fallback test**

Add this test inside `describe('createSecretResolver', ...)`:

```ts
it('falls back to serial op reads when sdk resolveAll omits a requested ref', async () => {
	const execCalls: Array<{
		readonly args: readonly string[];
		readonly command: string;
		readonly env?: Readonly<Record<string, string | undefined>>;
	}> = [];
	const fakeClient: SecretResolverClient = {
		secrets: {
			resolve: async (secretReference: string): Promise<string> => `single:${secretReference}`,
			resolveAll: async () => ({
				individualResponses: {
					'op://vault/item/a': {
						content: {
							secret: 'sdk-a',
							itemId: 'item-a',
							vaultId: 'vault-id',
						},
					},
				},
			}),
		},
	};
	const secretResolver = await createSecretResolver(
		{ serviceAccountToken: 'service-token' },
		{
			createClient: async (): Promise<SecretResolverClient> => fakeClient,
			execFileAsync: async (command, args, options) => {
				execCalls.push({
					args,
					command,
					...(options?.env ? { env: options.env } : {}),
				});
				return { stdout: `op:${args[1]}\n`, stderr: '' };
			},
		},
	);

	await expect(
		secretResolver.resolveAll({
			A: { source: '1password', ref: 'op://vault/item/a' },
			B: { source: '1password', ref: 'op://vault/item/b' },
		}),
	).resolves.toEqual({
		A: 'op:op://vault/item/a',
		B: 'op:op://vault/item/b',
	});
	expect(execCalls.map((call) => call.args)).toEqual([
		['read', 'op://vault/item/a'],
		['read', 'op://vault/item/b'],
	]);
});
```

- [ ] **Step 6: Keep and strengthen serial `op` fallback coverage**

Keep the existing `createOpCliSecretResolver` test named `resolves all refs sequentially via op read`. Extend it with an in-flight counter so it proves the fallback remains serial:

```ts
let inFlight = 0;
let maxInFlight = 0;
```

Inside the fake `execFileAsync`:

```ts
inFlight += 1;
maxInFlight = Math.max(maxInFlight, inFlight);
try {
	execCalls.push({
		args,
		command,
		...(options?.env ? { env: options.env } : {}),
	});
	return { stdout: `${args[1]}\n`, stderr: '' };
} finally {
	inFlight -= 1;
}
```

After the existing `execCalls` assertion:

```ts
expect(maxInFlight).toBe(1);
```

- [ ] **Step 7: Run SDK resolver tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/gondolin-adapter/src/secret-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/gondolin-adapter/src/secret-resolver.ts packages/gondolin-adapter/src/secret-resolver.test.ts
git commit -m "feat: resolve 1Password secrets with SDK batch API

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Batch Through The Production Composite Resolver

**Files:**
- Modify: `packages/agent-vm/src/controller/composite-secret-resolver.ts`
- Modify: `packages/agent-vm/src/controller/composite-secret-resolver.test.ts`

- [ ] **Step 1: Write the failing mixed-source composite test**

Replace the existing `resolveAll handles mixed secret sources` test in `packages/agent-vm/src/controller/composite-secret-resolver.test.ts` with:

```ts
it('resolveAll resolves env locally and batches onepassword refs through the wrapped resolver', async () => {
	const resolveOnePasswordSecret = vi.fn(async (ref) => `single:${ref.ref}`);
	const resolveAllOnePasswordSecrets = vi.fn(
		async (refs: Record<string, import('@agent-vm/gondolin-adapter').SecretRef>) =>
			Object.fromEntries(
				Object.entries(refs).map(([secretName, secretRef]) => [
					secretName,
					`batch:${secretRef.ref}`,
				]),
			),
	);
	const onePasswordResolver: SecretResolver = {
		resolve: resolveOnePasswordSecret,
		resolveAll: resolveAllOnePasswordSecrets,
	};
	const resolver = createCompositeSecretResolver(onePasswordResolver, {
		GITHUB_TOKEN: 'gh-token',
	});

	await expect(
		resolver.resolveAll({
			OPENAI_API_KEY: { source: '1password', ref: 'op://vault/openai/token' },
			GITHUB_TOKEN: { source: 'environment', ref: 'GITHUB_TOKEN' },
			ANTHROPIC_API_KEY: { source: '1password', ref: 'op://vault/anthropic/token' },
		}),
	).resolves.toEqual({
		OPENAI_API_KEY: 'batch:op://vault/openai/token',
		GITHUB_TOKEN: 'gh-token',
		ANTHROPIC_API_KEY: 'batch:op://vault/anthropic/token',
	});
	expect(resolveOnePasswordSecret).not.toHaveBeenCalled();
	expect(resolveAllOnePasswordSecrets).toHaveBeenCalledTimes(1);
	expect(resolveAllOnePasswordSecrets).toHaveBeenCalledWith({
		OPENAI_API_KEY: { source: '1password', ref: 'op://vault/openai/token' },
		ANTHROPIC_API_KEY: { source: '1password', ref: 'op://vault/anthropic/token' },
	});
});
```

- [ ] **Step 2: Add no-provider batch failure coverage**

Add this test:

```ts
it('throws once when resolveAll includes onepassword refs without a configured provider', async () => {
	const resolver = createCompositeSecretResolver(null, {
		GITHUB_TOKEN: 'gh-token',
	});

	await expect(
		resolver.resolveAll({
			GITHUB_TOKEN: { source: 'environment', ref: 'GITHUB_TOKEN' },
			OPENAI_API_KEY: { source: '1password', ref: 'op://vault/openai/token' },
		}),
	).rejects.toThrow(
		"Secret with source '1password' requires host.secretsProvider to be configured.",
	);
});
```

- [ ] **Step 3: Run the failing composite tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/composite-secret-resolver.test.ts
```

Expected: FAIL because composite `resolveAll(...)` currently loops through `this.resolve(ref)`.

- [ ] **Step 4: Refactor composite `resolveAll` to partition refs**

In `packages/agent-vm/src/controller/composite-secret-resolver.ts`, add this helper above `createCompositeSecretResolver`:

```ts
function resolveEnvironmentSecret(ref: SecretRef, env: NodeJS.ProcessEnv): string {
	const value = env[ref.ref];
	if (value === undefined) {
		throw new Error(`Environment variable '${ref.ref}' is not set.`);
	}
	if (value.trim().length === 0) {
		throw new Error(`Environment variable '${ref.ref}' is set but empty.`);
	}
	return value;
}
```

Replace the environment branch in `resolve(ref)` with:

```ts
return resolveEnvironmentSecret(ref, env);
```

Replace `resolveAll(...)` with:

```ts
async resolveAll(refs: Record<string, SecretRef>): Promise<Record<string, string>> {
	const resolved: Record<string, string> = {};
	const onePasswordRefs: Record<string, Extract<SecretRef, { readonly source: '1password' }>> = {};

	for (const [name, ref] of Object.entries(refs)) {
		switch (ref.source) {
			case 'environment':
				resolved[name] = resolveEnvironmentSecret(ref, env);
				break;
			case '1password':
				onePasswordRefs[name] = ref;
				break;
			default: {
				const exhaustiveCheck: never = ref;
				throw new Error(`Unsupported secret source: ${JSON.stringify(exhaustiveCheck)}`);
			}
		}
	}

	if (Object.keys(onePasswordRefs).length > 0) {
		if (!onePasswordResolver) {
			throw new Error(
				"Secret with source '1password' requires host.secretsProvider to be configured.",
			);
		}
		Object.assign(resolved, await onePasswordResolver.resolveAll(onePasswordRefs));
	}

	return resolved;
},
```

- [ ] **Step 5: Run composite tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/controller/composite-secret-resolver.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/agent-vm/src/controller/composite-secret-resolver.ts packages/agent-vm/src/controller/composite-secret-resolver.test.ts
git commit -m "feat: batch secrets through composite resolver

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Batch Zone Secret Resolution Through `resolveAll`

**Files:**
- Modify: `packages/agent-vm/src/gateway/credential-manager.ts`
- Modify: `packages/agent-vm/src/gateway/credential-manager.test.ts`

- [ ] **Step 1: Rewrite the happy-path unit test to require `resolveAll`**

In `packages/agent-vm/src/gateway/credential-manager.test.ts`, add `vi` to the Vitest import:

```ts
import { describe, expect, it, vi } from 'vitest';
```

Replace the first `resolveZoneSecrets` test with:

```ts
it('resolves the named zone secret references through one resolveAll call', async () => {
	const resolve = vi.fn(async () => {
		throw new Error('resolve should not be called for zone batch resolution');
	});
	const resolveAll = vi.fn(
		async (refs: Record<string, import('@agent-vm/gondolin-adapter').SecretRef>) =>
			Object.fromEntries(
				Object.entries(refs).map(([name, secretRef]) => [
					name,
					`resolved:${secretRef.ref}`,
				]),
			),
	);
	const secretResolver: SecretResolver = {
		resolve,
		resolveAll,
	};

	await expect(
		resolveZoneSecrets({
			audience: 'gateway',
			systemConfig,
			zoneId: 'shravan',
			secretResolver,
		}),
	).resolves.toEqual({
		ANTHROPIC_API_KEY: 'resolved:op://AI/anthropic/api-key',
		GITHUB_PAT: 'resolved:op://AI/github/pat',
	});
	expect(resolve).not.toHaveBeenCalled();
	expect(resolveAll).toHaveBeenCalledTimes(1);
	expect(resolveAll).toHaveBeenCalledWith({
		ANTHROPIC_API_KEY: { source: '1password', ref: 'op://AI/anthropic/api-key' },
		GITHUB_PAT: { source: '1password', ref: 'op://AI/github/pat' },
	});
});
```

- [ ] **Step 2: Update the per-zone refs test**

In `supports per-zone refs for the same secret name`, change the fake resolver to use `resolveAll`:

```ts
const resolve = vi.fn(async () => {
	throw new Error('resolve should not be called for zone batch resolution');
});
const resolveAll = vi.fn(
	async (refs: Record<string, import('@agent-vm/gondolin-adapter').SecretRef>) =>
		Object.fromEntries(
			Object.entries(refs).map(([name, secretRef]) => [name, `resolved:${secretRef.ref}`]),
		),
);
const secretResolver: SecretResolver = { resolve, resolveAll };
```

After the result assertion, add:

```ts
expect(resolve).not.toHaveBeenCalled();
expect(resolveAll).toHaveBeenCalledWith({
	OPENCLAW_GATEWAY_TOKEN: {
		source: '1password',
		ref: 'op://agent-vm/copse-gateway-auth/password',
	},
});
```

- [ ] **Step 3: Preserve per-secret failure detail in the batch error test**

Replace the `adds secret-specific context when secret resolution fails` fake resolver with:

```ts
const secretResolver: SecretResolver = {
	resolve: async () => {
		throw new Error('resolve should not be called');
	},
	resolveAll: async () => {
		throw new AggregateError(
			[
				new Error(
					"Failed to resolve secret 'PERPLEXITY_API_KEY' for zone 'shravan' from 'op://agent-vm/shravan-perplexity/credential': 1Password lookup failed",
				),
			],
			'Failed to resolve 1 secret(s) via op read.',
		);
	},
};
```

Change the assertion to:

```ts
await expect(
	resolveZoneSecrets({
		audience: 'gateway',
		secretResolver,
		systemConfig: failingConfig,
		zoneId: 'shravan',
	}),
).rejects.toThrow(
	"Failed to resolve zone secrets for zone 'shravan': Failed to resolve 1 secret(s) via op read. Details: Failed to resolve secret 'PERPLEXITY_API_KEY' for zone 'shravan' from 'op://agent-vm/shravan-perplexity/credential': 1Password lookup failed",
);
```

- [ ] **Step 4: Run failing credential-manager tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/gateway/credential-manager.test.ts
```

Expected: FAIL because `resolveZoneSecrets(...)` still loops over `resolve(...)`.

- [ ] **Step 5: Add aggregate error rendering helpers**

In `packages/agent-vm/src/gateway/credential-manager.ts`, add these helpers below `findZone(...)`:

```ts
function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatSecretResolutionFailure(zoneId: string, error: unknown): string {
	const message = formatUnknownError(error);
	if (error instanceof AggregateError && error.errors.length > 0) {
		const details = Array.from<unknown>(error.errors).map(formatUnknownError).join('; ');
		return `Failed to resolve zone secrets for zone '${zoneId}': ${message}. Details: ${details}`;
	}
	return `Failed to resolve zone secrets for zone '${zoneId}': ${message}`;
}
```

Use `Array.from<unknown>(...)` rather than an `as` cast so the helper stays inside the repo's TypeScript rules.

- [ ] **Step 6: Refactor `resolveZoneSecrets` to collect refs and resolve once**

In `packages/agent-vm/src/gateway/credential-manager.ts`, replace `const resolvedSecrets: Record<string, string> = {};` and the per-secret resolution block with a `secretRefs` map.

The loop should build refs like this:

```ts
const secretRefs: Record<string, SecretRef> = {};
for (const [secretName, secretConfig] of Object.entries(zone.secrets)) {
	if (!targetsAudience(secretConfig.audience, runtimeAudience)) {
		continue;
	}
	if (options.audience === 'tool-vm' && secretConfig.injection !== 'http-mediation') {
		throw new Error(
			`Tool VM secret '${secretName}' in zone '${zone.id}' must use injection 'http-mediation'.`,
		);
	}
	if (injectionFilter && secretConfig.injection !== injectionFilter) {
		continue;
	}
	switch (secretConfig.source) {
		case 'environment':
			if (!secretConfig.envVar) {
				throw new Error(
					`Zone '${zone.id}' secret '${secretName}' is missing 'envVar'. Add an explicit environment variable name.`,
				);
			}
			secretRefs[secretName] = {
				ref: secretConfig.envVar,
				source: 'environment',
			};
			break;
		case '1password':
			if (!secretConfig.ref) {
				throw new Error(
					`Zone '${zone.id}' secret '${secretName}' is missing 'ref'. Add an explicit 1Password reference such as '${buildSuggestedSecretRef(zone.id, secretName)}'.`,
				);
			}
			secretRefs[secretName] = {
				ref: secretConfig.ref,
				source: '1password',
			};
			break;
		default: {
			const exhaustiveCheck: never = secretConfig;
			throw new Error(
				`Unsupported secret config for '${secretName}': ${JSON.stringify(exhaustiveCheck)}`,
			);
		}
	}
}
```

Then resolve once:

```ts
try {
	return await options.secretResolver.resolveAll(secretRefs);
} catch (error) {
	throw new Error(formatSecretResolutionFailure(zone.id, error), { cause: error });
}
```

- [ ] **Step 7: Run credential-manager tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts packages/agent-vm/src/gateway/credential-manager.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

```bash
git add packages/agent-vm/src/gateway/credential-manager.ts packages/agent-vm/src/gateway/credential-manager.test.ts
git commit -m "feat: batch zone secret resolution

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Add Startup Smoke Coverage Through The Composite Resolver

**Files:**
- Create: `packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

Create `packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { GatewayLifecycle } from '@agent-vm/gateway-interface';
import type { ManagedVm, SecretRef, SecretResolver } from '@agent-vm/gondolin-adapter';
import { describe, expect, it, vi } from 'vitest';

import type { LoadedSystemConfig } from '../config/system-config.js';
import { createSecretResolverFromSystemConfig } from '../controller/controller-runtime-support.js';
import { startGatewayZone } from '../gateway/gateway-zone-orchestrator.js';

function createFakeManagedVm(): ManagedVm {
	return {
		id: 'gateway-secret-resolution-smoke-vm',
		close: async () => {},
		enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
		enableSsh: async () => ({
			command: 'ssh fake',
			host: '127.0.0.1',
			port: 2222,
			privateKeyPath: '/tmp/fake-key',
			user: 'root',
		}),
		exec: async (command: string) => ({
			exitCode: 0,
			stderr: '',
			stdout: command.includes('curl ') ? '200' : '',
		}),
		getVmInstance: () => ({
			close: async () => {},
			exec: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
			enableIngress: async () => ({ host: '127.0.0.1', port: 18791 }),
			enableSsh: async () => ({
				command: 'ssh fake',
				host: '127.0.0.1',
				port: 2222,
				privateKeyPath: '/tmp/fake-key',
				user: 'root',
			}),
			id: 'gateway-secret-resolution-smoke-instance',
			setIngressRoutes: () => {},
		}),
		setIngressRoutes: () => {},
	};
}

describe('smoke: gateway startup secret resolution', () => {
	it('batches gateway startup 1Password refs through the production composite resolver', async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-secret-resolution-smoke-'));
		const stateDir = path.join(tempRoot, 'state');
		const cacheDir = path.join(tempRoot, 'cache');
		const runtimeDir = path.join(tempRoot, 'runtime');
		const buildConfigPath = path.join(tempRoot, 'gateway-build.json');
		const gatewayConfigPath = path.join(tempRoot, 'worker-gateway.json');
		await fs.mkdir(stateDir, { recursive: true });
		await fs.mkdir(cacheDir, { recursive: true });
		await fs.mkdir(runtimeDir, { recursive: true });
		await fs.writeFile(buildConfigPath, '{}');
		await fs.writeFile(gatewayConfigPath, '{}');

		const systemConfig = {
			schemaVersion: 1,
			cacheDir,
			runtimeDir,
			host: {
				controllerPort: 18800,
				projectNamespace: 'claw-tests-a1b2c3d4',
				secretsProvider: {
					type: '1password',
					tokenSource: { type: 'env', envVar: 'OP_SERVICE_ACCOUNT_TOKEN' },
				},
			},
			imageProfiles: {
				gateways: {
					worker: {
						type: 'worker',
						buildConfig: buildConfigPath,
					},
				},
				toolVms: {},
			},
			zones: [
				{
					id: 'secret-smoke',
					gateway: {
						type: 'worker',
						imageProfile: 'worker',
						memory: '1G',
						cpus: 1,
						port: 18791,
						config: gatewayConfigPath,
						stateDir,
					},
					secrets: {
						OPENCLAW_GATEWAY_TOKEN: {
							source: '1password',
							ref: 'op://agent-vm/secret-smoke-gateway/password',
							injection: 'env',
							audience: 'gateway',
						},
						PERPLEXITY_API_KEY: {
							source: '1password',
							ref: 'op://agent-vm/secret-smoke-perplexity/credential',
							injection: 'http-mediation',
							audience: 'gateway',
							hosts: ['api.perplexity.ai'],
						},
					},
					egressHosts: [{ host: 'api.perplexity.ai', audience: 'gateway' }],
					websocketBypass: [],
				},
			],
			tcpPool: { basePort: 19000, size: 4 },
			toolVmProfiles: {},
			systemConfigPath: path.join(tempRoot, 'system.jsonc'),
		} satisfies LoadedSystemConfig;

		const innerResolve = vi.fn(async () => {
			throw new Error('inner resolve should not be used during startup batch resolution');
		});
		const innerResolveAll = vi.fn(async (refs: Record<string, SecretRef>) =>
			Object.fromEntries(Object.keys(refs).map((name) => [name, `resolved:${name}`])),
		);
		const innerResolver: SecretResolver = {
			resolve: innerResolve,
			resolveAll: innerResolveAll,
		};
		const createInnerResolver = vi.fn(
			async ({ serviceAccountToken }: { readonly serviceAccountToken: string }) => {
				expect(serviceAccountToken).toBe('service-token');
				return innerResolver;
			},
		);

		const secretResolver = await createSecretResolverFromSystemConfig(
			systemConfig,
			createInnerResolver,
			async () => 'service-token',
		);

		const lifecycle: GatewayLifecycle = {
			buildProcessSpec: () => ({
				bootstrapCommand: 'true',
				startCommand: 'true',
				healthCheck: { type: 'command', command: 'true' },
				guestListenPort: 18789,
				logPath: '/tmp/gateway.log',
			}),
			buildVmSpec: () => ({
				allowedHosts: [],
				environment: {},
				mediatedSecrets: {},
				rootfsMode: 'memory',
				sessionLabel: 'secret-smoke',
				tcpHosts: {},
				vfsMounts: {},
			}),
			prepareHostState: async () => {},
		};

		await startGatewayZone(
			{
				secretResolver,
				systemConfig,
				zoneId: 'secret-smoke',
			},
			{
				buildImage: async () => ({
					imagePath: path.join(tempRoot, 'image'),
					manifest: {},
				}),
				cleanupOrphanedGatewayIfPresent: async () => {},
				createManagedVm: async () => createFakeManagedVm(),
				loadBuildConfig: async () => ({}),
				loadGatewayLifecycle: () => lifecycle,
				writeGatewayRuntimeRecord: async () => {},
			},
		);

		expect(createInnerResolver).toHaveBeenCalledTimes(1);
		expect(innerResolve).not.toHaveBeenCalled();
		expect(innerResolveAll).toHaveBeenCalledTimes(1);
		expect(innerResolveAll).toHaveBeenCalledWith({
			OPENCLAW_GATEWAY_TOKEN: {
				source: '1password',
				ref: 'op://agent-vm/secret-smoke-gateway/password',
			},
			PERPLEXITY_API_KEY: {
				source: '1password',
				ref: 'op://agent-vm/secret-smoke-perplexity/credential',
			},
		});
	});
});
```

- [ ] **Step 2: Run the smoke test after Tasks 2 and 3**

Run after implementing the composite and gateway batching changes:

```bash
pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit Task 4**

```bash
git add packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts
git commit -m "test: smoke startup secret batching through composite resolver

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Use SDK-First Resolver By Default

**Files:**
- Modify: `packages/agent-vm/src/cli/agent-vm-cli-support.ts`
- Modify: `packages/agent-vm/src/controller/controller-runtime.ts`

- [ ] **Step 1: Change CLI default dependency**

In `packages/agent-vm/src/cli/agent-vm-cli-support.ts`, replace:

```ts
import {
	createOpCliSecretResolver,
	resolveGondolinMinimumZigVersion,
	resolveServiceAccountToken,
} from '@agent-vm/gondolin-adapter';
```

with:

```ts
import {
	createSecretResolver,
	resolveGondolinMinimumZigVersion,
	resolveServiceAccountToken,
} from '@agent-vm/gondolin-adapter';
```

Then change `CliDependencies` and `defaultCliDependencies`:

```ts
readonly createSecretResolver: typeof createSecretResolver;
```

```ts
createSecretResolver,
```

- [ ] **Step 2: Change controller runtime default dependency**

In `packages/agent-vm/src/controller/controller-runtime.ts`, replace:

```ts
import { createOpCliSecretResolver, type ManagedVm } from '@agent-vm/gondolin-adapter';
```

with:

```ts
import {
	createSecretResolver as createOnePasswordSecretResolver,
	type ManagedVm,
} from '@agent-vm/gondolin-adapter';
```

Then replace:

```ts
dependencies.createSecretResolver ?? createOpCliSecretResolver
```

with:

```ts
dependencies.createSecretResolver ?? createOnePasswordSecretResolver
```

- [ ] **Step 3: Verify structurally compatible test mocks**

Do not rewrite mocks unless TypeScript reports a problem. The old and new factories have the same structural signature:

```ts
(options: { readonly serviceAccountToken: string }) => Promise<SecretResolver>
```

Run the affected mock-heavy tests:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts \
  packages/agent-vm/src/cli/backup-commands.test.ts \
  packages/agent-vm/src/cli/ssh-commands.test.ts \
  packages/agent-vm/src/cli/auth-interactive-command.test.ts
```

Expected: PASS, or only narrow type/import updates where the changed default factory type is surfaced.

- [ ] **Step 4: Run focused startup secret tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/gondolin-adapter/src/secret-resolver.test.ts \
  packages/agent-vm/src/controller/composite-secret-resolver.test.ts \
  packages/agent-vm/src/gateway/credential-manager.test.ts
pnpm vitest run --config vitest.smoke.config.ts \
  packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add packages/agent-vm/src/cli/agent-vm-cli-support.ts packages/agent-vm/src/controller/controller-runtime.ts
git commit -m "feat: default controller secrets to SDK resolver

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Final Validation

**Files:**
- No new files.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/gondolin-adapter/src/secret-resolver.test.ts \
  packages/agent-vm/src/controller/composite-secret-resolver.test.ts \
  packages/agent-vm/src/gateway/credential-manager.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run affected CLI/controller tests**

Run:

```bash
pnpm vitest run --config vitest.config.ts \
  packages/agent-vm/src/controller/controller-runtime.test.ts \
  packages/agent-vm/src/cli/agent-vm-entrypoint.test.ts \
  packages/agent-vm/src/cli/backup-commands.test.ts \
  packages/agent-vm/src/cli/ssh-commands.test.ts \
  packages/agent-vm/src/cli/auth-interactive-command.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run startup smoke test**

Run:

```bash
pnpm vitest run --config vitest.smoke.config.ts packages/agent-vm/src/integration-tests/gateway-secret-resolution.smoke.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run full unit suite**

Run:

```bash
pnpm test:unit
```

Expected: PASS.

- [ ] **Step 5: Run quality gate**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 6: Run full smoke suite if the machine has required VM tooling**

Run:

```bash
pnpm test:smoke
```

Expected: PASS, or explicit environment skips from existing smoke gating only. Report the test count, skip count, and exit code.

- [ ] **Step 7: Commit validation-only doc/test adjustments if needed**

Only commit if validation required narrow test/doc tweaks:

```bash
git add <changed-files>
git commit -m "test: validate SDK secret startup path

Co-authored-by: Codex <noreply@openai.com>"
```

## Self-Review

Spec coverage:

- SDK batch resolution: Task 1.
- Production composite batching: Task 2.
- Gateway startup calls `resolveAll(...)` once for selected zone secrets: Task 3.
- Smoke proof through `createSecretResolverFromSystemConfig(...)` and `startGatewayZone(...)`: Task 4.
- SDK-first default resolver in CLI/controller startup: Task 5.
- Full verification ladder: Task 6.

Placeholder scan:

- No `TBD`, empty "write tests", or references to nonexistent helper functions.
- Every code-changing task includes concrete snippets and exact commands.

Type consistency:

- `SecretResolver.resolveAll(refs: Record<string, SecretRef>)` remains the internal contract.
- SDK mapping uses `ResolveAllResponse` and `ResolveReferenceError` from `@1password/sdk`.
- Composite batching uses `Extract<SecretRef, { readonly source: '1password' }>` instead of unsafe indexed casts.
- Gateway startup continues to receive a `SecretResolver` and does not know whether the wrapped resolver used SDK or serial `op` fallback.

Regression checks addressed:

- The plan now touches `composite-secret-resolver.ts`, the real production resolver wrapper.
- The smoke no longer injects a hand-built final resolver; it builds the composite through `createSecretResolverFromSystemConfig(...)`.
- The `op` CLI fallback remains serial.
- Gateway errors render aggregate child details so common single-secret failures still show secret name, zone, source ref, and inner failure.
- Mock-heavy CLI/controller tests are listed explicitly because changing the default factory type has broad test surface even though the signature is structurally compatible.
