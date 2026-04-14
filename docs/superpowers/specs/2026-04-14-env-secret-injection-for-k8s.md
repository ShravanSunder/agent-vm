# Environment-Based Secret Injection for Kubernetes

## Why This Matters

agent-vm runs in two environments:

1. **Developer Mac** — secrets come from 1Password. The developer has `op` CLI installed, a service account token, and vault access. The controller calls `op read op://vault/item/key` to resolve secrets.

2. **Kubernetes** — secrets come from k8s Secrets (populated by SSM, Vault, or manual creation). The pod gets `OPENAI_API_KEY=sk-...` injected as an env var via `envFrom`. There is no 1Password CLI in the pod and no vault access.

The controller currently only supports path (1). Every deployment must have 1Password available. This blocks k8s deployment because:
- The 1Password service account requires network access to 1Password servers
- Installing the `op` CLI in every pod image adds complexity and attack surface
- Many k8s clusters already have secret injection pipelines (ExternalSecrets, Vault, SSM) that deliver secrets as env vars — forcing 1Password on top of that is redundant

We need a second secret provider: `"env"` — read secrets directly from `process.env`. No external calls, no CLI tools, no vault access.

## How Secrets Flow Today (1Password Only)

```
system.json:
  host.secretsProvider.type: "1password"
  host.secretsProvider.tokenSource: { type: "env", envVar: "OP_SERVICE_ACCOUNT_TOKEN" }

  zone.secrets:
    OPENAI_API_KEY: { source: "1password", ref: "op://agent-vm/openai/api-key", injection: "env" }

Controller startup:
  1. Read OP_SERVICE_ACCOUNT_TOKEN from process.env
  2. Create 1Password resolver (calls op CLI or 1P Connect API)
  3. For each zone secret: resolver.resolve({ ref: "op://agent-vm/openai/api-key" }) → "sk-..."
  4. Pass resolved value to Gondolin VM as env var (injection: "env")
     or as HTTP mediation secret (injection: "http-mediation")
```

The resolution always goes through 1Password. There is no bypass path in the current code.

**Relevant code:**
- `controller-runtime-support.ts:6-18` — always creates 1Password resolver from `tokenSource`
- `credential-manager.ts:12-37` — resolves each secret via `secretResolver.resolveAll()`, requires `ref` (op:// path) or `${SECRET_NAME}_REF` env var

## What Changes

### 1. Add `"env"` to the secretsProvider discriminated union

```typescript
// packages/agent-vm/src/config/system-config.ts

const secretsProviderSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('1password'),
    tokenSource: tokenSourceSchema,
  }),
  z.object({
    type: z.literal('env'),
    // No tokenSource — secrets come directly from process.env
  }),
]);
```

### 2. Create an env-based SecretResolver

The `SecretResolver` interface (from gondolin-core) is:

```typescript
interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
  resolveAll(refs: Record<string, SecretRef>): Promise<Record<string, string>>;
}
```

The env implementation reads from `process.env` using `ref` as the env var name:

```typescript
// packages/agent-vm/src/controller/env-secret-resolver.ts

import type { SecretResolver } from '@shravansunder/gondolin-core';

export function createEnvSecretResolver(): SecretResolver {
  return {
    async resolve(ref) {
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

### 3. Dispatch on provider type in controller-runtime-support.ts

```typescript
// packages/agent-vm/src/controller/controller-runtime-support.ts

import { createEnvSecretResolver } from './env-secret-resolver.js';

export async function createSecretResolverFromSystemConfig(
  systemConfig: SystemConfig,
  createOpCliResolver: ...,
): Promise<SecretResolver> {
  if (systemConfig.host.secretsProvider.type === 'env') {
    return createEnvSecretResolver();
  }

  // Existing 1Password path — unchanged
  const serviceAccountToken = await resolveServiceAccountToken(
    systemConfig.host.secretsProvider.tokenSource,
  );
  return await createOpCliResolver({ serviceAccountToken });
}
```

### 4. Credential manager — no change needed

`credential-manager.ts` already has a fallback: `ref = secretConfig.ref ?? process.env[${SECRET_NAME}_REF]`. For the env provider, zone secrets use `ref: "OPENAI_API_KEY"` (the env var name). The env resolver reads `process.env["OPENAI_API_KEY"]` and returns the value. The credential manager doesn't need to know which resolver is in use.

## system.json for k8s

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
      "gateway": { ... },
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

Note: `source: "1password"` is a Zod literal in the zone secrets schema — it doesn't change. It means "this secret was originally sourced from a secrets provider" not "use 1Password to resolve it." The `ref` value changes meaning based on `secretsProvider.type`:
- `type: "1password"` → `ref` is an `op://vault/item/field` path
- `type: "env"` → `ref` is the env var name

## How It Flows in k8s

```
k8s Secret (created by ExternalSecrets, Vault, SSM, or manually):
  OPENAI_API_KEY: sk-...
  GITHUB_TOKEN: ghp-...
       ↓
Pod spec: envFrom: [{ secretRef: { name: "agent-vm-secrets" } }]
       ↓
Pod env: OPENAI_API_KEY=sk-..., GITHUB_TOKEN=ghp-...
       ↓
Controller starts, reads system.json:
  secretsProvider.type: "env" → creates env-based SecretResolver
       ↓
resolveZoneSecrets():
  OPENAI_API_KEY → ref="OPENAI_API_KEY" → process.env["OPENAI_API_KEY"] → "sk-..."
  GITHUB_TOKEN → ref="GITHUB_TOKEN" → process.env["GITHUB_TOKEN"] → "ghp-..."
       ↓
Resolved values passed to Gondolin VM:
  injection: "env" → VM env vars (agent uses them for API calls)
  injection: "http-mediation" → Gondolin MITM proxy replaces placeholders at network layer
```

## Comparison: Mac vs k8s

| | Developer Mac | Kubernetes |
|---|---|---|
| `secretsProvider.type` | `"1password"` | `"env"` |
| Secret source | 1Password vault | k8s Secret (from SSM/Vault/manual) |
| `ref` format | `op://vault/item/key` | env var name (`OPENAI_API_KEY`) |
| External dependency | 1Password CLI + service account | None (secrets already in env) |
| Network calls | Yes (1Password API) | No |

## Files to Change

| File | Change |
|------|--------|
| `packages/agent-vm/src/config/system-config.ts` | Add `"env"` to secretsProvider discriminated union |
| `packages/agent-vm/src/controller/env-secret-resolver.ts` | **New.** Env-based SecretResolver implementation (~30 lines) |
| `packages/agent-vm/src/controller/controller-runtime-support.ts` | Dispatch on provider type (~5 lines) |
| Config files (per deployment) | Use `secretsProvider.type: "env"`, refs are env var names |

No changes to: gondolin-core, gateway-interface, worker-gateway, agent-vm-worker, credential-manager.

## Testing

- Unit test: `createEnvSecretResolver` with mocked `process.env`
- Unit test: `createSecretResolverFromSystemConfig` dispatches correctly for `"env"` vs `"1password"`
- Integration test: controller starts with `type: "env"`, resolves secrets from env, boots VM
