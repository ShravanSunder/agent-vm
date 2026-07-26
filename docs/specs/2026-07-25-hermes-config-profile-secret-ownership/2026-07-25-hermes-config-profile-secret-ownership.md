# Hermes Configuration, Profile, And Secret Ownership

Status: Revised for focused review

Date: 2026-07-25

Scope: Managed Hermes common configuration, named-profile startup, stock
primary-listener ownership, direct framework state, agent-specific profile
secret projection, Discord secret custody, and focused proof expectations

## Product Intent

One managed Hermes Gateway VM serves the configured `clawfest` and `beta`
identities through stock Hermes 0.18.2, one existing Agent VM Hermes adapter,
and one common Tool Portal service.

Operators author one common non-secret Hermes configuration. Stock Hermes reads
that configuration through its native managed-configuration facility. The
root/default home and each configured named profile are native Hermes homes
under the existing direct `stateDir` RealFS mount. Their profile-local
non-secret configuration and mutable framework state survive Gateway restart.
Provider credentials remain HTTP-mediated. Each configured agent receives only
its assigned opaque provider placeholder under the stock target environment
name in its exact profile-local RAM shadow. Discord tokens are the existing
explicit raw-Gateway exception and use the same assignment surface while
remaining only in controller/VM memory and exact profile-local RAM shadows.

Success means:

- common model and fallback configuration is effective for both profiles;
- root/default and both named profiles retain native profile-local non-secret
  configuration across restart;
- `clawfest` and `beta` are the only Discord identities;
- the stock root/default service profile owns the one API/health listener but
  receives no Discord token and starts no Discord adapter;
- both Discord bots connect with their assigned identities;
- no raw provider credential enters Hermes;
- each profile resolves its assigned mediated provider placeholder, including
  when two agents use different source credentials under the same stock target
  environment name;
- no Discord token persists in durable state, an image, a backup, a log, or
  telemetry; and
- the design adds no process, plugin, supervisor, config synchronizer, or
  upstream change.

## Decision Summary

```text
deployment-authored policy
  <dedicated Hermes managed-config directory>/config.yaml
                         |
                         | existing read-only host-directory mount
                         v
Gateway VM /etc/hermes/config.yaml
  upstream Hermes managed config, common to every admitted profile

derived zone stateDir
                         |
                         | existing direct RealFS lower plus exact .env shadows
                         v
Gateway VM /home/hermes/.hermes
  config.yaml                     root/default native config and state
  profiles/clawfest/config.yaml   native profile config and state
  profiles/beta/config.yaml       native profile config and state

controller-resolved Discord values
                         |
                         | existing finalizable RAM boot input
                         v
existing Hermes adapter
  profiles/clawfest/.env exact RAM shadow
    DISCORD_BOT_TOKEN=<assigned raw Discord value>
    OPENROUTER_API_KEY=<assigned opaque mediation placeholder>
  profiles/beta/.env     exact RAM shadow
    DISCORD_BOT_TOKEN=<assigned raw Discord value>
    OPENROUTER_API_KEY=<assigned opaque mediation placeholder>

controller-resolved provider values
                         |
                         +-- raw values + allowed hosts --> Gondolin mediation
                         |
                         +-- fresh opaque placeholders --> existing adapter
                                                           profile RAM shadows
```

The stock root/default Hermes profile remains the process primary and owns the
one API/health listener. It is infrastructure, not an Agent VM agent or Discord
identity. The configured `profilesByAgent` values are the exact named bot
cohort. Existing host and adapter admission reject any undeclared named profile
before stock startup.

Host preparation creates a mode-`0600` `{}` `config.yaml` only when the
root/default or an admitted named home does not already have one. These files
activate stock Hermes's native per-home managed overlay. They are durable native
home files, never copies of `/etc/hermes/config.yaml`, and existing content is
never overwritten.

`HERMES_MANAGED_DIR` is not set. Upstream Hermes discovers its native
`/etc/hermes` managed directory. The name remains protected: deployment
runtime environment may not assign or redirect it.

`HERMES_MANAGED` is also not set by this feature. It is an unrelated upstream
package-manager mutation lock, not a configuration-directory selector.

The existing Hermes lifecycle remains the process-level authority for
multiplex startup. It sets the protected
`GATEWAY_MULTIPLEX_PROFILES=true` environment value on every managed Hermes
boot. Authored common YAML does not set `gateway.multiplex_profiles`.
`profilesByAgent` and profile-directory admission independently own the exact
named cohort.

The current optional webhook acceptance fixture is removed from common
configuration. Port-binding platforms cannot be common managed policy in a
multi-profile Hermes process because upstream applies that policy to
secondaries and rejects secondary port binders. The existing protected
`API_SERVER_*` process environment remains the sole API/health-listener
configuration and belongs to the stock root/default primary.

## Authority And Supersession

This specification supersedes the following parts of the July 23
[Hermes Discord Profile Secrets](../2026-07-23-hermes-discord-secret-mediation/2026-07-23-hermes-discord-secret-mediation.md)
contract:

- the placement of authored common Hermes YAML in the managed Gateway
  structured RAM input;
- the use of `/run/agent-vm/managed-gateway` as `HERMES_MANAGED_DIR`; and
- the `secrets.preserve_existing` authoring and adapter-validation requirement,
  which does not exist in pinned Hermes 0.18.2.

It preserves that specification's Discord custody, finalizable-memory
bootstrap, exact RAM `.env` shadows, source-environment removal, direct
`stateDir` RealFS, restart rotation, security non-goals, and no-upstream-change
contracts.

