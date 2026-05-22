# Controller Credential Broker for Mediated CLI Auth

Status: superseded / reference-only. Do not execute this plan directly.

Superseded by:
- `docs/superpowers/plans/2026-05-20-credentialed-tool-system.md` for the broader credentialed tool target architecture.
- `docs/superpowers/plans/2026-05-22-gondolin-adapter-tool-vm-ssh-cleanup.md` for the prerequisite adapter work that exposes native Gondolin `vm.exec` / `vm.fs`.

Still useful as background:
- OAuth refresh broker concerns.
- Provider catalog concerns.
- Why credential ownership belongs in the controller, not in gateway/plugin code.

Do not use this for:
- Running credentialed CLIs in the standard agent Tool VM.
- Final credentialed-runner API design.
- Tool VM SSH lease or FS bridge design.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. Do not run git
> commit, merge, rebase, tag, or push commands unless the user
> explicitly asks for git writes.

**Goal:** Add a controller-owned OAuth refresh broker and provider
catalog so credentialed CLIs (gogcli for Google, ntn for Notion,
linear CLI) work inside the standard Tool VM with audience-scoped
HTTP mediation and no raw credentials in any VM.

**Architecture:** The controller resolves long-lived credentials from
1Password, performs OAuth refresh on a schedule, writes rotated
refresh tokens back, and publishes short-lived access tokens to
Gondolin's secret manager as audience-scoped placeholders. Standard
Tool VMs see only placeholders; Gondolin substitutes them at HTTP
egress for allowed audience hosts. CLI binaries run in the standard
Tool VM and use their normal `Authorization`-header auth; Gondolin
substitutes the bearer/key value at egress.

**Tech Stack:** TypeScript, Zod, `@earendil-works/gondolin`
`createHttpHooks` + secret manager, controller HTTP server (Hono),
Vitest.

---

## Relation To Existing Plans

- `2026-05-10-tool-vm-mediated-cli-auth.md` — **shipped.**
  Audience-scoped egress and mediated secrets exist. This plan
  reuses that mediation primitive as the substitution boundary.

- `2026-05-10-gondolin-secret-source.md` — **superseded for the
  OAuth refresh portion only.** That plan put real tokens in the
  gateway/plugin and used a controller route for plugin-driven
  updates. This plan flips ownership to the controller. The
  Tool VM lifecycle, audience schema, and rootfs changes from that
  plan stay valid. Anything in it about `secretSources` in the
  openclaw plugin or `POST /lease/:leaseId/secrets/:secretName`
  is replaced by the controller-internal scheduler described here.

- `2026-05-10-mcp-capability-portal.md` — **independent.** MCP
  Portal is not required for this plan. When it lands later, a
  Portal provider kind can call the same controller broker; no
  changes here.

- `2026-05-11-ephemeral-credential-runner-vm.md` (on
  `origin/plan/gondolin-secret-source-mcp-portal`) — **v2
  hardening plan.** Adds a separate "CLI Runner" Tool VM type
  with typed argv, output validation, and HITL approval. Deferred
  until v1 ships and a real need surfaces (sub-scope restriction,
  HITL, structured per-operation audit, or Class D / E provider).

## Background And Decision Record

1. We started with the intuition that credentialed CLIs need a
   separate "Credentialed Tool VM" with vm.exec-driven typed argv,
   no shell, and isolated credentials.

2. Two facts collapsed the design:

   - **Gondolin runs on the host as part of the controller
     process.** Anything that requires `vm.exec`, VM creation, or
     secret-manager updates must run controller-side. The
     openclaw plugin (which runs inside the gateway VM) cannot
     touch Gondolin directly.

   - **HTTP mediation already substitutes placeholders at egress.**
     Tool VMs never need to hold raw credentials. The audience plan
     shipped this primitive; we generalize it to OAuth-refreshed
     short-lived access tokens.

3. For target CLIs (gogcli, ntn, linear), all three:

   - send `Authorization: Bearer <token>` (or for Linear personal
     API keys, `Authorization: <key>` verbatim from env)
   - do not validate token format client-side
   - accept any string as the token and forward it in the header

   This means HTTP mediation with a placeholder substitution is a
   complete solution for these CLIs. No separate runner VM needed
   in v1.

4. Class D (SigV4 / request signing) and Class E (CLIs that
   require local keyring access and cannot be coerced into
   bearer-token mode) need a different primitive. Defer to v2.

5. CLIs that talk to host applications (Things 3 via AppleScript /
   SQLite / URL scheme) need a host-subprocess pattern, not a VM
   pattern. Defer to a separate plan.

6. The boundary stays "controller owns long-lived secrets; VMs see
   only placeholders." This plan implements that for OAuth refresh
   token flows on top of the existing static-token mediation.

## Non-Negotiable Boundaries

1. **No raw credentials in any guest VM.** Standard Tool VM and
   gateway VM see only Gondolin placeholders. Refresh tokens,
   OAuth client secrets, raw API keys all live in 1Password and
   are resolved only inside the controller process.

2. **Controller is the single writer for refresh-token rotation.**
   When Google or another provider rotates the refresh token, the
   controller writes the new value back to 1Password. No other
   actor calls the OAuth `/token` endpoint for a given credential.

3. **OAuth initial auth and reauth are manual and out of band.**
   The system does not run browser-based OAuth flows. Humans
   complete OAuth via their local machine, export the refresh
   token, and store it in 1Password. The agent and the running
   system never prompt for credentials.

