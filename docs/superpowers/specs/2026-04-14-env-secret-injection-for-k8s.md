# .env Secret Injection for Kubernetes Deployment

## Problem

The agent-vm controller currently resolves ALL secrets through 1Password. There is no bypass. The resolution chain is:

```
controller-runtime.ts
  → createSecretResolverFromSystemConfig()           (controller-runtime-support.ts:6)
    → resolveServiceAccountToken(tokenSource)         reads OP_SERVICE_ACCOUNT_TOKEN from env
    → createOpCliSecretResolver({ serviceAccountToken })  creates 1Password resolver

resolveZoneSecrets()                                  (credential-manager.ts:12)
  → for each secret in zone.secrets:
      ref = secretConfig.ref ?? process.env[`${SECRET_NAME}_REF`]
      if (!ref) throw Error("no ref and no _REF env var")
  → secretResolver.resolveAll(resolvedRefs)           calls 1Password API
```

For k8s deployment, we want to support injecting secrets directly as environment variables — no 1Password dependency. The pod gets secrets from a k8s Secret via `envFrom`, and the controller reads them from `process.env` without calling any external service.

## What Needs to Change

### 1. Add an `env` secret provider type

Currently `system-config.ts` only accepts `secretsProvider.type: "1password"`. Add `"env"` as an alternative:

```typescript
// packages/agent-vm/src/config/system-config.ts

const secretsProviderSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('1password'),
    tokenSource: tokenSourceSchema,
  }),
  z.object({
    type: z.literal('env'),
    // No tokenSource needed — secrets come directly from process.env
  }),
]);
```

### 2. Create an env-based SecretResolver

The `SecretResolver` interface from gondolin-core has two methods:

```typescript
interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
  resolveAll(refs: Record<string, SecretRef>): Promise<Record<string, string>>;
}
```

Create an env-based implementation that reads from `process.env`:

```typescript
// packages/agent-vm/src/controller/env-secret-resolver.ts

import type { SecretResolver } from '@shravansunder/gondolin-core';

export function createEnvSecretResolver(): SecretResolver {
  return {
    async resolve(ref) {
      // ref.ref is the env var name (e.g., "OPENAI_API_KEY")
      const value = process.env[ref.ref];
      if (!value) {
        throw new Error(`Environment variable '${ref.ref}' is not set.`);
      }
      return value;
    },
    async resolveAll(refs) {
      const resolved: Record<string, string> = {};
      for (const [name, ref] of Object.entries(refs)) {
        const value = process.env[ref.ref];
        if (!value) {
          throw new Error(`Environment variable '${ref.ref}' is not set.`);
        }
        resolved[name] = value;
      }
      return resolved;
    },
  };
}
```

### 3. Update createSecretResolverFromSystemConfig

Dispatch on `secretsProvider.type`:

```typescript
// packages/agent-vm/src/controller/controller-runtime-support.ts

export async function createSecretResolverFromSystemConfig(
  systemConfig: SystemConfig,
  createOpCliResolver: ...,
): Promise<SecretResolver> {
  if (systemConfig.host.secretsProvider.type === 'env') {
    return createEnvSecretResolver();
  }

  // Existing 1Password path
  const serviceAccountToken = await resolveServiceAccountToken(
    systemConfig.host.secretsProvider.tokenSource,
  );
  return await createOpCliResolver({ serviceAccountToken });
}
```

### 4. Update credential-manager.ts to support env-based refs

Currently `resolveZoneSecrets` expects `ref` to be an `op://` path. For env-based injection, `ref` is the environment variable name:

```typescript
// credential-manager.ts — no change needed if ref convention changes

// For 1Password: ref = "op://agent-vm/openai/api-key"  → 1Password resolves it
// For env:       ref = "OPENAI_API_KEY"                 → env resolver reads process.env["OPENAI_API_KEY"]
```

The `ref` field does double duty — it's an `op://` path for 1Password or an env var name for the env provider. The resolver implementation decides how to interpret it.