It hard-cuts from the Discord-only `discordBotTokenSecretsByAgent` field to one
Hermes-only `profileSecretProjectionsByAgent` assignment surface. There is no
compatibility parser or second projection path.

It does not supersede the root-derived zone storage contract. `stateDir`
remains the derived durable framework-state leaf, and only its existing guest
mount behavior is used.

## Exact Upstream Constraints

The managed Hermes image pins `hermes-agent[messaging]==0.18.2`, corresponding
to upstream tag `v2026.7.7.2`.

That release establishes:

1. `HERMES_HOME` selects one complete Hermes home. Named profiles are complete
   homes under `<root>/profiles/<name>`.
2. `HERMES_MANAGED_DIR` selects one machine-wide high-precedence
   `config.yaml`/`.env` overlay. When it is unset, existing `/etc/hermes` is the
   default managed directory.
3. Managed `config.yaml` merges after each profile's own configuration at leaf
   level.
4. `gateway.config.load_gateway_config()` applies the managed overlay only when
   the active home's local `config.yaml` exists.
5. Multiplex startup uses the root/default profile as its primary and enumerates
   every valid named directory as a secondary. Upstream has no named-profile
   allowlist.
6. Secondary profiles reject these port-binding platform values:
   `webhook`, `api_server`, `msgraph_webhook`, `feishu`,
   `wecom_callback`, `bluebubbles`, `sms`, `whatsapp_cloud`, and `line`.
7. A secondary profile's `SecretScope` reads its own `.env` and does not fall
   through to the process environment. Root/default primary startup reads the
   process environment before multiplex secret scoping is enabled.
8. Most gateway configuration consumers use the native managed overlay, but
   three pinned `gateway.run` readers bypass it: fallback credential resolution,
   fallback model-chain loading, and provider-routing loading.
9. `secrets.preserve_existing` is not implemented in Hermes 0.18.2.

Agent VM must preserve these constraints rather than emulate Hermes config or
launch another framework process. The existing adapter may correct only the
three pinned managed-policy read gaps through the upstream managed-overlay
helper and stock parsers.

## Authored Configuration Contract

### System configuration

A managed Hermes gateway declares:

```jsonc
{
  "gateway": {
    "type": "hermes",
    "config": "./gateways/hermes-beta/hermes-managed/config.yaml",
    "profilesByAgent": {
      "clawfest": "clawfest",
      "beta": "beta"
    },
    "profileSecretProjectionsByAgent": {
      "clawfest": {
        "DISCORD_BOT_TOKEN": "DISCORD_BOT_TOKEN_CLAWFEST",
        "OPENROUTER_API_KEY": "OPENROUTER_API_KEY_CLAWFEST"
      },
      "beta": {
        "DISCORD_BOT_TOKEN": "DISCORD_BOT_TOKEN_BETA",
        "OPENROUTER_API_KEY": "OPENROUTER_API_KEY_BETA"
      }
    }
  }
}
```

The outer keys are configured Agent VM agent IDs. Each inner key is the stock
environment name that Hermes reads from the selected profile's `SecretScope`.
Each inner value is the name of one existing same-zone `secrets` entry. The
secret names are illustrative identifiers, not resolved values or deployment
references.

`profileSecretProjectionsByAgent` is Hermes-specific. It joins three existing
authorities without replacing any of them:

```text
profilesByAgent
  owns: agent -> native profile

zones[].secrets
  owns: source, resolution, injection, audience, and mediation hosts

profileSecretProjectionsByAgent
  owns: agent + target profile environment name -> source secret name
```

The mapping:

- has exactly the same outer agent keys as `profilesByAgent`;
- uses safe environment-variable names for every target and source name;
- derives the profile from `profilesByAgent` rather than repeating it;
- permits the same mediated source secret to be assigned to any number of
  distinct target names within or across profiles;
- permits different source secrets to target the same environment name in
  different profiles;
- requires every authored Gateway-reaching HTTP-mediated zone secret to be
  referenced by at least one profile projection rather than left as an
  unscoped stock-Hermes process placeholder;
- rejects an unknown source, agent, unsafe target, reserved source name, or
  reserved target name; and
- does not reuse `agentAccess`, which remains the Tool-VM placeholder-delivery
  selector and does not own Hermes profile assignment.

Gateway-reaching uses the existing
`targetsAudience(secret.audience, "gateway")` predicate. Both `"gateway"` and
`"both"` are Gateway-reaching; `"tool-vm"` alone is not. For `"both"`,
`profileSecretProjectionsByAgent` selects the Hermes profiles while
`agentAccess` independently continues to select Tool-VM delivery. Neither
assignment grants or widens the other.

Every configured profile mapping contains exactly one `DISCORD_BOT_TOKEN`
target. Its source must use `injection: "env"` and `audience: "gateway"`.
Discord source secrets remain distinct per agent.

Every other target references a source with
`injection: "http-mediation"` and a Gateway-reaching audience. The raw provider
value remains controller/Gondolin-only; the assigned profile receives only the
fresh opaque placeholder generated for that source. An `env` source cannot
target any profile key other than `DISCORD_BOT_TOKEN`. Controller-generated
service-runtime mediation, including existing OTel transport, is not an
authored zone-secret projection and retains its existing process-level owner.

The controller creates exactly one fresh placeholder for each distinct
mediated source in one Gateway epoch. Every explicit assignment of that source
receives the same placeholder in that epoch. A later Gateway epoch creates a
different placeholder.

### Projection name and collision contract

Projection sources and targets have different collision rules.

