# Environment-Based Secret Injection for Kubernetes

## Problem

agent-vm runs in two environments:

1. **Developer Mac** — secrets come from 1Password. The developer has `op` CLI installed, a service account token, and vault access. The controller calls `op read op://vault/item/key` to resolve secrets.

2. **Kubernetes** — secrets come from k8s Secrets (populated by SSM, Vault, or manual creation). The pod gets `OPENAI_API_KEY=sk-...` injected as an env var via `envFrom`. There is no 1Password CLI in the pod and no vault access.

The controller currently only supports path (1). Every zone secret has `source: "1password"` with an `op://` ref. This blocks k8s deployment because:
- The 1Password service account requires network access to 1Password servers
- Installing the `op` CLI in every pod image adds complexity and attack surface
- Most k8s clusters already have secret injection pipelines (ExternalSecrets, Vault, SSM) that deliver secrets as env vars — forcing 1Password on top of that is redundant

## Design

Three changes, all in the secret schema:

### 1. Zone secrets become a discriminated union on `source`

**Current schema** (single source, `injection` defaults to `env`):

```typescript
// system-config.ts — current
const secretReferenceSchema = z.object({
  source: z.literal('1password'),
  ref: z.string().min(1),
  injection: z.enum(['env', 'http-mediation']).default('env'),
  hosts: z.array(z.string().min(1)).optional(),
});
```

**New schema** (two sources, `injection` defaults to `http-mediation`, `hosts` required for mediation):

```typescript
// system-config.ts — new
const onePasswordSecretSchema = z.object({
  source: z.literal('1password')
    .describe('Resolve via 1Password. Requires host.secretsProvider to be configured.'),
  ref: z.string().min(1)
    .describe('1Password item path, e.g. op://vault/item/field.'),
  injection: z.enum(['env', 'http-mediation']).default('http-mediation')
    .describe('How the secret reaches the VM. env: set as a VM environment variable. http-mediation: Gondolin proxy injects the value at the network layer — the secret never enters the VM.'),
  hosts: z.array(z.string().min(1)).optional()
    .describe('Hosts that receive the injected secret via http-mediation.'),
});

const environmentSecretSchema = z.object({
  source: z.literal('environment')
    .describe('Read directly from the controller process environment. No external calls.'),
  envVar: z.string().min(1)
    .describe('Name of the environment variable to read, e.g. OPENAI_API_KEY.'),
  injection: z.enum(['env', 'http-mediation']).default('http-mediation')
    .describe('How the secret reaches the VM. env: set as a VM environment variable. http-mediation: Gondolin proxy injects the value at the network layer — the secret never enters the VM.'),
  hosts: z.array(z.string().min(1)).optional()
    .describe('Hosts that receive the injected secret via http-mediation.'),
});

const secretReferenceSchema = z.discriminatedUnion('source', [
  onePasswordSecretSchema,
  environmentSecretSchema,
]).superRefine((secret, ctx) => {
  if (secret.injection === 'http-mediation' && (!secret.hosts || secret.hosts.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Injection 'http-mediation' requires at least one host.",
      path: ['hosts'],
    });
  }
});
```

Key changes:
- **`source` is a discriminated union**: `'1password'` (with `ref`) or `'environment'` (with `envVar`)
- **`injection` default flips from `'env'` to `'http-mediation'`** — the safe default where secrets never enter the VM
- **`hosts` required when `injection: 'http-mediation'`** — enforced via `.superRefine()`, catches config mistakes at parse time

### 2. Host config shape — `secretsProvider` becomes optional

The host schema stays 1Password-only for the provider. It does not gain a new provider type — environment secrets resolve inline in the credential manager, not through a global provider.

```typescript
// system-config.ts — host schema (explicit shape)
host: z.object({
  controllerPort: z.number().int().positive(),
  projectNamespace: z.string().min(1).regex(
    /^[a-z0-9][a-z0-9-]*$/u,
    'projectNamespace must use lowercase letters, numbers, and hyphens only',
  ),
  secretsProvider: z.object({
    type: z.literal('1password'),
    tokenSource: tokenSourceSchema,
  }).optional()
    .describe('1Password provider config. Required when any zone secret uses source "1password". Absent when all secrets use source "environment".'),
}),
```

Cross-field validation in the existing `.superRefine()`:

```typescript
const hasOnePasswordSecrets = config.zones.some((zone) =>
  Object.values(zone.secrets).some((secret) => secret.source === '1password'),
);
if (hasOnePasswordSecrets && !config.host.secretsProvider) {
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: "host.secretsProvider is required when any zone secret uses source '1password'.",
    path: ['host', 'secretsProvider'],
  });
}
```

### 3. `SecretRef` in gondolin-core — discriminated union

`SecretRef` widens to a discriminated union on `source`. This is a type-only change in gondolin-core — no new logic, just a wider contract:

```typescript
// packages/gondolin-core/src/types.ts
export type SecretRef =
  | { readonly source: '1password'; readonly ref: string }
  | { readonly source: 'environment'; readonly ref: string };
```

For `source: 'environment'`, `ref` is the env var name (mapped from `envVar` in the zone config by the credential manager when building the `SecretRef`).

The `SecretResolver` interface is unchanged — it already accepts `SecretRef` and returns `Promise<string>`. The dispatch on `source` happens inside the resolver implementation, not in the interface.

### 4. Composite secret resolver

A single resolver that handles both sources. Lives in agent-vm (not gondolin-core). The 1Password resolver is optional — only created when `secretsProvider` is configured.

```typescript
// packages/agent-vm/src/controller/composite-secret-resolver.ts

import type { SecretRef, SecretResolver } from '@shravansunder/agent-vm-gondolin-core';

export function createCompositeSecretResolver(
  onePasswordResolver: SecretResolver | null,
): SecretResolver {
  return {
    async resolve(ref: SecretRef): Promise<string> {
      if (ref.source === 'environment') {
        const value = process.env[ref.ref];
        if (!value) {
          throw new Error(`Environment variable '${ref.ref}' is not set.`);
        }
        return value;
      }

      if (!onePasswordResolver) {
        throw new Error(
          `Secret with source '1password' requires host.secretsProvider to be configured.`,
        );
      }
      return await onePasswordResolver.resolve(ref);
    },

    async resolveAll(refs: Record<string, SecretRef>): Promise<Record<string, string>> {
      const resolved: Record<string, string> = {};
      for (const [name, ref] of Object.entries(refs)) {
        // Sequential resolution gives exact per-secret error context.
        // oxlint-disable-next-line eslint/no-await-in-loop
        resolved[name] = await this.resolve(ref);
      }
      return resolved;
    },
  };
}
```

### 5. Controller runtime support — build the composite resolver

Rename `createSecretResolverFromSystemConfig` → `createSecretResolver`. It builds the composite:

```typescript
// controller-runtime-support.ts

export async function createSecretResolver(
  systemConfig: SystemConfig,
  createOnePasswordResolverImpl: ...,
  resolveTokenImpl: typeof resolveServiceAccountToken = resolveServiceAccountToken,
): Promise<SecretResolver> {
  let onePasswordResolver: SecretResolver | null = null;

  if (systemConfig.host.secretsProvider) {
    const serviceAccountToken = await resolveTokenImpl(
      systemConfig.host.secretsProvider.tokenSource,
    );
    onePasswordResolver = await createOnePasswordResolverImpl({ serviceAccountToken });
  }

  return createCompositeSecretResolver(onePasswordResolver);
}
```

The controller gets a single `SecretResolver` that handles everything. No optional parameters, no dispatch in the credential manager, no special-casing anywhere downstream.

### 6. Credential manager — no dispatch logic needed

`resolveZoneSecrets` stays simple. It builds `SecretRef` from the zone config and calls `resolver.resolve()`. The composite resolver handles the dispatch internally:

```typescript
// credential-manager.ts — resolveZoneSecrets

for (const [secretName, secretConfig] of Object.entries(zone.secrets)) {
  const secretRef: SecretRef = secretConfig.source === 'environment'
    ? { source: 'environment', ref: secretConfig.envVar }
    : { source: '1password', ref: secretConfig.ref };

  resolvedSecrets[secretName] = await options.secretResolver.resolve(secretRef);
}
```

The only change: building the `SecretRef` maps `envVar` → `ref` for environment secrets.

### 7. `prepareHostState` — signature unchanged

This was the key gap in the earlier spec. `prepareHostState(zone, secretResolver)` works as-is because the composite resolver handles both sources. OpenClaw lifecycle calls `secretResolver.resolve(...)` for the gateway token — if the token is `source: "environment"`, the composite resolver reads `process.env`. No special-casing in the lifecycle.