4. **Substitution scope is per provider audience.** A placeholder
   for Google access tokens is only substituted on outbound HTTP
   to declared Google hosts. Cross-provider leakage requires both
   a mediator misconfiguration and an audience match.

5. **`invalid_grant` is a fatal alert, never a silent retry.** When
   a refresh exchange returns `invalid_grant`, the broker emits
   a typed `reauth_required` event, marks the credential
   unavailable for that credential profile, and surfaces an alert.
   Subsequent calls fail fast with `auth_required`.

## Architecture

```text
[ user, one-time manual ]
  human runs `gog auth add` / Linear OAuth / Notion integration
  setup on their machine, exports refresh token + client config
  stores op://agent-vm/<provider>/refresh-token etc. in 1Password

[ controller (host process), per call AND in background ]
  credential broker:
    reads 1Password (op://...) for refresh token + client config
    posts to provider's OAuth /token endpoint
    receives access_token (TTL ~1h) + maybe new refresh_token
    writes any new refresh_token back to 1Password (single writer)
    caches access_token until skew-before-expiry
  publishes to Gondolin secret manager:
    placeholder name (e.g. GOOGLE_ACCESS_TOKEN)
    real access token value
    audience: tool-vm | both
    hosts: ["www.googleapis.com", "oauth2.googleapis.com", ...]
  background keep-alive:
    every warmIntervalDays, exercise the refresh exchange to
    prevent provider-side inactivity invalidation
  invalid_grant handler:
    emit typed alert (reauth_required), do not retry

[ Gondolin (host) ]
  Tool VM env contains placeholders only
    GOOGLE_ACCESS_TOKEN = "GONDOLIN_SECRET_<hash>"
    LINEAR_API_KEY      = "GONDOLIN_SECRET_<hash>"  (or "Bearer GONDOLIN_..." for OAuth)
    NOTION_API_TOKEN    = "GONDOLIN_SECRET_<hash>"
  on outbound HTTPS to audience hosts:
    Authorization header value matched against known placeholders
    placeholder swapped for real token before forwarding to provider

[ OpenClaw gateway VM ]
  openclaw process running here (NOT in the Tool VM)
  openclaw-agent-vm-plugin loaded inside openclaw
  plugin holds the controller lease for the agent's scope
  plugin SSHes into the standard Tool VM to run shell commands

[ standard Tool VM ]
  shell target only. sshd listening; no openclaw process here.
  gogcli, ntn, linear CLIs baked into the Tool VM image
  /work realfs mount for agent workspace
  agent-driven shell commands (sent via SSH from the plugin) run
  CLIs like:
    gog calendar events --access-token "$GOOGLE_ACCESS_TOKEN" --json
    ntn pages search --query foo
    linear issue list
  CLIs send HTTPS with Authorization header using placeholder
  Gondolin substitutes; provider sees real token; result returns
  agent never sees raw credentials

References:
  ▸ docs/architecture/openclaw-gateway.md describes the lease →
    SSH → Tool VM flow
  ▸ packages/openclaw-agent-vm-plugin/src/openclaw-backend-
    dependencies.ts builds the SSH shell path
```

## Storage Model

Decision: **Model 1 — 1Password SDK as single source of truth.**

  ▸ All long-lived credentials (OAuth client id/secret, refresh
    tokens, static bearer tokens) live in 1Password.
  ▸ Controller reads via batched `resolveAll(...)` at startup
    using the existing SDK-based secret resolver (per the
    `agent-vm.plan-sdk-secret-resolution-startup` refactor).
  ▸ Controller writes refresh-token rotations back via 1P SDK
    (`items.put(...)`) through the new `CredentialStore`
    abstraction.
  ▸ Plaintext credentials held in controller process memory
    between refreshes. No encrypted credential state file on
    disk in v1.

Why not on-disk encrypted state (age) in v1:

  ▸ 1P SDK is fast enough for the actual write frequency
    (~70 writes per day across 3 active profiles).
  ▸ Single source of truth simplifies revocation, audit, and
    human management.
  ▸ Reduces controller-side encryption code surface.
  ▸ Age primitive remains used for existing backup encryption
    (separate concern); it is NOT used for runtime credential
    state.

Optional v2 upgrade: layered age-encrypted local cache on top of
1P SDK for offline operation. Not in scope for this plan.

## Auth Provider Classes

In scope for v1:

- **Class A — OAuth refresh-token flow.** Long-lived refresh token
  in 1Password. Controller exchanges for access token, publishes
  placeholder. Example providers: Google (gogcli), Linear OAuth,
  Notion OAuth (when used).

- **Class B — Static bearer / API key.** Long-lived static token in
  1Password. Controller resolves and publishes placeholder
  directly; no refresh exchange. Example providers: GitHub PAT
  (already shipped via audience plan), Linear personal API key,
  Notion integration token.

- **Class C — OAuth initial login and reauth.** Manual, one-time,
  out-of-band per credential profile. Documented procedure per
  provider; not automated.

Deferred to v2 or separate plans:

- **Class D — SigV4 or request signing.** CLIs that sign request
  bodies (AWS `aws` CLI with SigV4, GCP service-account JWT
  signing) cannot use header-substitution mediation. Requires
  either a host-side signing proxy or the v2 CLI Runner VM. See
  `2026-05-11-ephemeral-credential-runner-vm.md` slot.

