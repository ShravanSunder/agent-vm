# Secrets and Credentials

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Secrets and Credentials

This document describes how the agent-vm system resolves, classifies, and
delivers secrets to Gondolin VMs and host-side controller operations.

---

## Core Types

Two discriminated unions drive the entire pipeline:

```
SecretRef (gondolin-adapter/types.ts)
  | { source: '1password'; ref: string }     -- op:// URI
  | { source: 'environment'; ref: string }    -- process.env key

SecretSpec (gondolin-adapter/types.ts)
  { hosts: readonly string[]; value: string } -- resolved value bound to hosts
```

`SecretRef` identifies *where* a secret lives. `SecretSpec` carries a resolved
plaintext value together with the hosts it should be injected into.

---

## Secret Sources

| Source | Backing Store | When Used |
|--------|--------------|-----------|
| 1Password SDK | `@1password/sdk` `createClient` | Primary path for `source: '1password'` refs |
| op-cli fallback | `op read <ref>` subprocess | Automatic fallback when SDK fails (per-secret) |
| Environment variable | `process.env[key]` | `source: 'environment'` refs |
| macOS Keychain | `security find-generic-password` | Token storage only (service account token) |

The SDK is preferred because it resolves secrets in-process without spawning
subprocesses. When the SDK throws on a specific secret, the resolver logs to
stderr and retries that single secret via `op read` with the service account
token injected into the subprocess environment. If SDK client creation itself
fails, the entire resolver falls back to op-cli for all operations.

---

## Token Source Resolution

Before any 1Password secret can be resolved, the system needs a service account
token. `resolveServiceAccountToken` (gondolin-adapter/secret-resolver.ts) supports
three sources, selected by `host.secretsProvider.tokenSource` in the system
config:

```
TokenSource
  | { type: 'op-cli';    ref: string }                          -- op read <ref> (biometric)
  | { type: 'env';       envVar?: string }                      -- process.env (default: OP_SERVICE_ACCOUNT_TOKEN)
  | { type: 'keychain';  service: string; account: string }     -- macOS only
```

```
  op-cli    -->  `op read <ref>`  -->  biometric prompt (Touch ID)  -->  token
  env       -->  process.env[envVar ?? 'OP_SERVICE_ACCOUNT_TOKEN']  -->  token
  keychain  -->  `security find-generic-password -s <svc> -a <acct> -w`  -->  token
```

The keychain source validates identifiers against `^[\w.@-]+$` to prevent
argument injection and is gated to `process.platform === 'darwin'`.

---

## Composite Secret Resolver

`createCompositeSecretResolver` (agent-vm/controller/composite-secret-resolver.ts)
is the single entry point for all secret resolution. It wraps an optional
1Password resolver and dispatches based on the `source` discriminant:

```
  resolve(ref: SecretRef)
    |
    +-- ref.source === 'environment'
    |     process.env[ref.ref]  -- throws if undefined or empty
    |
    +-- ref.source === '1password'
    |     onePasswordResolver.resolve(ref)  -- throws if resolver is null
    |
    +-- default: never
          exhaustive check -- compile-time guarantee of completeness
```

Construction flow in `controller-runtime-support.ts`:

```
  SystemConfig
    |
    +-- host.secretsProvider present?
    |     yes --> resolveServiceAccountToken(tokenSource)
    |               --> createSecretResolver({ serviceAccountToken })
    |               --> onePasswordResolver
    |     no  --> onePasswordResolver = null
    |
    +-- createCompositeSecretResolver(onePasswordResolver)
          --> SecretResolver (handles both sources)
```

---

## Zone Secret Resolution

`resolveZoneSecrets` (agent-vm/gateway/credential-manager.ts) maps zone config
entries into `SecretRef` objects and feeds them to the composite resolver:

```
  zone.secrets                        SecretRef
  +--------------------------+        +-------------------+
  | DISCORD_BOT_TOKEN        |  --->  | source: 1password |
  |   source: 1password      |        | ref: op://...     |
  |   ref: op://agent-vm/... |        +-------------------+
  +--------------------------+
  | OPENAI_API_KEY           |  --->  | source: environment |
  |   source: environment    |        | ref: OPENAI_API_KEY |
  |   envVar: OPENAI_API_KEY |        +---------------------+
  +--------------------------+
```

Each secret is resolved sequentially so that failure messages identify the
exact secret name, zone, and source reference. The function also builds
suggested 1Password references (e.g. `op://agent-vm/<zoneId>-discord/bot-token`)
in error messages when a ref is missing.

---

## Injection Modes

Every zone secret has an `injection` field: `'env'` or `'http-mediation'`.
This determines how the resolved value reaches the VM.

### env injection

The plaintext value is placed directly into the VM's environment variables.
The process inside the VM reads it from `process.env`. Simple, but the secret
is visible to any code running inside the VM.

### http-mediation injection

The resolved value never enters the VM. Instead, the Gondolin HTTP proxy
intercepts outbound requests matching the secret's `hosts` list and injects
the credential (e.g. as a Bearer token or API key header). Code inside the
VM makes requests to the allowed hosts without any secret material.