### 6. `GatewayZoneConfig` in gateway-interface

The `GatewayZoneConfig.secrets` type needs to match the new discriminated union:

```typescript
// gateway-interface/src/gateway-lifecycle.ts
readonly secrets: Record<
  string,
  | {
      readonly source: '1password';
      readonly ref: string;
      readonly injection: 'env' | 'http-mediation';
      readonly hosts?: readonly string[] | undefined;
    }
  | {
      readonly source: 'environment';
      readonly envVar: string;
      readonly injection: 'env' | 'http-mediation';
      readonly hosts?: readonly string[] | undefined;
    }
>;
```

Note: lifecycles never read `source`, `ref`, or `envVar` — they only use `injection` and `hosts` via `splitResolvedGatewaySecrets`. The discriminated union in the type is for consistency with the Zod schema, not for lifecycle consumption.

## Config Examples

### Developer Mac (1Password)

```json
{
  "host": {
    "controllerPort": 18800,
    "projectNamespace": "agent-vm-a1b2c3d4",
    "secretsProvider": {
      "type": "1password",
      "tokenSource": { "type": "keychain", "service": "agent-vm", "account": "1p-service-account" }
    }
  },
  "zones": [{
    "id": "shravan",
    "secrets": {
      "OPENAI_API_KEY": {
        "source": "1password",
        "ref": "op://agent-vm/shravan-openai/credential",
        "hosts": ["api.openai.com"]
      },
      "DISCORD_BOT_TOKEN": {
        "source": "1password",
        "ref": "op://agent-vm/shravan-discord/bot-token",
        "injection": "env"
      }
    }
  }]
}
```

Note: `OPENAI_API_KEY` has no `injection` — defaults to `http-mediation`. `DISCORD_BOT_TOKEN` explicitly uses `injection: "env"` because WebSocket connections can't be mediated.

### Kubernetes (environment)

```json
{
  "host": {
    "controllerPort": 18800,
    "projectNamespace": "agent-vm-k8s"
  },
  "zones": [{
    "id": "coding-agent",
    "secrets": {
      "OPENAI_API_KEY": {
        "source": "environment",
        "envVar": "OPENAI_API_KEY",
        "hosts": ["api.openai.com"]
      },
      "GITHUB_TOKEN": {
        "source": "environment",
        "envVar": "GITHUB_TOKEN",
        "injection": "env"
      }
    }
  }]
}
```

No `secretsProvider` in host — not needed when all secrets use `source: "environment"`.

### Mixed (some from 1Password, some from env)

```json
{
  "host": {
    "controllerPort": 18800,
    "projectNamespace": "agent-vm-mixed",
    "secretsProvider": {
      "type": "1password",
      "tokenSource": { "type": "env", "envVar": "OP_SERVICE_ACCOUNT_TOKEN" }
    }
  },
  "zones": [{
    "id": "hybrid",
    "secrets": {
      "OPENAI_API_KEY": {
        "source": "1password",
        "ref": "op://agent-vm/openai/credential",
        "hosts": ["api.openai.com"]
      },
      "MONITORING_TOKEN": {
        "source": "environment",
        "envVar": "MONITORING_TOKEN",
        "hosts": ["api.monitoring.internal"]
      }
    }
  }]
}
```

## How It Flows in k8s

```
k8s Secret (created by ExternalSecrets, Vault, SSM, or manually):
  OPENAI_API_KEY: sk-...
  GITHUB_TOKEN: ghp-...
       |
       v
Pod spec: envFrom: [{ secretRef: { name: "agent-vm-secrets" } }]
       |
       v
Pod env: OPENAI_API_KEY=sk-..., GITHUB_TOKEN=ghp-...
       |
       v
Controller starts, reads system.json:
  No secretsProvider (all secrets are source: "environment")
       |
       v
resolveZoneSecrets():
  OPENAI_API_KEY -> source: "environment", envVar: "OPENAI_API_KEY"
                 -> process.env["OPENAI_API_KEY"] -> "sk-..."
  GITHUB_TOKEN   -> source: "environment", envVar: "GITHUB_TOKEN"
                 -> process.env["GITHUB_TOKEN"] -> "ghp-..."
       |
       v
Resolved values passed to Gondolin VM:
  injection: "http-mediation" -> Gondolin proxy replaces placeholders at network layer
  injection: "env"            -> VM env vars (for WebSocket / non-HTTP use)
```