A source name is a transient framework-environment staging name. It must not
collide with any key already present in the completely constructed Hermes
framework environment before authored mediated placeholders are added. That
environment includes raw framework-control secrets, protected lifecycle values,
OS/runtime values, deployment runtime values, and generated observability
values. Known fixed names are rejected during configuration validation; the
pre-start construction path checks the actual final environment so dynamically
generated names cannot be overwritten.

A target name must be a stock credential/application name that pinned Hermes
resolves through the active profile `SecretScope`. It must not match the pinned
Hermes process-global exact-name or prefix predicates, `API_SERVER_KEY`,
`HERMES_MANAGED`, or an Agent VM lifecycle/process-control name. A target
rejected by this rule cannot be made valid by omitting the corresponding process
environment value because the ownership boundary, not current presence, is
authoritative.

The `hermes-gateway` package owns the exported fixed source-name and target-name
predicates used by the TypeScript schema and lifecycle/controller defenses. The
adapter additionally checks the pinned upstream profile-global predicate before
materialization. The pre-start actual-environment collision check remains
required for dynamic runtime and observability keys; it is not replaced by a
second static list.

The root/default service profile is not declared in `profilesByAgent`, is not
an Agent VM identity, receives no profile projection, and receives no broader
Tool Portal authorization. The protected process-only `API_SERVER_KEY` is not a
profile projection. Root/default exists only because stock Hermes uses its
root home as the process and listener owner.

### Dedicated common-config directory

`gateway.config` must resolve to a regular file named `config.yaml` in a
dedicated real directory whose guest-visible contents are exactly that file:

```text
config/gateways/<zone>/hermes-managed/
└── config.yaml
```

The directory:

- is deployment-authored configuration, not operational storage;
- is mounted read-only at `/etc/hermes`;
- contains no `.env`, credential, secret-source bootstrap, symlink, socket, or
  unrelated sibling file;
- is not copied into `stateDir`, `/run`, rootfs, cache, or backup state; and
- remains the sole authored source of common Hermes policy.

The dedicated-directory requirement uses the existing read-only
`host-directory` managed-VM mount. Agent VM does not add a host-file mount or
expose a broader deployment config directory.

### Supported common policy

The common YAML owns non-secret settings shared by all admitted profiles,
including:

- model provider and model identifier using the pinned portable
  `model: { default: ... }` shape;
- fallback provider chain;
- reasoning and agent settings;
- the required existing Agent VM Tool Portal plugin policy;
- Discord platform behavior that is identical across profiles;
- platform toolsets for admitted non-port-binding platforms; and
- provider-routing policy without raw provider credentials.

The common YAML must not contain:

- resolved credentials, token values, 1Password references, or `.env` values;
- native Hermes 1Password or Bitwarden secret-source configuration;
- provider `api_key` values or platform token fields;
- an explicit `platforms.discord.enabled` value: named-profile tokens enable
  Discord, while root/default remains disabled; an explicit `false` would also
  block the named profiles from enabling through their tokens;
- `gateway.multiplex_profiles`, because the existing protected lifecycle
  environment enables the process-level multiplex mechanism;
- `api_server` or any other upstream port-binding platform; or
- the current webhook acceptance routes or webhook secret interpolation.

The top-level native Hermes `secrets` section is forbidden. Agent VM does not
enable Hermes 1Password, Bitwarden, managed `.env`, or another native secret
source. Each named profile's exact RAM `.env` is therefore the only Hermes
profile-secret source in this managed deployment.

The common file passes the same finite credential, environment-reference,
Discord-enable, and port-binder admission used for native-home configuration
before the Gateway VM starts.

## Directory And Ownership Map

```text
host deployment config
└── <dedicated Hermes managed-config directory>/
    └── config.yaml
        owner       operator/deployment repository
        durability  authored source
        guest       /etc/hermes/config.yaml, read-only RealFS
        backup      excluded
        secrets     forbidden

host derived stateDir
└── mounted at /home/hermes/.hermes
    ├── config.yaml
    │   owner       stock Hermes / profile-local operator state
    │   purpose     root/default native non-secret config and state
    │   durability  durable mutable RealFS
    │   mode        0600 when Agent VM creates the missing activation stub
    ├── profiles/clawfest/
    │   └── config.yaml
    └── profiles/beta/
        └── config.yaml
            owner       stock Hermes / profile-local operator state
            purpose     named-profile native non-secret config and state
            durability  durable mutable RealFS
            mode        0600 when Agent VM creates a missing activation stub
    backup      included by the existing zone backup

guest /run/agent-vm/managed-gateway/
└── framework-service.json
    owner       Agent VM controller
    purpose     per-boot adapter attachment/projection metadata
    durability  finalizable RAM only
    Hermes YAML no
    secrets     forbidden

guest /run/agent-vm/managed-gateway-environment/
└── framework.environment.sh
    owner       Agent VM controller/Gateway init
    purpose     one-shot protected service environment
    durability  finalizable RAM, source then unlink

guest RAM shadow over stateDir RealFS
├── profiles/clawfest/.env
└── profiles/beta/.env
    owner       existing Agent VM Hermes adapter
    purpose     assigned canonical profile environment
                raw DISCORD_BOT_TOKEN plus opaque mediated placeholders
    durability  VM-lifetime memory only
    mode        0600
```

`framework-service.json` remains under `/run` because it is boot-identity
metadata, not Hermes configuration or framework state. Moving it would be
unrelated path churn. The common Hermes YAML no longer shares that runtime
input directory.

## Spec Boundary And Separability Map

