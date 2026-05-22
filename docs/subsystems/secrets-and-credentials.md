# Secrets and Credentials

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Secrets and Credentials

This document describes how the agent-vm system resolves, classifies, and
delivers secrets to Gondolin VMs and host-side controller operations.

---

## Core Types

Two discriminated unions drive the entire pipeline:

```
SecretRef (@agent-vm/secret-management)
  | { source: '1password'; ref: string }     -- op:// URI
  | { source: 'environment'; ref: string }    -- process.env key
  | { source: 'config'; value: string }       -- inline config value

MediatedSecretSpec (@agent-vm/secret-management)
  { hosts: readonly string[]; value: string } -- resolved value bound to hosts
```

`SecretRef` identifies *where* a secret lives. `MediatedSecretSpec` carries a
resolved plaintext value together with the hosts it should be injected into.

---

## Secret Sources

| Source | Backing Store | When Used |
|--------|--------------|-----------|
| 1Password SDK | `@1password/sdk` `createClient` | Primary path for `source: '1password'` refs |
| op-cli fallback | `op read <ref>` subprocess | Automatic fallback when SDK fails (per-secret) |
| Environment variable | `process.env[key]` | `source: 'environment'` refs |
| Config value | `system.json` inline value | `source: 'config'` refs for local/test-only plaintext config |
| macOS Keychain | `security find-generic-password` | Token storage only (service account token) |

The SDK is preferred because it resolves secrets in-process without spawning
subprocesses. When the SDK throws on a specific secret, the resolver logs to
stderr and retries that single secret via `op read` with the service account
token injected into the subprocess environment. If SDK client creation itself
fails, the entire resolver falls back to op-cli for all operations.

---

## Token Source Resolution

Before any 1Password secret can be resolved, the system needs a service account
token. `resolveServiceAccountToken` (`@agent-vm/secret-management`) supports three
sources, selected by `host.secretsProvider.tokenSource` in the system config:

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

`createCompositeSecretResolver` (`@agent-vm/secret-management`) is the single entry point
for all secret resolution. It wraps an optional 1Password resolver and
dispatches based on the `source` discriminant:

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
Tool VM secrets must use `http-mediation`; the Tool VM never receives raw
`env`-injected secrets. A secret may still use `source: "environment"` for a
Tool VM audience, but that only tells the controller where to read the value
before handing it to Gondolin mediation.

---

## splitResolvedGatewaySecrets

After zone secrets are resolved to plaintext,
`splitResolvedSecretsByInjection` categorizes them by runtime audience and
injection mode:

```
  resolvedSecrets: Record<string, string>
    |
    for each (secretName, secretValue):
      |
      +-- zone.secrets[secretName].audience does not target runtime
      |     --> skipped
      |
      +-- zone.secrets[secretName].injection === 'http-mediation'
      |   AND zone.secrets[secretName].hosts is non-empty
      |     --> mediatedSecrets[secretName] = { hosts, value }   (SecretSpec)
      |
      +-- runtime audience is gateway AND injection === 'env'
            --> environmentSecrets[secretName] = value            (plain string)
```

Schema validation rejects `env` injection for non-gateway audiences. The
splitter repeats the check as defense in depth so programmatic config bypasses
do not silently turn into Tool VM raw secret injection.

Returns:

```typescript
{
  environmentSecrets: Record<string, string>;   // passed as VM env vars
  mediatedSecrets: Record<string, SecretSpec>;  // passed to Gondolin HTTP hooks
}
```

The OpenClaw lifecycle keeps the secret named by `gateway.controllerAuth.secret`
as a gateway environment secret. The scaffold uses `OPENCLAW_GATEWAY_TOKEN`,
but the name is deployment config, not a lifecycle constant. The effective
config references it through OpenClaw's env SecretRef shape instead of storing
the plaintext token in `<stateDir>/effective-openclaw.json`. Other raw
environment secrets must be named explicitly in `gateway.rawEnvSecrets`;
provider API tokens should use `http-mediation` unless the integration cannot
be mediated at the HTTP boundary. Generated runtime env secrets, such as
zone-git capability env vars, must also be listed when enabled.

MCP Portal upstream credentials stay in the gateway VM portal process. The
portal exposes schema, summaries, helper source, and validated call results to
agents, but it does not put upstream MCP headers, stdio env, portal access
secrets, or approval HMAC keys into Tool VM helper artifacts or model-visible
portal tool inputs. The legacy HTTP+SSE upstream transport must receive auth
headers on both the initial SSE stream request and subsequent POST requests.

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

`gateway.authProfilesByAgent` maps agent IDs to secrets containing JSON blobs
of authentication profiles (e.g. OAuth tokens for model providers). Use this
for new OpenClaw deployments so each agent gets an explicit profile.