## Comparison: Mac vs k8s

| | Developer Mac | Kubernetes |
|---|---|---|
| `host.secretsProvider` | Required (1Password token) | Absent (not needed) |
| `source` | `"1password"` | `"environment"` |
| Secret identifier | `ref: "op://vault/item/key"` | `envVar: "OPENAI_API_KEY"` |
| External dependency | 1Password CLI + service account | None (secrets already in env) |
| Network calls to resolve | Yes (1Password API) | No |
| Default `injection` | `"http-mediation"` | `"http-mediation"` |

## Breaking Changes

Hard cutover. No backward compatibility, no migration shims, no deprecation.

1. **`injection` default changes from `"env"` to `"http-mediation"`** — existing configs that rely on the default must add explicit `injection: "env"` for secrets that need VM-level env injection (WebSocket tokens, etc.)
2. **`hosts` required for `http-mediation`** — existing configs using `http-mediation` without `hosts` will fail validation
3. **`host.secretsProvider` becomes optional** — no action needed, existing configs with it still work
4. **`source: "1password"` remains valid** — no changes needed for existing 1Password secrets
5. **`createSecretResolverFromSystemConfig` renamed** to `createSecretResolver` — now returns a composite resolver. Callers update in the same changeset.
6. **`SecretRef` in gondolin-core widens** — `source` becomes `'1password' | 'environment'`. Type-only change, no new logic in gondolin-core.

All breaking changes fail at config parse time with clear Zod error messages. No silent behavior changes.

## Files to Change

| File | Change |
|------|--------|
| `packages/gondolin-core/src/types.ts` | Widen `SecretRef` to discriminated union: `source: '1password'` or `source: 'environment'` |
| `packages/agent-vm/src/config/system-config.ts` | Discriminated union on `source`, flip `injection` default, `hosts` required for mediation, `secretsProvider` optional with cross-field validation |
| `packages/agent-vm/src/controller/composite-secret-resolver.ts` | **New.** Composite resolver dispatching on `SecretRef.source` (~40 lines) |
| `packages/agent-vm/src/controller/controller-runtime-support.ts` | Rename `createSecretResolverFromSystemConfig` → `createSecretResolver`, build composite (1Password optional + env) |
| `packages/agent-vm/src/controller/controller-runtime.ts` | No change — receives a `SecretResolver` as before |
| `packages/agent-vm/src/gateway/credential-manager.ts` | Build `SecretRef` from zone config (map `envVar` → `ref` for environment). No dispatch logic — resolver handles it. |
| `packages/gateway-interface/src/gateway-lifecycle.ts` | Update `GatewayZoneConfig.secrets` type to match discriminated union. `prepareHostState` signature unchanged. |
| `packages/gateway-interface/src/split-resolved-gateway-secrets.ts` | No logic change — reads `injection` and `hosts` only. Type update flows from `GatewayZoneConfig`. |
| `packages/openclaw-gateway/src/openclaw-lifecycle.ts` | No logic change — calls `secretResolver.resolve()` as before. Works because composite resolver handles both sources. |
| `packages/agent-vm/src/cli/init-command.ts` | Update scaffolding to use new default (`http-mediation`) and new schema shape |
| Config files (per deployment) | Update to new schema |
| Tests | Update to match new defaults, discriminated union, and composite resolver |

**No changes to:** worker-gateway, agent-vm-worker, docker-service-routing.
**Minimal changes to:** gondolin-core (type-only), openclaw-gateway (type flows, no logic), gateway-interface (type flows, no logic).

## Testing

- Unit: `secretReferenceSchema` validates both source variants, rejects `http-mediation` without `hosts`
- Unit: `createCompositeSecretResolver` resolves `source: 'environment'` from `process.env`
- Unit: `createCompositeSecretResolver` routes `source: '1password'` to 1Password resolver
- Unit: `createCompositeSecretResolver` throws when 1Password secret requested but no provider configured
- Unit: `resolveZoneSecrets` with mixed sources in one zone (both flow through same resolver)
- Unit: config rejects missing `secretsProvider` when 1Password secrets exist
- Unit: config accepts absent `secretsProvider` when all secrets are environment
- Unit: `prepareHostState` works with environment-sourced gateway token (composite resolver handles it)
- Integration: controller starts with all-environment secrets, resolves from `process.env`, boots VM