```text
deployment configuration
  owns:
    common non-secret Hermes YAML
    agent -> profile assignment
    agent + target profile env -> source secret-name assignment
                         |
          +--------------+------------------+
          |                                 |
          v                                 v
Agent VM lifecycle                    Agent VM controller
  validates dedicated config dir       resolves declared secrets
  mounts /etc/hermes read-only          builds mediated/raw partitions
  mounts stateDir at state root         creates exact boot metadata
  validates profile projections         creates opaque placeholders
  joins agent assignments to profiles
  enables stock multiplex mode
  through protected process env
          |                                 |
          +---------------+-----------------+
                          v
existing Agent VM Hermes adapter
  owns:
    pre-start named-profile admission
    pinned Hermes 0.18.2 managed-policy read-gap correction
    exact assigned profile RAM .env materialization
    source environment cleanup
  does not own:
    profile enumeration, primary selection, a second process,
    Hermes merge semantics, secret resolution, mediation policy,
    provider raw values, or durable state
                          |
                          v
stock Hermes 0.18.2
  owns:
    managed-config precedence
    native root/profile config parsing
    root/default process and API/health listener ownership
    named-profile multiplex startup
    profile SecretScopes
    Discord adapters, reconnect, cron, and sessions
                          |
                          v
existing Tool Portal service
  owns capability/sandbox service semantics, not Hermes profiles or secrets
```

## Profile Cohort And Primary Contract

Stock `HERMES_HOME` remains `/home/hermes/.hermes`. The root/default profile is
the process primary and owns the existing process-level `API_SERVER_*`
listener. It has no Discord `.env`, token, Agent VM projection, or Tool Portal
identity.

The configured named bot cohort is the exact set of `profilesByAgent` values.
Before stock Gateway startup, existing host preparation and adapter admission:

- require every configured named profile directory;
- reject `default` as a named assignment;
- reject missing, symlinked, non-directory, and undeclared entries under
  `profiles/`;
- require root/default and each admitted named `config.yaml` to be a real
  regular non-symlink YAML mapping;
- reject a durable legacy `gateway.json` in root/default or an admitted named
  home;
- create a mode-`0600` `{}` activation stub only when one of those files is
  absent, without overwriting an existing file;
- admit the durable configuration through the focused credential/listener
  checks below; and
- create RAM `.env` shadows only for the configured named profiles.

The existing lifecycle sets protected `GATEWAY_MULTIPLEX_PROFILES=true` before
stock startup. That switch enables Hermes's stock multiplex mechanism but does
not choose the cohort. The admitted directory set remains the cohort authority.

Stock multiplex enumeration then serves root/default plus those admitted named
profiles. No Agent VM profile-enumeration or primary-selection hook is added.

The root/default primary starts no Discord adapter because it receives no
`DISCORD_BOT_TOKEN` and common config may not explicitly enable Discord.
Named profiles load their assigned RAM `.env` through upstream `SecretScope`;
the token enables Discord for that profile and assigned opaque provider
placeholders satisfy profile-scoped provider lookup. An absent key in a
secondary scope does not fall through to the process environment. Common YAML
must not enable `api_server` or any other port-binding platform.

## Configuration Precedence

For root/default and each admitted named profile:

```text
built-in Hermes defaults
  < native profile-local durable config.yaml
  < deployment common /etc/hermes/config.yaml per-leaf overlay
```

The local file is first-class non-secret native Hermes state. Agent VM creates
only a missing empty activation stub; it does not generate, copy, merge,
synchronize, or rewrite profile-local policy. Non-overlapping local settings
survive while `/etc/hermes` wins on shared leaves.

The supported common-policy update operation is:

```text
stop Gateway -> update deployment config.yaml -> start Gateway
```

The replacement deployment file is complete, valid, admitted, and atomically
published while the Gateway is stopped. Live host mutation while Hermes runs
is unsupported. This specification adds no watcher, snapshot, cache, reload
controller, or synchronization mechanism. A fresh Gateway start reads the
current deployment file and retains the durable native home files.

For profile secrets, stock `SecretScope` reads the exact RAM-shadowed profile
`.env`. Agent VM does not enable upstream native secret sources. Raw provider
API values do not participate in Hermes config or `.env` precedence because
they remain in the existing HTTP-mediation path. Only their assigned opaque
placeholders participate in profile `.env` lookup.

## Hermes Configuration Admission

Before Gateway startup, Agent VM applies one Hermes-0.18.2-pinned admission
contract to the deployment-authored common `config.yaml` and the root/default
and admitted named native-home `config.yaml` files:

- each file is a YAML mapping, not a symlink, directory, sequence, scalar, or
  malformed document;
- the top-level native `secrets` subtree is absent;
- a non-empty value is rejected when any mapping leaf has one of these exact
  field names:
  `api_key`, `apiKey`, `apikey`, `key_env`, `keyEnv`, `api_key_env`,
  `apiKeyEnv`, `key`, `token`, `bot_token`, `auth_token`, `access_token`,
  `refresh_token`, `id_token`, `secret`, `client_secret`, `clientSecret`,
  `app_secret`, `corp_secret`, `signing_secret`, `verification_token`,
  `encrypt_key`, `password`, `password_hash`, `passwd`, `auth`,
  `authorization`, `private_key`, `bearer`, or `jwt`;
- any non-empty `extra_headers` mapping is rejected;
- explicit Discord enablement is rejected at `discord.enabled`,
  `platforms.discord.enabled`, and `gateway.platforms.discord.enabled`;
- the pinned port-binding platform names `webhook`, `api_server`,
  `msgraph_webhook`, `feishu`, `wecom_callback`, `bluebubbles`, `sms`,
  `whatsapp_cloud`, and `line` are rejected when present as top-level platform
  blocks, under `platforms`, or under `gateway.platforms`;
- durable root/default and named homes contain no `.env`, `.op.env`, or legacy
  `gateway.json`; and