`gateway.authProfilesRef` is still supported as a legacy/shared fallback for
older single-agent deployments. It writes a profile only for the `main` agent.

Resolution happens in `prepareHostState` (openclaw-lifecycle.ts), which runs
before the VM boots:

1. Resolve every `authProfilesByAgent[agentId]` secret via the composite
   secret resolver
2. Create `<stateDir>/agents/<agentId>/agent/` with mode 0700
3. Write `auth-profiles.json` atomically with mode 0600

When only legacy `authProfilesRef` is configured, the same write happens for
`<stateDir>/agents/main/agent/auth-profiles.json`.

The file lands on the host filesystem. The VM accesses it through a `realfs`
VFS mount of the state directory. The secret content flows through the resolver
but the resolved value is written to disk on the host, not injected as an
environment variable.

```
  authProfilesByAgent[agentId] (1password or env)
    |
    secretResolver.resolve(ref)
    |
    writeFileAtomically(stateDir/agents/<agentId>/agent/auth-profiles.json)
    |
    VM reads via VFS mount of stateDir
```

---

## Runtime Auth Hints

Worker-zone mediated secrets can be described to agents with zone
`runtimeAuthHints`. The controller turns those hints into generated worker
runtime instructions under `/agent-vm/agents.md` and
`/agent-vm/runtime-instructions.md`, and injects the same text into the prompt
`runtimeInstructions` layer. OpenClaw zones do not consume `runtimeAuthHints`;
Tool VM service auth is controlled by Tool VM-audience mediated secrets and
`egressHosts`.

`runtimeAuthHints` do not mount credential files or expose real secret values.
They name the service, mediated host list, tool names, and placeholder env var
name so the agent can use normal tooling without guessing which token exists.
Known services get controller-owned setup recipes in the generated runtime
instructions. Unknown services are still listed, but the generated guidance
tells the agent to report an infrastructure/auth setup gap if the correct
toolchain setup is not known.

---

## Security Boundaries

| Secret | Resolved On | Enters VM? | Mechanism |
|--------|------------|------------|-----------|
| Zone secret (injection: env, audience: gateway) | Host | Gateway VM only | VM environment variable; OpenClaw requires `gateway.controllerAuth.secret` or `gateway.rawEnvSecrets` |
| Zone secret (injection: http-mediation, audience: gateway/both) | Host | Placeholder only | Gateway VM Gondolin proxy injects into HTTP requests |
| Zone secret (injection: http-mediation, audience: tool-vm/both) | Host | Placeholder only | Tool VM Gondolin proxy injects into HTTP requests |
| Worker runtimeAuthHints for mediated secrets | Host | Placeholder name only | Generated worker runtime instructions under `/agent-vm` |
| gateway.controllerAuth.secret | Host | Gateway VM only | Env SecretRef plus runtime-only `/run/openclaw/secrets.env` and token-only `/run/openclaw/gateway-token.env`; allowed raw env by default |
| githubToken | Host | No | Controller-side git push only |
| gateway.authProfilesByAgent | Host | Indirectly | Per-agent profile written to host disk; VM reads via VFS mount |
| gateway.authProfilesRef | Host | Indirectly | Legacy main-agent fallback written to host disk; VM reads via VFS mount |
| Service account token | Host | No | Used only to authenticate the 1Password SDK/CLI |

All secret resolution happens on the host. The VM never has access to the
1Password service account token or to any http-mediated secret values. For
`env`-injected secrets, the plaintext is visible inside the gateway VM -- this
is an intentional tradeoff for secrets that the gateway process must use
directly. The root SSH parent shell does not receive these secrets by default;
OpenClaw admin commands source the gateway token in a subshell wrapper.

---

## Key Source Files

| File | Package | Responsibility |
|------|---------|---------------|
| `onepassword-secret-resolver.ts` | secrets | Token source resolution, 1Password SDK/CLI resolver, fallback logic |
| `contracts.ts` | secrets | `SecretRef`, `SecretResolver`, and `MediatedSecretSpec` type definitions |
| `composite-secret-resolver.ts` | secrets | Dispatches by source discriminant; exhaustive switch |
| `controller-runtime-support.ts` | agent-vm | Wires token source -> resolver -> composite; resolves githubToken |
| `credential-manager.ts` | agent-vm | Maps zone config entries to SecretRefs; resolves per-zone secrets |
| `split-resolved-gateway-secrets.ts` | gateway-interface | Categorizes resolved secrets into env vs mediated |
| `system-config.ts` | agent-vm | Zod schemas for secret config, injection modes, token sources |
| `openclaw-lifecycle.ts` | openclaw-gateway | prepareHostState: writes effective config + auth profiles to disk |
| `vm-adapter.ts` | gondolin-adapter | Passes `SecretSpec` map to Gondolin `createHttpHooks` for mediation |