- **Class E — CLI keyring auth.** CLIs that require local keyring
  state and cannot be coerced into bearer-token mode. May be
  resolvable by `--access-token`-style flags per CLI; otherwise
  falls into Class D's plan.

- **Host application CLIs.** Things 3 (clings, things-cli) and
  similar macOS-app CLIs use AppleScript / SQLite / URL schemes.
  Not HTTP. Needs a controller-host-subprocess pattern in a
  separate plan.

## Provider Catalog (v1 concrete examples)

### Google (via gogcli)

- **Kind:** Class A — OAuth refresh-token.
- **Auth shape:** access token passed as `--access-token <value>`
  CLI flag; gogcli sends `Authorization: Bearer <value>` via
  `golang.org/x/oauth2/Transport`. Verified via DeepWiki: no
  client-side token validation.
- **Token endpoint:** `https://oauth2.googleapis.com/token`
- **Refresh grant:** `grant_type=refresh_token`, with `client_id`,
  `client_secret`, `refresh_token`.
- **Egress hosts (audience):**
  - `oauth2.googleapis.com` (refresh; controller egress only)
  - `www.googleapis.com`
  - `gmail.googleapis.com`
  - `calendar.googleapis.com`
  - `drive.googleapis.com`
  - `people.googleapis.com`
  - `docs.googleapis.com`
  - `sheets.googleapis.com`
- **1Password layout:**
  ```
  op://agent-vm/<credential-profile>-google/client-id
  op://agent-vm/<credential-profile>-google/client-secret
  op://agent-vm/<credential-profile>-google/refresh-token
  ```
- **Tool VM env:**
  - `GOOGLE_ACCESS_TOKEN` (placeholder, Bearer-shaped value)
- **CLI usage:** `gog --json --no-input <subcmd> ... --access-token "$GOOGLE_ACCESS_TOKEN"`
- **Keep-alive interval:** 30 days. Google invalidates refresh
  tokens after ~6 months of disuse; we exercise well before.

### Linear (via linear-cli)

- **Two valid paths.**

  **Path Linear-OAuth (recommended for consistency):**

  - **Kind:** Class A.
  - **Token endpoint:** Linear OAuth 2.0 endpoint.
  - **Auth header:** `Authorization: Bearer <access_token>`.
  - **Tool VM env:** `LINEAR_API_KEY="Bearer GONDOLIN_SECRET_xyz"`.
    The CLI passes `LINEAR_API_KEY` verbatim as the Authorization
    header value.
  - Refresh + keep-alive same as Google.

  **Path Linear-PAT (simpler, no refresh):**

  - **Kind:** Class B.
  - **Auth header:** `Authorization: <api_key>` (no Bearer prefix
    per Linear docs).
  - **Tool VM env:** `LINEAR_API_KEY="GONDOLIN_SECRET_xyz"` (no
    Bearer).
  - **Requires:** Gondolin mediation must substitute placeholders
    in the Authorization header regardless of Bearer prefix. See
    Implementation Step "Non-Bearer Substitution" below.

- **GraphQL endpoint:** `https://api.linear.app/graphql`
- **Egress hosts:** `api.linear.app`
- **1Password layout (PAT path):**
  ```
  op://agent-vm/<credential-profile>-linear/api-key
  ```

### Notion (via ntn)

- **Kind:** Class B (static bearer) for integration token, OR
  Class A for OAuth flow if needed.
- **Auth header:** `Authorization: Bearer <token>` (standard).
- **Tool VM env:** `NOTION_API_TOKEN="GONDOLIN_SECRET_xyz"`.
- **CLI behavior:** ntn passes env var as Bearer in Authorization
  header. No client-side validation.
- **API hosts:** `api.notion.com`
- **1Password layout:**
  ```
  op://agent-vm/<credential-profile>-notion/integration-token
  ```

### GitHub (via gh / direct API)

- Already shipped via `2026-05-10-tool-vm-mediated-cli-auth.md`.
- Static bearer (Class B). No changes required for this plan;
  audience plan covers it.

## Config Model

Extend `zones[]` schema in `system.json` with:

```jsonc
{
  "zones": [
    {
      "id": "shravan-claw",
      "credentialProviders": {
        "google": {
          "kind": "oauth-refresh-token",
          "tokenEndpoint": "https://oauth2.googleapis.com/token",
          "refreshSkewMs": 300000,
          "warmIntervalDays": 30,
          "audienceHosts": [
            "oauth2.googleapis.com",
            "www.googleapis.com",
            "gmail.googleapis.com",
            "calendar.googleapis.com",
            "drive.googleapis.com",
            "people.googleapis.com",
            "docs.googleapis.com",
            "sheets.googleapis.com"
          ]
        },
        "linear-oauth": {
          "kind": "oauth-refresh-token",
          "tokenEndpoint": "https://api.linear.app/oauth/token",
          "refreshSkewMs": 300000,
          "warmIntervalDays": 30,
          "audienceHosts": ["api.linear.app"]
        },
        "linear-pat": {
          "kind": "static-bearer",
          "audienceHosts": ["api.linear.app"],
          "bearerPrefix": ""
        },
        "notion": {
          "kind": "static-bearer",
          "audienceHosts": ["api.notion.com"],
          "bearerPrefix": "Bearer"
        }
      },
      "credentialProfiles": {
        "main": {
          "google": {
            "clientIdRef": "op://agent-vm/main-google/client-id",
            "clientSecretRef": "op://agent-vm/main-google/client-secret",
            "refreshTokenRef": "op://agent-vm/main-google/refresh-token",
            "envName": "GOOGLE_ACCESS_TOKEN"
          },
          "linear-pat": {
            "tokenRef": "op://agent-vm/main-linear/api-key",
            "envName": "LINEAR_API_KEY"
          },
          "notion": {
            "tokenRef": "op://agent-vm/main-notion/integration-token",
            "envName": "NOTION_API_TOKEN"
          }
        }
      },
      "credentialProfilesByAgent": {
        "agent-a": "main",
        "agent-b": "main"
      }
    }
  ]
}
```