- durable root/default and named homes contain none of
  `cache/op_cache.json`, `cache/bws_cache.json`, or
  `cache/bws_cache.enc.json`.

Ordinary non-secret native profile settings remain allowed. Diagnostics name
only the rejected path or field class and never include its value. This is a
finite mapping-key/path inventory, not a secret-value scanner or reproduction
of Hermes configuration semantics. Fields and paths outside this exact
inventory are not inspected for credential meaning. Admission never rewrites,
sanitizes, migrates, or deletes configuration or state. If this inventory
cannot enforce the boundary without expanding into upstream configuration
semantics, implementation must stop and reconverge.

## Pinned Hermes 0.18.2 Read-Gap Correction

The existing Agent VM Hermes adapter installs two temporary, fail-closed
bindings around stock `run_gateway()`:

1. The module-global `gateway.run.get_fallback_chain` binding applies upstream
   `managed_scope.apply_managed_overlay()` to a private copy of the raw config,
   then calls the original stock fallback parser. This covers both pinned raw
   fallback readers.
2. `GatewayRunner._load_provider_routing` reads through the pinned stock
   `gateway.run._load_gateway_config()` raw-effective-config helper and returns
   only its `provider_routing` mapping.

The adapter restores both original bindings on every normal close or failure
path. Startup fails closed when the pinned targets are absent, changed, or not
callable. The correction does not implement merge semantics, copy config, add
an authority, or change upstream Hermes; it directs the three known bypasses
through upstream's native managed overlay.

## Secret Custody Contract

### Provider and application credentials

Provider credentials use:

```text
1Password or environment source
  -> Agent VM controller memory
     -> raw value + allowed hosts in Gondolin mediation
     -> fresh opaque placeholder under the source secret name
        -> finalizable RAM framework bootstrap
        -> existing Hermes adapter
        -> assigned target name in exact profile .env RAM shadow
        -> stock Hermes profile SecretScope
        -> outbound HTTPS request
        -> Gondolin substitutes the raw value only for an allowed host
```

Hermes, its config files, profile files, process environment, Tool Portal, and
Tool VMs do not receive the raw provider value. The opaque placeholder is not a
provider credential value, but it is an assigned in-VM capability and is
projected only into selected profile RAM `.env` files. Profile projection alone
does not grant the source to Tool Portal or a Tool VM.

The existing `API_SERVER_KEY` framework-control credential remains a separate
protected raw process credential; it is not a provider value and can be neither
a source nor a target of a profile projection.

### Discord exception

Discord uses the same assignment surface but remains the only raw profile
target:

```text
1Password
  -> Agent VM controller memory
  -> finalizable RAM framework environment
  -> existing Hermes adapter
  -> exact profile .env RAM shadow
  -> stock Hermes profile SecretScope
  -> Discord HTTPS/WebSocket
```

### Adapter materialization and cleanup

The controller passes only names and assignments in
`framework-service.json`; it never serializes a raw value or placeholder into
that structured input. Raw Discord values and opaque provider placeholders
converge under their source secret names only in the existing finalizable RAM
framework environment.

The TypeScript Hermes lifecycle joins `profilesByAgent` with
`profileSecretProjectionsByAgent` and serializes the resulting profile-keyed
`profileEnvironmentSourceNamesByProfile` mapping. Its shape is profile name to
target environment name to source secret name. The Python adapter validates
that mapping against the exact admitted profile cohort; it does not own
agent-to-profile assignment. Existing agent-keyed `agentProjections` remains
separate Tool Portal/runtime identity metadata.

The adapter:

1. validates the closed profile/target/source mapping and its exact admitted
   profile cohort;
2. captures every mapped source value from its Python runtime environment;
3. removes every mapped source name from `os.environ` before starting stock
   Hermes so subsequent Python lookups and child environments derived from it
   do not inherit the staging names;
4. materializes the complete target mapping in ascending ASCII target-name
   order into each exact mode-`0600` profile RAM `.env`; and
5. starts stock Hermes only after every assigned file is complete.

Missing sources, invalid values, target collisions, cleanup failure, or a
partial write prevent stock Hermes startup and remove every shadow created by
that attempt. A failure before capture terminates the bootstrap process and
never starts stock Hermes; it does not require a cleanup supervisor.

Materialization opens only the exact admitted profile `.env` shadow paths. It
does not create a temporary, lock, journal, backup, or rename sibling beside an
exact shadow because such a sibling would fall through to the durable RealFS
lower. “Complete before stock Hermes starts” is the all-or-nothing boundary; no
filesystem rename or synchronization mechanism is implied.

Removing a name from Python `os.environ` does not claim erasure of the Linux
process's original `execve` environment memory. Resolved Discord values and
provider placeholders are intentionally present transiently inside the trusted
Gateway bootstrap process and VM RAM. Protection from guest root,
controller-authorized admin SSH, or a compromised same-VM process remains an
explicit non-goal.

The design prevents persistence and unintended cross-profile routing. It does
not protect tokens from guest root, controller-authorized admin SSH, or a
compromised process inside the shared Gateway VM.

## Observability Contract

The existing Hermes lifecycle remains the owner of process-level OTLP
environment. The existing Hermes adapter and Tool Portal instrumentation
consume that environment as separate service identities.

This specification adds no upstream Hermes instrumentation, telemetry process,
collector, or per-profile OTel bootstrap. Profile/agent identity remains
operation context supplied by the existing adapter.

Focused acceptance must show one successful operation for each configured
profile and one denied identity/isolation operation correlated across the
Hermes adapter and Tool Portal. Logs, traces, and metrics must not contain raw
credentials.

## Requirements