```
  +-------------------+          +--------------------+          +-----------+
  | VM process        |  ---->   | Gondolin HTTP      |  ---->   | External  |
  | (no secret value) |  HTTP    | Proxy (host-side)  |  HTTP+   | API       |
  |                   |  req     | injects credential |  secret  |           |
  +-------------------+          +--------------------+          +-----------+
```

The `http-mediation` injection mode requires at least one entry in `hosts`.
This is enforced by a Zod `superRefine` validator in the system config schema.

---

## splitResolvedGatewaySecrets

After zone secrets are resolved to plaintext, `splitResolvedGatewaySecrets`
(gateway-interface/split-resolved-gateway-secrets.ts) categorizes them:

```
  resolvedSecrets: Record<string, string>
    |
    for each (secretName, secretValue):
      |
      +-- zone.secrets[secretName].injection === 'http-mediation'
      |   AND zone.secrets[secretName].hosts exists
      |     --> mediatedSecrets[secretName] = { hosts, value }   (SecretSpec)
      |
      +-- otherwise (injection === 'env' or no hosts)
            --> environmentSecrets[secretName] = value            (plain string)
```

Returns:

```typescript
{
  environmentSecrets: Record<string, string>;   // passed as VM env vars
  mediatedSecrets: Record<string, SecretSpec>;  // passed to Gondolin HTTP hooks
}
```

The OpenClaw lifecycle further strips `OPENCLAW_GATEWAY_TOKEN` from
`environmentSecrets` because it is already baked into the effective config
file written to the host state directory.

---

## Host-Only Secrets

Some secrets are resolved but never enter any VM.

### githubToken

Configured at `host.githubToken` in the system config. Used exclusively by
`resolveControllerGithubToken` in controller-runtime-support.ts for
controller-side git push operations. Falls back to `process.env.GITHUB_TOKEN`
when not configured.

```
  host.githubToken
    |
    +-- source: '1password'   --> secretResolver.resolve({ source, ref })
    +-- source: 'environment' --> secretResolver.resolve({ source, ref: envVar })
    +-- not configured        --> process.env.GITHUB_TOKEN ?? null
```

This token authenticates git pushes from the host. It never appears in any VM
environment or mediated secret set.

---

## Auth Profiles

The `authProfilesRef` field on `zone.gateway` points to a secret containing
a JSON blob of authentication profiles (e.g. OAuth tokens for model providers).

Resolution happens in `prepareHostState` (openclaw-lifecycle.ts), which runs
before the VM boots:

1. Resolve `authProfilesRef` via the composite secret resolver
2. Create `<stateDir>/agents/main/agent/` with mode 0700
3. Write `auth-profiles.json` atomically with mode 0600

The file lands on the host filesystem. The VM accesses it through a `realfs`
VFS mount of the state directory. The secret content flows through the resolver
but the resolved value is written to disk on the host, not injected as an
environment variable.

```
  authProfilesRef (1password or env)
    |
    secretResolver.resolve(ref)
    |
    writeFileAtomically(stateDir/agents/main/agent/auth-profiles.json)
    |
    VM reads via VFS mount of stateDir
```

---

## Security Boundaries

| Secret | Resolved On | Enters VM? | Mechanism |
|--------|------------|------------|-----------|
| Zone secret (injection: env) | Host | Yes | VM environment variable |
| Zone secret (injection: http-mediation) | Host | No | Gondolin proxy injects into HTTP requests |
| OPENCLAW_GATEWAY_TOKEN | Host | No | Baked into effective config file on host; VFS-mounted read-only |
| githubToken | Host | No | Controller-side git push only |
| authProfilesRef | Host | Indirectly | Written to host disk; VM reads via VFS mount |
| Service account token | Host | No | Used only to authenticate the 1Password SDK/CLI |

All secret resolution happens on the host. The VM never has access to the
1Password service account token or to any http-mediated secret values. For
`env`-injected secrets, the plaintext is visible inside the VM -- this is an
intentional tradeoff for secrets that the VM process must use directly (e.g.
environment variables expected by SDKs running inside the VM).

---

## Key Source Files

| File | Package | Responsibility |
|------|---------|---------------|
| `secret-resolver.ts` | gondolin-adapter | Token source resolution, 1Password SDK/CLI resolver, fallback logic |
| `types.ts` | gondolin-adapter | `SecretRef` and `SecretSpec` type definitions |
| `composite-secret-resolver.ts` | agent-vm | Dispatches by source discriminant; exhaustive switch |
| `controller-runtime-support.ts` | agent-vm | Wires token source -> resolver -> composite; resolves githubToken |
| `credential-manager.ts` | agent-vm | Maps zone config entries to SecretRefs; resolves per-zone secrets |
| `split-resolved-gateway-secrets.ts` | gateway-interface | Categorizes resolved secrets into env vs mediated |
| `system-config.ts` | agent-vm | Zod schemas for secret config, injection modes, token sources |
| `openclaw-lifecycle.ts` | openclaw-gateway | prepareHostState: writes effective config + auth profiles to disk |
| `vm-adapter.ts` | gondolin-adapter | Passes `SecretSpec` map to Gondolin `createHttpHooks` for mediation |