**Notes:**

- `credentialProviders` declares what's possible in this zone:
  protocol shape, refresh policy, and substitution scope. Read by
  the controller broker.
- `credentialProfiles` maps a profile name to the actual
  1Password refs and the env var name the placeholder is published
  under.
- `credentialProfilesByAgent` picks one profile per agent.

**Egress allowlist vs substitution scope — two different things:**

- **`zone.egressHosts`** (existing, in
  `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`) is the
  NETWORK ALLOWLIST. Gondolin will refuse outbound HTTP to hosts
  not in this list. This is the source of truth for "what can the
  Tool VM talk to."

- **`credentialProviders[*].audienceHosts`** is the SUBSTITUTION
  SCOPE. For each provider's placeholder, Gondolin substitutes the
  real token ONLY when the outbound request targets one of these
  hosts. This is narrower than the egress allowlist: a host can be
  reachable (in egressHosts) without being eligible for a given
  provider's placeholder substitution.

- **Validation requirement.** Every provider's `audienceHosts` must
  be a subset of `zone.egressHosts` (with appropriate audience,
  i.e., `tool-vm | both`). The system-config validator must enforce
  this; doctor must report mismatches. A provider with an audience
  host not in egressHosts is a config error.

## Initial OAuth Setup Procedure

This is the one-time, manual, out-of-band setup. Document a script
or runbook so users don't need to follow free-form instructions.

### Google (for gogcli)

1. Create or pick a Google Cloud project; enable the APIs you need
   (Calendar, Gmail, Drive, etc.).

2. Configure the OAuth consent screen. **Important:**

   - If the consent screen status is **"Testing"**, refresh
     tokens issued for that client EXPIRE IN 7 DAYS. This will
     break the broker's keep-alive model.
   - You MUST publish the consent screen to **"In production"**
     before issuing refresh tokens you intend to use long-term.
   - Even after publication, Google's docs say refresh tokens
     can expire after 6 months of disuse; the broker's
     keep-alive timer (default 30 days) is designed to stay well
     under that.
   - See:
     https://developers.google.com/identity/protocols/oauth2#expiration

3. Create OAuth 2.0 client credentials of type **Desktop App** in
   that project; download the JSON.

4. On your local machine: `pnpx gogcli auth add --client <path-to-client-json>`.
   gogcli will run the browser flow with `access_type=offline` and
   `--force-consent` to ensure a refresh token is issued.

5. Export the refresh token:
   `pnpx gogcli auth tokens export <email> --output ./refresh.json`.

6. Store in 1Password (refs accessed via the CredentialStore /
   1P SDK; no `op` CLI):
   - field `client-id` ← from client JSON
   - field `client-secret` ← from client JSON
   - field `refresh-token` ← from refresh.json

7. Add to `system.json`: a `credentialProvider` entry for `google`
   if absent, and a `credentialProfile` entry referencing the
   1Password fields.

8. Run `agent-vm doctor <zone>` to verify the broker can resolve
   the refs and perform an initial refresh exchange.

### Linear OAuth

1. Create a Linear OAuth application at
   `https://linear.app/settings/api/applications`.