R1. Common Hermes YAML has one deployment-authored, non-secret source and is
read directly from a dedicated read-only `/etc/hermes` RealFS mount.

R2. Agent VM does not serialize common Hermes YAML into `/run`, `stateDir`,
rootfs, cache, or backup state and does not set `HERMES_MANAGED_DIR`.
`HERMES_MANAGED_DIR` remains a protected environment name that deployment
runtime environment cannot assign.

R3. The derived `stateDir` remains directly mounted read-write at
`/home/hermes/.hermes` for ordinary native home content. The existing shadow
composition overlays only the exact named-profile `.env` paths with tmpfs.
Root/default and named profile mutable state and non-secret configuration remain
durable with no copy-back or synchronization system.

R4. The existing protected `GATEWAY_MULTIPLEX_PROFILES=true` lifecycle
environment enables stock multiplex mode. `profilesByAgent` plus directory
admission declares the exact named bot cohort. Root/default remains an internal
service profile and is not an Agent VM identity. Common YAML does not author
`gateway.multiplex_profiles`.

R5. Existing host and adapter admission reject missing, symlinked, non-directory,
or undeclared named profile entries before stock startup. Root/default and every
admitted named home have a mode-`0600` `config.yaml`; Agent VM creates only a
missing `{}` activation stub and never overwrites an existing file. Durable
legacy `gateway.json` is forbidden in every admitted home.

R6. Root/default alone owns the process-level Agent VM API/health listener and
starts no Discord adapter. Named profiles start no port-binding platform, and
neither common nor durable profile-authored config contains a port-binding
platform, including webhook.

R7. Common model and fallback policy is effective for every configured profile
through stock Hermes managed-config precedence. The existing adapter corrects
only the three pinned Hermes 0.18.2 fallback/provider-routing read gaps and
restores its bindings on every exit path.

R8. Provider and application credentials remain HTTP-mediated and never enter
Hermes config, process environment, state, or profile files as raw values. Each
selected profile receives only its assigned opaque mediation placeholder under
the configured target name in its exact RAM `.env`. The existing protected
`API_SERVER_KEY` framework-control credential remains process-only and is
forbidden as a profile-projection source or target. Projection sources cannot
collide with the fully constructed framework environment. Projection targets
cannot match pinned Hermes process-global names/prefixes or Agent VM
lifecycle/process-control names. Focused common/durable configuration admission
rejects the exact pinned secret-source,
credential-field, credential-environment-reference, resolved-secret-cache,
Discord-enable, legacy-config, and port-binder inventory with value-free
diagnostics.

R9. `profileSecretProjectionsByAgent` is the sole Hermes profile-secret
assignment surface. It maps each configured agent and target environment name
to an existing same-zone source secret while `profilesByAgent` remains the sole
agent-to-profile authority and `zones[].secrets` remains the sole source,
injection, audience, and host-policy authority. Distinct sources may target the
same environment name in different profiles, and a mediated source may be
shared intentionally across any number of distinct target assignments within or
across profiles. Every authored Gateway-reaching HTTP-mediated zone secret is
assigned to at least one profile; Gateway-reaching includes `"gateway"` and
`"both"` through the existing audience predicate but excludes `"tool-vm"`
alone. Generated process-level service mediation is outside this projection
contract. One fresh placeholder is created per distinct mediated source per
Gateway epoch and reused for that source's explicit assignments in that epoch.

R10. Discord remains the only profile platform raw-token exception. Every
configured profile has exactly one `DISCORD_BOT_TOKEN` projection backed by a
distinct `env`/`gateway` source. All other profile projections require
`http-mediation` sources with a Gateway-reaching audience and materialize only
opaque placeholders.
The adapter removes all projection source names from its Python runtime
environment before stock Hermes starts and writes only the assigned targets
into exact mode-`0600` RAM `.env` shadows. Every file is complete before stock
Hermes starts; no secret-bearing sibling is created on the durable lower. Tool
Portal and Tool VMs receive no profile projection solely because of this
mapping.

R11. Existing process-level Hermes and Tool Portal OTel behavior remains; no
new observability architecture is introduced.

R12. The runtime topology remains one controller-managed Gateway VM, one stock
Hermes process, one existing Agent VM Hermes adapter, and one common Tool
Portal service.

R13. Common-policy updates are supported only through stop/update/start. Live
reload is unsupported, and no watcher, snapshot, cache, or synchronization
mechanism is added.

## Focused Proof Expectations

Planning must operationalize only the proof needed for these requirements:

- config and lifecycle proof covers the dedicated read-only `/etc/hermes`
  directory, direct state RealFS, unchanged finalizable secret input, absence
  of common YAML from `/run`, and rejection of unsafe config siblings,
  common/durable secret-source and exact credential fields, credential
  environment references, resolved-secret cache artifacts, explicit Discord
  enablement, legacy `gateway.json`, and profile-authored port-binding
  platforms;
- lifecycle proof rejects a deployment runtime override of the protected
  `HERMES_MANAGED_DIR` and `GATEWAY_MULTIPLEX_PROFILES` names while the
  constructed production framework environment leaves the former unset and
  sets the latter to `true`;
- configuration proof hard-cuts from `discordBotTokenSecretsByAgent`, validates
  exact projection/profile cohort parity, accepts mediated-source fanout within
  and across profiles, accepts distinct sources targeting the same stock name
  across profiles, and rejects unknown agents/sources, reserved sources,
  unsafe/reserved targets, `API_SERVER_KEY` projection, unassigned authored
  Gateway-reaching mediated sources, non-Discord raw targets, and incorrect
  injection/audience pairs; the audience matrix covers `"gateway"`, `"both"`,
  and `"tool-vm"` plus generated process-level mediation outside the authored
  completeness rule;