### 5. system.json for k8s (env-based)

```json
{
  "host": {
    "controllerPort": 18800,
    "secretsProvider": {
      "type": "env"
    }
  },
  "zones": [
    {
      "id": "coding-agent",
      "gateway": {
        "type": "coding",
        ...
      },
      "secrets": {
        "OPENAI_API_KEY": {
          "source": "1password",
          "ref": "OPENAI_API_KEY",
          "injection": "env"
        },
        "GITHUB_TOKEN": {
          "source": "1password",
          "ref": "GITHUB_TOKEN",
          "injection": "env"
        }
      },
      ...
    }
  ]
}
```

Note: `source: "1password"` in the zone secrets schema is a Zod literal — it's always `"1password"` regardless of the provider type. The `ref` value changes meaning: for 1Password it's an `op://` path, for env it's the env var name. This is slightly confusing but avoids a schema change to the zone secrets.

**Alternative (cleaner):** Change the zone secret schema to also accept `source: "env"`:

```typescript
const secretReferenceSchema = z.object({
  source: z.enum(['1password', 'env']),
  ref: z.string().min(1).optional(),
  injection: z.enum(['env', 'http-mediation']).default('env'),
  hosts: z.array(z.string().min(1)).optional(),
});
```

Then for env-based secrets, the zone config looks cleaner:

```json
"secrets": {
  "OPENAI_API_KEY": {
    "source": "env",
    "ref": "OPENAI_API_KEY",
    "injection": "env"
  }
}
```

And the credential manager can skip resolution for `source: "env"` secrets — just read directly from `process.env[ref]`.

## How It Flows in k8s

```
k8s Secret (agent-vm-secrets):
  OPENAI_API_KEY: sk-...
  GITHUB_TOKEN: ghp-...
       ↓
Pod spec envFrom: [{ secretRef: { name: "agent-vm-secrets" } }]
       ↓
Sysbox Pod env:
  OPENAI_API_KEY=sk-...
  GITHUB_TOKEN=ghp-...
       ↓
Controller reads system.json:
  secretsProvider.type: "env"
  → creates env-based SecretResolver
       ↓
resolveZoneSecrets():
  OPENAI_API_KEY ref="OPENAI_API_KEY" → process.env["OPENAI_API_KEY"] → "sk-..."
  GITHUB_TOKEN ref="GITHUB_TOKEN" → process.env["GITHUB_TOKEN"] → "ghp-..."
       ↓
Resolved values passed to Gondolin VM:
  injection: "env" → VM env vars
  injection: "http-mediation" → Gondolin MITM proxy replaces placeholders
```

## Files to Change

| File | Change |
|------|--------|
| `packages/agent-vm/src/config/system-config.ts` | Add `"env"` to secretsProvider discriminated union |
| `packages/agent-vm/src/controller/env-secret-resolver.ts` | **New.** Env-based SecretResolver implementation |
| `packages/agent-vm/src/controller/controller-runtime-support.ts` | Dispatch on provider type (env vs 1password) |
| `packages/agent-vm/src/gateway/credential-manager.ts` | Optional: skip resolution for `source: "env"` secrets |
| `relay-background-agent/config/system.json` | Use `secretsProvider.type: "env"`, secret refs are env var names |

## Scope

This is a small, focused change:
- ~30 lines new code (env-secret-resolver.ts)
- ~10 lines schema change (system-config.ts)
- ~5 lines dispatch change (controller-runtime-support.ts)
- Config file updates

No changes to: Gondolin, gateway-interface, worker-gateway, agent-vm-worker, delegator.

## Testing

- Unit test: `createEnvSecretResolver` with mocked `process.env`
- Unit test: `createSecretResolverFromSystemConfig` dispatches correctly
- Integration test: controller starts with `type: "env"`, resolves secrets from env
- E2E: delegator creates pod with k8s Secret → controller resolves → worker runs