2. Configure redirect URI for your local machine.
3. Complete the OAuth authorization code flow with `prompt=consent`
   and a script that captures the refresh token. (Linear's
   developer docs at https://linear.app/developers cover this.)
4. Store `client-id`, `client-secret`, and `refresh-token` in
   1Password under `op://agent-vm/<profile>-linear/...`.

### Linear personal API key (simpler)

1. Go to `linear.app/settings/account/security`, create a personal
   API key, copy.
2. Store in 1Password as `op://agent-vm/<profile>-linear/api-key`.
3. No refresh needed; key lasts until manually revoked.

### Notion integration token

1. Create an internal integration at
   `https://www.notion.so/profile/integrations`.
2. Connect it to the workspaces or pages you want the agent to
   access.
3. Copy the integration token.
4. Store as `op://agent-vm/<profile>-notion/integration-token`.

## Refresh Lifecycle

For each Class A provider, the controller broker runs:

1. **Initial resolution at zone startup.** Resolve `clientIdRef`,
   `clientSecretRef`, `refreshTokenRef` via the CredentialStore
   abstraction (1Password SDK). POST to `tokenEndpoint` with
   `grant_type=refresh_token`. Receive access token, expiry,
   possibly new refresh token.

2. **Proactive refresh timer.** Schedule a refresh at
   `expiresAt - refreshSkewMs`. Default skew 5 minutes. The
   scheduler uses an injected clock (deterministic in tests; real
   `Date.now`/`setTimeout` in production). No wall-clock tests.

3. **Rotation write-back.** If the refresh response contains a new
   `refresh_token`, write it back via
   `CredentialStore.writeSecretRef(...)` using the same op://
   reference. This must be atomic, idempotent, and single-writer
   (only the broker writes back). Failures emit alerts and mark
   the profile unavailable.

4. **Keep-alive timer.** Every `warmIntervalDays` (default 30), run
   a no-op refresh exchange to prevent provider-side inactivity
   invalidation. For Google, the documented inactivity window is
   ~6 months
   (https://developers.google.com/identity/protocols/oauth2#expiration);
   we exercise monthly to stay well under.

5. **`invalid_grant` handling.** On `invalid_grant` from the token
   endpoint:
   - mark the credential profile as `reauth_required`
   - emit a typed alert (Linear ticket, push, etc.; configurable
     per zone)
   - optionally close active Tool VM leases bound to this
     credential profile, OR delete the mediated secret from
     Gondolin's secret manager so the next CLI call fails fast
     (configurable: close vs delete)
   - do not retry the refresh; require human re-auth via the
     setup procedure

6. **Audit log.** Every refresh exchange, rotation write-back,
   keep-alive run, and alert is logged with timestamp, profile
   name, provider name, and outcome. No token values appear in
   logs.

Explicitly NOT in v1:

- **Per-call transparent refresh-on-401 with retry.** Gondolin
  exposes `onResponse(response, request)` hooks, but transparent
  retry from the mediator is not a built-in broker primitive, and
  the SAME path (CLI shell command) does not surface a typed
  `auth_required` result up the call chain — the agent would see
  a CLI exit code and an HTTP 401 in the CLI's stderr. v1 relies
  on proactive refresh keeping access tokens valid; if invalid_grant
  fires between refreshes, the next CLI call sees a 401 in stderr
  and the agent surfaces it as a normal CLI failure.

  v2 may add a hook/proxy feature that emits structured
  `auth_required` events when the broker detects invalid_grant; not
  in scope here.

For Class B (static bearer), only steps 1, 5 (treating 401 as a
soft error; bearer probably revoked), and 6 apply.

## Tool VM Image

Standard Tool VM image (`vm-images/tool-vm/`) gets:

- `gogcli` binary baked in (download from official release;
  pin version + SHA256)
- `ntn` (Notion CLI) binary baked in
- `linear-cli` baked in (npm/Deno-based)
- `gh` already present
- `jq`, `ripgrep`, `fd` for output processing (per existing init
  scaffolding)
- CA certificate bundle (already present)
- Time sync (already present)
- No keyring backends. CLIs use --access-token flags or env vars
  only, never their built-in keyring.

Environment variables (per agent's credential profile, set by
controller through Gondolin secret manager):

```
GOOGLE_ACCESS_TOKEN=GONDOLIN_SECRET_<...>
LINEAR_API_KEY=GONDOLIN_SECRET_<...>      # or "Bearer GONDOLIN_..." for OAuth path
NOTION_API_TOKEN=GONDOLIN_SECRET_<...>
```

Egress allowlist for Tool VMs (audience `tool-vm | both`):

```
www.googleapis.com, gmail.googleapis.com, calendar.googleapis.com,
drive.googleapis.com, people.googleapis.com, docs.googleapis.com,
sheets.googleapis.com, api.linear.app, api.notion.com,
api.github.com, github.com, ...
```

Explicitly NOT in Tool VM audience: `oauth2.googleapis.com` (refresh
exchanges happen controller-side, not in Tool VM).

## File Structure

Modify:

- `packages/agent-vm/src/config/system-config.ts`
  - Add `credentialProviders` zone schema (Zod discriminated union
    of `oauth-refresh-token` and `static-bearer`).
  - Add `credentialProfiles` and `credentialProfilesByAgent`.
- `packages/agent-vm/src/config/system-config.test.ts`
  - Schema parsing tests + invalid configs.

- `packages/gondolin-adapter/src/secret-resolver.ts`
  - Already has `resolveSecretRef` and now batched `resolveAll`
    (per recent SDK refactor in
    `agent-vm.plan-sdk-secret-resolution-startup`).
- `packages/gondolin-adapter/src/vm-adapter.ts`
  - Currently drops `CreateHttpHooksResult.secretManager`. Must
    extend `ManagedVm` to expose
    `listMediatedSecret`, `updateMediatedSecret`,
    `deleteMediatedSecret` from Gondolin's secret manager
    (`@earendil-works/gondolin@0.9.1` exports
    `secretManager.listSecrets/updateSecret/deleteSecret` via
    `dist/src/http/hooks.d.ts:44`). Verify the substitution path
    handles non-Bearer Authorization headers (Linear PAT case);
    extend if not.

- `packages/agent-vm/src/controller/credential-store/credential-store.ts`
  - New file. The `CredentialStore` abstraction with
    `readSecretRef(ref: SecretRef)` and
    `writeSecretRef(ref: SecretRef, value: string)`. Backed by
    the 1Password TS SDK (`@1password/sdk` v0.4.0,
    `items.put(...)` for updates per
    `dist/items.d.ts:27`). Parses `op://vault/item/field` URIs.
- `packages/agent-vm/src/controller/credential-store/op-ref-parser.ts`
  - Strict parser for `op://vault/item/field` and
    `op://vault/item/section/field` URIs.
- `packages/agent-vm/src/controller/credential-store/credential-store.test.ts`
  - Mock SDK; tests for read, write, parse errors, field
    selection, vault scoping.

- `packages/agent-vm/src/controller/credential-broker/credential-broker.ts`
  - New file. Owns OAuth refresh, rotation write-back, keep-alive,
    invalid_grant alerts.
- `packages/agent-vm/src/controller/credential-broker/credential-broker.test.ts`
  - Unit tests with mocked OAuth token endpoint.
- `packages/agent-vm/src/controller/credential-broker/oauth-token-exchange.ts`
  - Per-provider token endpoint POST helper.
- `packages/agent-vm/src/controller/credential-broker/credential-profile-registry.ts`
  - Registry that resolves the per-(zone, agent) credential profile
    into the actual op:// refs.

- `packages/agent-vm/src/controller/controller-runtime.ts`
  - Wire credential broker into startup.
  - At Tool VM lease creation, publish the agent's resolved
    placeholders to Gondolin secret manager for that VM.

- `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
  - Already passes audience-scoped secrets to `createManagedVm`.
    Extend to include the credentialProfile-resolved env vars
    pointed at Gondolin placeholders.

- `docker/base-images/tool-vm/Dockerfile`
  - Install gogcli, ntn, linear-cli binaries with pinned versions
    and SHA256 verification. This is the actual Tool VM image
    build path in this repo.

- `packages/agent-vm/src/cli/manual-templates.ts`
  - Generated runtime manual content. Add sections describing
    initial OAuth setup procedures for Google, Linear, Notion.
    This is the canonical source of human setup docs; do NOT
    create a separate `docs/manual/initial-oauth-setup.md` file.

- `docs/reference/configuration/system-json.md`
  - Document `credentialProviders`, `credentialProfiles`,
    `credentialProfilesByAgent`, and the egress-vs-substitution
    distinction.
- `docs/subsystems/secrets-and-credentials.md`
  - Add Class A and Class B sections; document the OAuth refresh
    lifecycle and CredentialStore abstraction.
- `docs/getting-started/openclaw-guide.md`
  - Add a "Setting up credentialed CLIs" section referencing the
    generated manual.

Create new:

- `packages/agent-vm/src/controller/credential-broker/credential-broker.ts`
  - Owns OAuth refresh state, schedules, rotation write-back,
    invalid_grant alerts.
- `packages/agent-vm/src/controller/credential-broker/refresh-scheduler.ts`
  - Timer-based refresh + keep-alive, with an injected clock
    interface for deterministic tests (no wall-clock tests).
- `packages/agent-vm/src/controller/credential-broker/rotation-writeback.ts`
  - Rotated-refresh-token write helper that calls
    `CredentialStore.writeSecretRef(...)` (not op CLI; SDK
    only).
- `packages/agent-vm/src/controller/credential-broker/alert-emitter.ts`
  - Configurable alert sink (default: structured log; pluggable
    for Linear ticket or push).
- `packages/agent-vm/src/controller/credential-broker/active-lease-index.ts`
  - Per-(zoneId, credentialProfileId) index of active lease IDs.
    Used by the broker to apply secret-manager updates to all
    Tool VM leases bound to a given credential profile. Built at
    lease-create time, torn down at lease-release time.
- `packages/agent-vm/src/controller/credential-broker/credential-broker.test.ts`
- `packages/agent-vm/src/controller/credential-broker/refresh-scheduler.test.ts`
  - Uses fake timers / injected clock.
- `packages/agent-vm/src/controller/credential-broker/active-lease-index.test.ts`

## Implementation Steps

Use TDD throughout. Each task: failing test first, then implement.

- [ ] **Task 1 — System config schema for credential providers.**
  - Add Zod schema for `credentialProviders` (discriminated union
    of `oauth-refresh-token` and `static-bearer`), with provider
    fields, audience hosts, refresh skew, warm interval.
  - Add `credentialProfiles` and `credentialProfilesByAgent`.
  - Validator: `provider.audienceHosts ⊆ zone.egressHosts`
    (with audience match `tool-vm | both`) is enforced; mismatch
    is a config error.
  - Tests: valid and invalid configs, audience-host subset
    validation, per-agent profile resolution.

- [ ] **Task 2 — CredentialStore abstraction over 1P SDK.**
  - Create `CredentialStore` with `readSecretRef(SecretRef)`
    and `writeSecretRef(SecretRef, value)` backed by
    `@1password/sdk` v0.4.0 (`items.put` for writes).
  - Strict op:// URI parser (vault/item/field, vault/item/section/
    field).
  - Tests: mock SDK; read, write, parse errors, vault scoping,
    field selection.

- [ ] **Task 3 — Expose Gondolin secret manager via ManagedVm.**
  - `packages/gondolin-adapter/src/vm-adapter.ts` currently drops
    `CreateHttpHooksResult.secretManager`. Add `ManagedVm` methods
    `listMediatedSecret`, `updateMediatedSecret`,
    `deleteMediatedSecret`, wired to the secret manager from
    `createHttpHooks`.
  - Tests: managed-vm tests for list/update/delete, including
    error paths.

- [ ] **Task 4 — OAuth token exchange helper.**
  - Pure function: `exchangeRefreshToken({ tokenEndpoint, clientId,
    clientSecret, refreshToken })` → `{ accessToken, expiresInMs,
    newRefreshToken? }`.
  - Tests: mock `fetch`, success, rotation, `invalid_grant`,
    network failure, malformed JSON.

- [ ] **Task 5 — Credential broker core.**
  - State: map of (zoneId, profileId, providerKey) → credential
    status (current access token, expiry, last refresh outcome,
    reauth flag).
  - Methods: `initializeProfile`, `getActiveSecret`,
    `forceRefresh`, `handleInvalidGrant`.
  - Tests: lifecycle, rotation write-back call, alert emission,
    multi-profile isolation.

- [ ] **Task 6 — Rotation write-back via CredentialStore.**
  - Implement single-writer write-back through
    `CredentialStore.writeSecretRef(...)`. NO op CLI; SDK only.
  - Tests: success path, failure raises alert, idempotent retry.

- [ ] **Task 7 — Refresh scheduler with injected clock.**
  - Per credential, schedule a refresh at `expiresAt - skew`.
  - Per Class A credential, schedule keep-alive at
    `warmIntervalDays`.
  - All timing through an injected `Clock` interface
    (`now()` + `setTimer(ms, cb)`); production uses `Date.now`
    and `setTimeout`; tests use fake timers / deterministic
    clocks.
  - Tests: timer triggers refresh on cue, keep-alive triggers
    no-op refresh, scheduler survives synthetic clock jump.

- [ ] **Task 8 — Alert emitter.**
  - Structured log default; pluggable for Linear / push.
  - Tests: invalid_grant emits alert with profile + provider name.

- [ ] **Task 9 — Active-lease index.**
  - `ActiveLeaseIndex` per controller: map (zoneId,
    credentialProfileId) → Set<leaseId>. Lease records gain
    `agentId` and `credentialProfileId` fields when created. Index
    populated on lease create, depleted on lease release.
  - Update `packages/agent-vm/src/controller/leases/lease-manager.ts`
    and the lease serialization to include these fields.
  - Tests: index populates / depopulates correctly, multi-profile
    isolation, lease list query.

- [ ] **Task 10 — Gondolin secret manager integration at lease
  creation.**
  - On Tool VM lease creation, look up agent's credentialProfile,
    resolve all current placeholders from broker, publish to
    Gondolin secret manager for the new VM with audience hosts
    + audience match `tool-vm | both`.
  - Tests: Tool VM env contains placeholders only, audience
    matches expected hosts.

- [ ] **Task 11 — Active lease secret updates.**
  - On refresh, broker iterates `ActiveLeaseIndex` for the
    rotated profile and calls
    `managedVm.updateMediatedSecret(...)` on each active lease's
    Tool VM.
  - Tests: refresh propagates to all active leases, removed
    leases are not touched.

- [ ] **Task 12 — `invalid_grant` ─► profile unavailable flow.**
  - When broker hits invalid_grant, mark profile unavailable and
    either close all active leases bound to it or
    `deleteMediatedSecret` on each so CLI calls fail fast with
    HTTP 401 in stderr.
  - Tests: end-to-end, broker handles, downstream CLI sees 401
    (or lease closure, depending on policy).

- [ ] **Task 13 — Audit log integration.**
  - Every refresh, rotation, keep-alive, alert recorded with
    timestamp, profile, provider, outcome.
  - Tests: events are logged; no token values appear in logs.

- [ ] **Task 14 — Non-Bearer Authorization header substitution.**
  - Verify Gondolin `createHttpHooks` substitutes placeholders in
    Authorization header value regardless of "Bearer " prefix. If
    only Bearer-prefixed matches work today, file follow-up to
    extend or use the OAuth-Bearer Linear path only.
  - Tests: substitution for `Authorization: Bearer GONDOLIN_xxx`
    AND `Authorization: GONDOLIN_xxx` (Linear PAT) against a mock
    server.

- [ ] **Task 15 — Per-CLI acceptance tests against a mock HTTP
  server.**
  - For each CLI (gogcli, ntn, linear-cli), spin up a local mock
    HTTP server. Run the CLI with a placeholder env var as the
    token. Verify the CLI sends the placeholder unchanged in the
    Authorization header (gogcli: `Bearer <placeholder>`; ntn:
    `Bearer <placeholder>`; linear-cli: verbatim `<placeholder>`
    or `Bearer <placeholder>` depending on env var content).
  - These are CONCRETE acceptance tests, not assumptions.

- [ ] **Task 16 — Tool VM image: bake CLIs.**
  - Add gogcli, ntn, linear-cli to
    `docker/base-images/tool-vm/Dockerfile` with pinned versions
    + SHA256 verification.
  - Tests: `agent-vm doctor` reports installed CLIs and versions.

- [ ] **Task 17 — Audience host validation.**
  - `agent-vm validate` enforces:
    `provider.audienceHosts ⊆ zone.egressHosts` (with appropriate
    audience match `tool-vm | both`).
  - `agent-vm doctor` reports mismatches at runtime.
  - Tests: invalid configs rejected by validator.

- [ ] **Task 18 — Documentation via manual-templates.ts.**
  - Add initial OAuth setup procedures (Google, Linear, Notion)
    to `packages/agent-vm/src/cli/manual-templates.ts` as
    generated manual content. Do NOT create a separate
    `docs/manual/initial-oauth-setup.md`.
  - Include warnings: Google's "Testing" mode OAuth consent screen
    issues refresh tokens that EXPIRE IN 7 DAYS
    (https://developers.google.com/identity/protocols/oauth2#expiration).
    Refresh tokens unused for 6 months also expire.
    Setup procedure must direct users to publish their OAuth
    consent screen out of "Testing" status before relying on the
    refresh token for production use.
  - Update `docs/reference/configuration/system-json.md`,
    `docs/subsystems/secrets-and-credentials.md`,
    `docs/getting-started/openclaw-guide.md`.

- [ ] **Task 19 — Validation and doctor.**
  - `agent-vm validate` checks config-level: provider audience
    hosts present and subset of egressHosts, profile 1P refs
    well-formed (op://...), profile references valid provider
    keys.
  - `agent-vm doctor` runtime: probes that op:// refs resolve via
    CredentialStore (without printing values), initial refresh
    exchange succeeds for each Class A profile, Tool VM image
    has expected CLIs with expected versions.

- [ ] **Task 20 — End-to-end live smoke tests.**
  - gogcli: `gog calendar events --json` returns events from
    Google.
  - Linear: `linear issue list --json` returns issues.
  - Notion: `ntn search <query>` returns pages.
  - All three: real token never appears in any log line.

- [ ] **Task 21 — Full quality gate.**
  - `pnpm check`, `pnpm test:unit`, `pnpm test:smoke`,
    `pnpm test:integration`, `pnpm typecheck`, `pnpm fmt:check`,
    `pnpm lint`, `pnpm lint:types`. All green.

## Testing Plan

### Unit Tests

- Config parsing: Class A and Class B providers parse; missing
  fields rejected; audience host format validated.
- Token exchange: mocked fetch, all branches (success, rotation,
  invalid_grant, network failure).
- Broker state machine: profile init, refresh, rotation,
  invalid_grant.
- Rotation writeback: success, failure, idempotency.
- Scheduler: timers fire at correct times, cleanup on cancel.
- Alert emitter: emits with profile + provider, no token leakage.

### Smoke Tests

- Broker startup with stubbed `op` CLI and stubbed token endpoint.
- Tool VM lease creation publishes correct placeholders.

### Integration Tests

- Live OAuth flow with a test Google Cloud project (requires
  test credentials in CI vault; skipped by default).
- Real Tool VM boot with mediated tokens; verify CLI calls reach
  provider APIs.

### Output Hygiene Test

- Run each CLI with each provider; grep all logs for raw token
  patterns (`ya29.*`, `ghp_*`, `lin_*`, `op://*`). Must find none.

## Validation And Doctor

`agent-vm validate <config>` reports:

- credentialProviders schema valid
- audience hosts non-empty per provider
- credentialProfiles reference valid provider keys
- credentialProfilesByAgent agent IDs match zone agents
- 1Password refs are well-formed (op://...)

`agent-vm doctor <zone>` runtime probes:

- op:// refs resolve via CredentialStore (without printing values)
- Class A initial refresh exchange succeeds for each profile
  using `exchangeRefreshToken`
- Tool VM image has expected CLI binaries (version + SHA256)
- Gondolin secret manager API responds via the exposed
  `listMediatedSecret` on a probe Tool VM
- audience hosts are present in zone.egressHosts for each
  declared provider
- (Class A) refresh-token expiry observed via Google Testing-mode
  warning surface if applicable

## Out Of Scope (Deferred)

- **Class D — SigV4 / request signing.** Needs separate plan
  (see `2026-05-11-ephemeral-credential-runner-vm.md` v2 slot or a
  new SigV4 signing proxy plan).

- **Class E — CLI keyring auth.** Defer; may be solvable by adding
  bearer-mode flags per CLI. Otherwise pull into Class D's plan.

- **Host application CLIs** (Things 3 etc.). Separate plan for
  controller-host-subprocess execution pattern.

- **CLI Runner Tool VM with typed argv + output validation +
  HITL.** v2 hardening plan
  (`2026-05-11-ephemeral-credential-runner-vm.md`). Triggered by
  real need: sub-scope restrictions, HITL approval, structured
  per-operation audit, or Class D / E providers.

- **MCP Portal integration.** Independent. When MCP Portal lands,
  add a Portal provider kind that calls this broker. No work in
  this plan.

- **AWS CLI / gcloud full** as separate plan (typed SDK wrappers
  or signing proxy).

## Open Questions

- **OQ1: Audience host overlap across providers.** Currently
  `www.googleapis.com` could match multiple Google products. Is one
  shared placeholder per zone enough, or should we use per-API
  placeholders? v1 default: one placeholder per provider, all
  audience hosts under it.

- **OQ2: How many providers can one agent use simultaneously?**
  v1 default: any number, up to the env var limit. Each provider
  gets its own env var name and Gondolin secret entry.

- **OQ3: Rate limits on refresh.** Google rate limits the OAuth
  /token endpoint. With proactive refresh + keep-alive, we run
  N refreshes per day per profile. Confirm we stay under quota
  (Google: 1000 refresh requests per refresh token per day,
  typically). v1: tolerable; document.

- **OQ4: Multi-zone shared providers.** Can one credential profile
  be shared across zones, or must each zone have its own? v1
  default: per-zone profiles. Cross-zone sharing requires
  additional design.

- **OQ5: What happens to active Tool VMs when refresh fails?** If
  the access token in their env expires and refresh has failed
  (invalid_grant), subsequent CLI calls will see HTTP 401 from
  Google. Should the broker proactively close those leases, or let
  them fail-fast on next call? v1 default: let them fail-fast; the
  typed `reauth_required` event surfaces upstream.

- **OQ6: Initial bootstrap from empty 1Password vault.** If no
  credential profile is set up, validate/doctor should explain
  exactly which 1Password entries are missing, without ever printing
  values. UX detail.

## Verification Evidence (to capture during implementation)

- `pnpm check` exit code
- `pnpm test:unit` count of passed tests
- `pnpm test:smoke` count
- `pnpm test:integration` count (if test creds available)
- Manual smoke: each provider CLI call returns expected shape;
  raw token never appears in audit log, controller log, or VM
  output.