- source/target guard proof covers every fixed Hermes-owned reserved name,
  pinned Hermes process-global exact names and prefixes, a normal provider
  target, and a pre-start collision with one dynamically constructed runtime or
  observability environment key;
- placeholder proof shows one distinct placeholder per mediated source,
  byte-identical reuse for every assignment of one source inside an epoch,
  distinct placeholders for distinct sources, and fresh placeholders after a
  Gateway restart;
- host and adapter proof admits exactly the configured named directories,
  rejects a rogue named profile, creates missing `{}` activation stubs without
  overwriting existing native config, and preserves the exact RAM `.env`
  shadows;
- adapter proof captures raw Discord values and opaque mediated placeholders,
  removes all mapped source names from Python `os.environ`, materializes
  complete ascending-target-name profile maps with mode `0600`, opens only the
  exact shadow paths, leaves no root `.env` or secret-bearing sibling, cleans
  every created shadow after partial failure, and does not start stock Hermes
  after any failed projection;
- pinned adapter proof demonstrates the two fallback readers and provider
  routing consume the upstream managed overlay, original bindings are restored
  after success and failure, and changed/absent pinned targets fail closed;
- exact Hermes 0.18.2 loading proves root/default and both named profiles see
  the common model, fallback, provider-routing, and plugin policy while
  retaining distinct non-secret local leaves and only root/default owns
  API/health;
- one live Hermes acceptance proves both Discord profiles connect with their
  assigned identities, root/default has no Discord connection, each profile
  initiates a uniquely marked provider-authenticated turn through its real
  named Discord identity and assigned opaque placeholder, two distinct provider
  sources can satisfy the same stock target name in different profiles, each
  profile exercises a real Tool-VM-backed capability through Tool Portal, a
  controlled primary failure activates the common fallback chain, and both
  profiles reconnect after a normal Gateway restart while retained native
  config remains; root API turns, effective-config inspection, and file presence
  do not substitute for named-profile turns;
  and
- one non-production canary acceptance structurally inspects the image recipe,
  build context, and resulting image; proves provider mediation remains
  raw-value-free in the VM; scans durable state, cache, backup inputs, `/run`
  metadata outside the authorized transient inputs, Tool Portal, a real Tool
  VM, logs, traces, and metrics for absence of raw canary and generated
  placeholder bytes; and shows existing OTel correlates one success per profile
  plus one denial.

Named-profile provider attribution is a composed proof: distinct source
descriptors create distinct placeholders, exact placeholders reach exact
profile target maps, pinned `SecretScope` reads the selected named profile, a
uniquely marked real Discord turn enters through that identity, and the existing
Gondolin proof substitutes the matching raw source only for allowed hosts.
Retained evidence contains safe source/placeholder digests and operation
markers, never their values. No controlled provider service, new ingress, or
new proof process is introduced.

A supported stop/update/start acceptance changes common non-secret policy
between process lifetimes, proves the restarted root/default and named profiles
observe it, and proves their non-overlapping durable profile-local settings
remain. It does not mutate policy while Hermes is running or claim hot reload.

Pinned Hermes ignores default `/etc/hermes` discovery under pytest. Unit and
integration proof therefore uses an injected managed loader or isolated
test-only managed directory and restores that seam after each test. Only a live
runtime proof establishes production `/etc/hermes` discovery with
`HERMES_MANAGED_DIR` absent; the test seam does not authorize deployment
environment override.

This is focused config/profile/secret proof. It does not reopen lease,
replacement, Git, backup semantics, Tool Portal architecture, or the complete
PR acceptance matrix.

## Alternatives And Tradeoffs

### Accepted: one Hermes profile-secret projection map

Gain:

- one explicit agent/profile/target/source join;
- distinct provider sources may target the same stock environment name in
  different profiles;
- a mediated source may be intentionally shared across any number of explicit
  target assignments without duplicating its source, host, or injection policy;
- one collision and cohort model for Discord and provider placeholders; and
- no new runtime owner, plugin, process, mount, or secret resolver.

Cost:

- the public Hermes gateway schema and beta config hard-cut from
  `discordBotTokenSecretsByAgent`; and
- adapter materialization generalizes from one hard-coded Discord line to a
  finite assigned target map.

The projection map does not repeat `injection`, audience, hosts, or source
configuration. Those remain authoritative in `zones[].secrets`.

### Rejected: reuse `agentAccess` for Hermes profiles

`agentAccess` selects Tool-VM placeholder delivery. For `audience: "both"`, it
still scopes only the Tool-VM side while Gateway mediation remains zone-wide.
Changing that field to also select Hermes profile targets would combine two
different destinations and make its meaning depend on framework type.

### Rejected: keep the Discord map and add a provider map

Two maps would duplicate agent/profile joins, collision validation, adapter
material formats, and target ownership. The hard cut keeps the raw Discord
exception narrow through validation instead of retaining parallel paths.

### Rejected: raw provider profile projection

Only `DISCORD_BOT_TOKEN` may use an `env`/`gateway` source. Provider targets
must use HTTP-mediated sources and receive only opaque placeholders. Making raw
provider projection a generic variant would weaken the accepted custody
boundary.

### Accepted: dedicated read-only `/etc/hermes` directory

Gain:

- one authored common-config authority;
- native upstream path and merge behavior;
- direct RealFS read with no copy or stale derived state;
- no new managed-VM/Gondolin mount kind; and
- a clear separation between policy, mutable state, metadata, and secrets.

Cost:

- the authored file must move into a dedicated directory;
- that directory must remain single-purpose; and
- operators must understand that stock root/default is a service profile, not
  an Agent VM agent or Discord identity.

### Rejected: `<stateDir>/managed/config.yaml`

This keeps config under the framework state tree but creates a durable derived
copy, backup coupling, mutation ambiguity, and a synchronization/source-of-truth
question. The design does not need that cost.

### Rejected: common YAML under `/run`

This is mechanically close to the current implementation but preserves the
configuration/attachment conflation the design is correcting. `/run` remains
appropriate for per-boot Agent VM metadata and secret bootstrap, not the
operator's ordinary Hermes YAML.

### Rejected: per-profile YAML copies

Agent VM-generated replicas of common policy create multiple mutable sources
and synchronization behavior that upstream managed configuration already
shares. This does not prohibit each native Hermes home from owning its durable
profile-local `config.yaml`, subject to admission and managed-overlay
precedence.

### Rejected: mapping root/default to a bot identity

Root/default remains upstream service infrastructure. Mapping it invisibly to
`clawfest` would make storage paths, logs, session identity, and operator
reasoning disagree.

### Rejected: named primary and profile-enumeration hook

An explicit named primary would require a new public configuration field and a
pinned upstream enumeration seam solely to exclude stock root/default. Keeping
the stock root/default service primary satisfies listener ownership without
that coupling.

## Non-Goals

- A new Hermes plugin, secret-source plugin, sidecar, relay, or process.
- A controller-owned Hermes supervisor or framework lifecycle.
- Upstream Hermes, Gondolin, Discord, OpenClaw, or Tool Portal changes.
- A managed-VM host-file mount.
- Native Hermes 1Password/Bitwarden setup, `.op.env`, or secret cache.
- Secret-bearing common YAML or managed `.env`.
- A generic cross-framework secret-projection system; this contract is
  Hermes-profile-specific.
- Raw profile environment projection for anything except
  `DISCORD_BOT_TOKEN`.
- Agent VM-generated common-policy copies in native homes, or per-profile YAML
  merge, synchronization, or rewrite.
- Config migration, compatibility, legacy lookup, copy-back, recovery, or
  rollback machinery.
- Webhook acceptance or another port-binding platform in the common profile
  cohort.
- Live Discord-token rotation without Gateway restart.
- Live common-policy reload, watching, snapshots, or process-lifetime policy
  generation pinning.
- Hostile-process isolation between profiles inside one shared Gateway VM.
- Broader lease, Tool VM, Git, workspace, backup, storage, or observability
  redesign.
- Implementation ordering, worker assignments, or exact validation commands.

## Stop And Reconverge Conditions

Stop before implementation expands the design if:

- `/etc/hermes` cannot be represented through the existing read-only
  host-directory mount without exposing files beyond the dedicated config
  directory;
- common fallback loading still bypasses the exact managed config after the
  two bounded fallback bindings, or provider routing still bypasses the stock
  managed loader after its bounded correction;
- durable-config admission requires a generic Hermes parser, value scanner,
  sanitizer, or reproduction of upstream configuration semantics;
- root/default attempts to start Discord without a token, or a named secondary
  inherits or starts the primary API listener despite its upstream
  `SecretScope`;
- stock Hermes requires a durable Discord `.env` lower file;
- a named profile cannot use an assigned opaque HTTP-mediation placeholder
  through its stock `SecretScope`;
- projection sources cannot be kept disjoint from the actual final framework
  environment, or projection targets cannot be kept disjoint from pinned
  process-global and Agent VM lifecycle/process-control names before startup;
- satisfying source cleanup requires a launcher, supervisor, extra process, or
  claim of kernel-memory erasure rather than the accepted Python-runtime
  cleanup boundary;
- satisfying the contract requires a new process, plugin, supervisor,
  managed-VM mount kind, upstream change, or secret persistence; or
- an unrelated failing proof requires changing lease, backup, Tool Portal,
  CI, runner, or deployment architecture.

## Source Anchors

Local source:

- [Hermes lifecycle](../../../packages/hermes-gateway/src/hermes-lifecycle.ts)
- [Hermes host profile preparation](../../../packages/hermes-gateway/src/hermes-profile-directory-materialization.ts)
- [Hermes managed config parser](../../../packages/hermes-gateway/src/hermes-managed-configuration.ts)
- [managed Gateway boot input materializer](../../../packages/agent-vm/src/gateway/managed-gateway-boot-input-materializer.ts)
- [Gateway secret split](../../../packages/gateway-lifecycle/src/split-resolved-gateway-secrets.ts)
- [managed Gateway secret projection](../../../packages/agent-vm/src/gateway/gateway-zone-orchestrator.ts)
- [managed VM mount contract](../../../packages/managed-vm/src/managed-vm-contracts.ts)
- [existing Hermes adapter bootstrap](../../../python/agent-vm-hermes-adapter/src/agent_vm_hermes_adapter/managed_gateway_bootstrap.py)
- [system configuration](../../../packages/agent-vm/src/config/system-config.ts)

Exact upstream release:

- `NousResearch/hermes-agent`
- tag `v2026.7.7.2`
- commit `9de9c25f620ff7f1ce0fd5457d596052d5159596`
- package version `0.18.2`
- decisive files: `hermes_cli/managed_scope.py`,
  `hermes_cli/profiles.py`, `hermes_constants.py`, `gateway/config.py`,
  `gateway/run.py`, `agent/secret_scope.py`, and
  `hermes_cli/fallback_config.py`;
- pinned direct-read seams: `gateway/config.py:994-1005`,
  `gateway/run.py:1949-1954`, and `gateway/run.py:4961-4984`.

## Open Decisions

None.
