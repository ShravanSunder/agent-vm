> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not implement MCP Portal again; treat the existing MCP Portal layer as the completed agent-facing capability surface.

# Credentialed Tool VM Runner With Gondolin vm.exec

Status: superseded / reference-only. Do not execute this plan directly.

Superseded by:
- `docs/superpowers/plans/2026-05-20-credentialed-tool-system.md` for the broader credentialed tool target architecture.
- `docs/superpowers/plans/2026-05-22-gondolin-adapter-tool-vm-ssh-cleanup.md` for the prerequisite Gondolin adapter widening that makes native `vm.exec` / `vm.fs` usable through agent-vm.

Still useful as background:
- Gondolin `vm.exec()` SDK notes and constraints.
- Early boundary notes that credentialed CLI execution must not run in the gateway VM or the standard agent-controlled Tool VM.

Do not use this for:
- The next executable credentialed runner implementation plan.
- Lease/capability type design.
- OpenClaw Tool VM SSH or filesystem bridge design.

**Goal:** Add schema-driven credentialed CLI tools behind MCP Portal. Agents continue to use `mcp_portal_list`, `mcp_portal_search`, `mcp_portal_describe`, and `mcp_portal_call`; credentialed CLIs appear as portal namespaces and run inside controller-created credentialed Tool VMs via Gondolin `vm.exec()`, never in the gateway VM and never in the standard agent Tool VM.

## Loaded Context

Read this before implementing. Do not skim it.

- `https://earendil-works.github.io/gondolin/sdk-vm/#vmexec`
  - Full SDK VM Control page loaded end to end, lines 0-278.
  - `vm.exec()` returns an `ExecProcess`.
  - Awaiting the process yields an `ExecResult`.
  - String form runs through `/bin/sh -lc`.
  - Array form executes directly and does not search `$PATH`; the executable path must be absolute.
  - Non-zero exit codes do not throw. Callers must check `result.ok` or `result.exitCode`.
  - Streaming requires `stdout: "pipe"` and/or `stderr: "pipe"`.
  - Piped streams are not buffered into the final `ExecResult`.
  - `buffer: false` drops stdout/stderr unless explicitly piped.
  - `ExecOptions.signal` rejects the local promise with `exec aborted`, but the docs state it does not yet guarantee guest process termination.

- Local Gondolin SDK 0.9.1 inspection:
  - `node_modules/.pnpm/@earendil-works+gondolin@0.9.1/node_modules/@earendil-works/gondolin/dist/src/vm/core.d.ts`
  - `node_modules/.pnpm/@earendil-works+gondolin@0.9.1/node_modules/@earendil-works/gondolin/dist/src/exec.d.ts`
  - `node_modules/.pnpm/@earendil-works+gondolin@0.9.1/node_modules/@earendil-works/gondolin/dist/src/vm/core.js`
  - `node_modules/.pnpm/@earendil-works+gondolin@0.9.1/node_modules/@earendil-works/gondolin/dist/src/exec.js`

- Current agent-vm adapter inspection:
  - `packages/gondolin-adapter/src/vm-adapter.ts`
    - Current `ManagedVm.exec(command: string)` exposes only string shell exec.
    - Credentialed runner needs a new direct exec method or an overloaded exec shape for array-form commands and `ExecOptions`.
  - `packages/agent-vm/src/tool-vm/tool-vm-lifecycle.ts`
    - Existing Tool VM creation is the lifecycle pattern to reuse and extend.
  - `packages/mcp-portal/src/portal-session.ts`
  - `packages/mcp-portal/src/mcp-server/portal-tools.ts`
  - `packages/mcp-portal/src/bin/portal-server.ts`
    - MCP Portal already has the correct agent-facing list/search/describe/call model.
    - Credentialed tools should extend the provider/runtime side, not add new agent-facing portal tools.

## Non-Negotiable Boundaries

1. The agent never receives raw credentials, refresh tokens, cloud tokens, CLI cache files, or runner VM control handles.
2. The standard agent Tool VM never runs the credentialed CLI.
3. The gateway VM never runs the credentialed CLI.
4. MCP Portal remains the agent-facing tool surface.
5. Credentialed CLI execution happens in a credentialed Tool VM created and owned by controller-side code.
6. Model-supplied values never become shell text. Registered CLI execution uses `vm.exec([absoluteExecutablePath, ...argv], options)`.
7. Timeout handling must close or destroy the credentialed Tool VM. `AbortSignal` alone is insufficient because Gondolin currently documents that aborting does not guarantee guest process termination.
8. Every function/tool call is validated before VM creation. Unknown function names, denied tools, invalid schemas, forbidden argv, forbidden paths, and unauthorized credential profiles fail closed without running a command.
9. The only model-controlled execution input is the registered function's typed arguments. For `exec`, that means argv values only. Identity, executable path, cwd, env, mounts, credential profile, state profile, and output/writeback destinations are controller/config owned.
10. No agent path may open arbitrary SSH, shell, or TCP traffic into a credentialed Tool VM. V1 uses controller-side `vm.exec()` only.

## Naming Model

Use Tool VM as the umbrella concept:

```text
standard Tool VM
  Current OpenClaw sandbox Tool VM.
  Agent shell commands run here.
  Workspace is writable.
  Credentials are mediated or absent.

credentialed Tool VM
  New Tool VM profile/class for credentialed provider CLIs.
  Agent cannot shell or SSH into it.
  Workspace is read-only when mounted.
  Credentials may be real but are scoped to one registered call.
```

Use credentialed runner for the package/backend:

```text
packages/credential-runner
POST /zones/:zoneId/credential-runner/execute
```

The runner name describes the control path. The VM remains a Tool VM variant.

## Architecture

```text
Agent in standard Tool VM
  |
  | mcp_portal_list/search/describe/call
  v
MCP Portal in gateway VM
  |
  | provider runtime dispatch
  v
@agent-vm/credential-runner provider adapter
  |
  | authorize zone + agent + profile + namespace + toolName
  v
agent-vm controller credentialed runner backend
  |
  | create credentialed Tool VM, mount approved state, inject approved env
  v
Gondolin credentialed Tool VM
  |
  | vm.exec([absoluteExecutablePath, ...argv], execOptions)
  v
CLI process
```

Important: the gateway VM participates in routing because MCP Portal lives there, but it does not execute the CLI. The process boundary is the credentialed Tool VM.

This is a sibling of the existing lease/SSH Tool VM pattern, not a replacement for it.

```text
standard Tool VM path today:
  gateway plugin -> lease controller once -> SSH to Tool VM for shell commands

credentialed Tool VM v1:
  gateway portal -> controller execute request -> controller vm.exec into Tool VM
```

V1 keeps controller in the per-call path because the controller owns the Gondolin VM object and can enforce timeout-by-close. Later warm/persistent variants can reuse more lease-manager machinery.

## Reuse Existing Tool VM Machinery

Do not build a totally separate VM subsystem if the existing Tool VM machinery can be parameterized.

Reuse candidates:

- Tool VM image profiles.
- Tool VM profile parsing and validation.
- Managed image build path.
- Lease/slot bookkeeping concepts.
- `tcpHosts` slot allocation when a future persistent/service mode needs network routing.
- Work mount validation for read-only workspace mounts.
- Gondolin adapter and `createManagedVm`.

New credentialed-specific behavior:

- Credentialed Tool VM profile flags:
  - `role: "credentialed"`
  - `transport: "vmexec"` for v1
  - `workspaceAccess: "readonly" | "none"`
  - `exchangeMount: true`
  - `credentialMaterialization: "env" | "file"`
  - `rootfsMode: "cow"` by default
- No SSH handle is returned to the gateway or agent.
- No arbitrary shell command API is exposed.
- No scope-cached shell session in v1.
- Only registered credentialed runner calls can create and execute in the VM.

This lets existing systems such as OpenClaw, MCP Portal, and later `agent-vm-worker` share one credentialed runner contract without duplicating security validation.

## Package Structure

Add one composable package:

```text
packages/credential-runner
```

Responsibilities:

- Own credentialed CLI registry schemas and validation.
- Generate MCP-compatible tool records for each registered CLI namespace.
- Implement tool handlers for `help`, `search_help`, `exec`, and optionally `exec_many`.
- Expose an SDK/runtime interface that `@agent-vm/agent-vm` can back with Gondolin VM creation.
- Keep execution schema-driven. Operators should configure CLIs in JSONC; they should not have to write TypeScript for each CLI.

Keep existing packages responsible for their current layers:

```text
packages/config-contracts
  Shared JSONC/Zod schemas for MCP provider config and credentialed runner registry.

packages/mcp-portal
  Agent-facing portal tools, catalog/search/session policy, provider runtime composition.

packages/agent-vm
  Controller integration, credentialed Tool VM lifecycle, image/profile lookup, secret resolution, doctor/validate.

packages/openclaw-mcp-portal-plugin
  OpenClaw wiring only. It should not know credentialed CLI internals.
```

## Config Model

Use the existing MCP Portal config split:

```text
config/gateway/<zone>/mcp.config.jsonc
  provider catalog: what upstream namespaces exist

config/gateway/<zone>/mcp-portal.config.jsonc
  profile policy: which agents can see which namespaces/tools

system.jsonc
  zone agents and per-agent profile selections, parallel to existing Tool VM profile mapping
```

Do not add a separate agent-facing credentialed tools profile file.

Credentialed CLIs should be provider entries in the provider catalog. This keeps one capability directory and avoids a second list/search model.

Example shape to refine during implementation:

```jsonc
{
  "$schema": "../../schemas/mcp.schema.json",
  "schemaVersion": 1,
  "providers": {
    "gog": {
      "kind": "credentialed-cli",
      "namespace": "gog",
      "description": "Google operations through the approved gog CLI.",
      "runner": {
        "toolVmProfile": "credentialed-small",
        "imageProfile": "credentialed-tools",
        "credentialProfile": "shravan-google",
        "stateProfile": "google-cli-state"
      },
      "cli": {
        "executable": "/usr/local/bin/gog",
        "workingDirectory": "/work",
        "help": {
          "argv": ["--help"],
          "timeoutMs": 10000
        },
        "exec": {
          "timeoutMs": 60000,
          "maxStdoutBytes": 1048576,
          "maxStderrBytes": 262144,
          "argumentsSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "argv": {
                "type": "array",
                "items": { "type": "string" },
                "minItems": 1
              }
            },
            "required": ["argv"]
          }
        }
      }
    }
  }
}
```

This is intentionally CLI-level, not calendar-level. `gog` is the namespace. The registry should not require hand-authored TypeScript per command.

## MCP Tool Surface For A Credentialed CLI Namespace

For namespace `gog`, the provider exposes:

```text
gog.help
gog.search_help
gog.exec
```

Optional later:

```text
gog.exec_many
```

Do not add separate portal tools named `secure_tool_call` or `credential_runner_execute`.

`mcp_portal_list` and `mcp_portal_search` already accept multiple requests. `mcp_portal_call` already accepts multiple calls. Use that batching first. Add `exec_many` only if we need ordered commands in the same credentialed Tool VM with shared temporary state.

`mcp_portal_call` batching is parallel and independent. It does not imply ordering, a shared credentialed Tool VM, shared cwd, or shared filesystem state. Ordered CLI sequences require `exec_many` or a later explicit session model.

### Tool Descriptions

`help`:

```text
Return approved help text for the gog CLI. This command runs only the configured help argv inside a credentialed Tool VM and never executes model-supplied shell text.
```

`search_help`:

```text
Search cached or freshly collected help material for the gog CLI. Use this before exec when you need flags, subcommands, or output format details.
```

`exec`:

```text
Run an approved gog CLI invocation inside a credentialed Tool VM. Provide argv as an array of arguments only; the executable path is fixed by configuration. The runner returns exitCode, ok, stdout, stderr, and truncated flags. Unauthorized or unauthenticated calls fail before a VM command is executed.
```

## Provider Runtime Boundary

MCP Portal should depend on a provider runtime abstraction, not only on upstream MCP client runtime.

Proposed shape:

```ts
interface PortalProviderRuntime {
  listTools(call: {
    readonly agentScopeId: string;
    readonly identity: PortalAgentIdentity;
    readonly namespace: string;
  }): Promise<readonly Tool[]>;

  callTool(call: {
    readonly agentScopeId: string;
    readonly identity: PortalAgentIdentity;
    readonly namespace: string;
    readonly toolName: string;
    readonly arguments: JsonObject;
  }): Promise<unknown>;

  closeAgentScope(agentScopeId: string): Promise<void>;
  closeSession(scopeKey: string): Promise<void>;
}
```

Implementations:

```text
UpstreamMcpProviderRuntime
  Existing MCP client runtime for kind: "mcp".

CredentialedCliProviderRuntime
  New adapter for kind: "credentialed-cli".
  Synthesizes MCP tools from registry config.
  Calls controller credentialed runner execute API.

CompositePortalProviderRuntime
  Routes namespace -> provider implementation.
```

This keeps MCP Portal's agent-facing API stable while letting provider kinds differ internally.

## Controller API Contract

Portal runs in the gateway VM. Credentialed Tool VM creation belongs to the controller. The gateway-to-controller request must be explicit and authenticated.

Route:

```text
POST /zones/:zoneId/credential-runner/execute
```

Headers:

```text
Authorization: Bearer <gateway-controller-token>
Content-Type: application/json
```

Request body:

```jsonc
{
  "requestId": "portal-call-id",
  "agentId": "shravan",
  "agentScopeId": "shravan-session-scope",
  "portalSessionId": "optional-mcp-session-id",
  "mcpProfile": "shravan-default",
  "providerNamespace": "gog",
  "toolName": "exec",
  "arguments": {
    "argv": ["calendar", "list", "--json"]
  }
}
```

Security rules:

- `agentId`, `agentScopeId`, `portalSessionId`, and `mcpProfile` are server-side fields populated by MCP Portal from its authenticated endpoint/session/profile records.
- The model never supplies those fields as tool arguments.
- Controller re-validates that the gateway is allowed to speak for the zone.
- Controller re-validates that `agentId` exists in the zone and is bound to the supplied MCP profile.
- Controller re-validates that the MCP profile allows `providerNamespace.toolName`.
- Controller derives `credentialProfile`, Tool VM profile, image profile, mounts, env, egress, and cwd from config. These are never accepted from the request body.

Response body:

```jsonc
{
  "runId": "credentialed-run-...",
  "ok": true,
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "exchangePath": "/credentialed-tool-runs/credentialed-run-.../output",
  "artifacts": []
}
```

Typed controller errors:

```text
unknown_or_denied_tool
invalid_tool_arguments
unauthorized_agent
unauthorized_mcp_profile
unauthorized_credential_profile
forbidden_argument
forbidden_path
forbidden_environment
auth_required
reauth_required
credential_profile_unavailable
credentialed_tool_vm_failed
credentialed_tool_vm_timeout
```

## Call Validation Security Contract

Credentialed runner validation is not one check. It is a chain of fail-closed checks, and all checks happen before `vm.exec()` except output redaction/truncation.

Call path:

```text
mcp_portal_call(namespace, toolName, arguments)
  -> portal scoped catalog lookup
  -> portal argument schema validation
  -> credentialed runner registry lookup
  -> credentialed runner authorization check
  -> credentialed runner function contract validation
  -> argv/path/env policy validation
  -> create credentialed Tool VM
  -> vm.exec([absoluteExecutablePath, ...argv], options)
```

Required checks:

- Namespace and tool name must exactly match a generated tool from the agent-scoped portal catalog.
- MCP Portal must reject unknown or denied tools before calling the provider runtime.
- Credentialed runner must independently look up `namespace + toolName` in its registry. It must not trust that Portal already checked.
- Credentialed runner must verify the caller identity from server-side context. It must not accept `agentId`, `profile`, `credentialProfile`, or `zoneId` from model-visible arguments.
- `toolName` must be one of the generated functions for that CLI namespace: `help`, `search_help`, `exec`, and optionally `exec_many`.
- `arguments` must validate against the configured JSON Schema for that generated function.
- `exec.arguments.argv` must be an array of strings. No object-to-string coercion, no shell fragments, no command string field.
- `cli.executable` must be an absolute path from config, not from call arguments.
- `cwd`, env keys, secret refs, mounts, and credential profile must come from config/controller policy, not call arguments.
- Path argv values must be validated declaratively against the provider's path policy before the VM runs.
- Dangerous flags must be blockable by schema/config. The registry needs `deniedArgs`, `deniedArgPrefixes`, or equivalent policy so providers can reject flags like alternate credential file paths, config directories, proxy settings, or token output modes.
- Help commands are also validated. `help.argv` is operator-authored config, not model-supplied argv.
- If validation fails, return a typed error and do not create the credentialed Tool VM.

Declarative path policy:

- CLI argv strings are opaque by default.
- Do not globally infer whether an argv string is a path.
- Config must declare which flags or positional indexes accept workspace paths.
- Only declared path arguments are normalized and checked against the workspace mount policy.
- Undeclared path-like strings remain ordinary strings and must not grant filesystem access.

Example:

```jsonc
{
  "argvPolicy": {
    "deniedArgs": ["--credential-file", "--token", "--print-token"],
    "deniedArgPrefixes": ["--config=", "--credentials=", "--proxy="],
    "pathArguments": [
      {
        "kind": "flagValue",
        "flag": "--input",
        "base": "workspace",
        "access": "read"
      },
      {
        "kind": "positional",
        "index": 1,
        "base": "workspace",
        "access": "read"
      }
    ]
  }
}
```

Typed validation errors:

```text
unknown_or_denied_tool
invalid_tool_arguments
unauthorized_cli
unauthorized_credential_profile
forbidden_argument
forbidden_path
forbidden_environment
auth_required
reauth_required
credential_profile_unavailable
```

Security tests must prove:

- Unknown `namespace + toolName` does not reach the credentialed runner.
- Unknown generated credentialed function does not reach VM creation.
- Invalid argv schema does not reach VM creation.
- Forbidden argv does not reach VM creation.
- Model-supplied `agentId`, `zoneId`, `credentialProfile`, `executable`, `cwd`, or env keys are rejected if present.
- Non-zero CLI exit returns a result and does not look like a transport failure.
- Timeout closes the VM.
- All failures redact secret-shaped values.

## Output And File Change Contract

The credentialed runner must not let a credentialed CLI silently mutate the standard agent workspace.

V1 should keep file handling simple:

- Credentialed Tool VM may mount the agent workspace read-only at a fixed path such as `/workspace`.
- Credentialed Tool VM may mount a separate run output directory read-write at a fixed path such as `/out`.
- The output directory is not inside the agent workspace.
- The standard agent Tool VM can inspect published output after the credentialed run.
- The standard agent Tool VM remains responsible for applying any file changes to its writable workspace.
- The credentialed Tool VM never mounts the live agent workspace read-write in v1.

Simple file-capable flow:

```text
agent asks to run registered CLI with typed args
  -> controller validates argv and any workspace path args
  -> controller starts credentialed Tool VM
  -> credentialed Tool VM sees /workspace read-only
  -> credentialed Tool VM writes files only under /out
  -> controller closes credentialed Tool VM
  -> controller publishes /out as a per-run exchange directory
  -> agent Tool VM reads the exchange directory
  -> agent applies any wanted changes through normal workspace tools
```

Host layout example:

```text
runtime/credentialed-tool-runs/<zone>/<agent>/<runId>/
  output/
    result files written by the credentialed Tool VM
  metadata.json
```

Guest mounts:

```text
credentialed Tool VM:
  /workspace  read-only RealFS view of the agent workspace, optional per provider
  /out        writable RealFS output directory for this credentialed run

agent Tool VM:
  /credentialed-tool-runs/<runId>/output  read-only or read-write exchange view
```

Publishing rule:

- Do not mount the same mutable output directory into the standard Tool VM while the credentialed Tool VM is still running.
- The controller publishes the run output after the credentialed Tool VM exits.
- Published output may be mounted read-only into the agent Tool VM, or returned as artifact metadata through MCP Portal.
- If the agent Tool VM needs to edit the exchange copy before applying it, expose a copied scratch view rather than the original run output.

Recommended output policy shape:

```jsonc
{
  "outputs": {
    "mode": "exchange-directory",
    "baseDir": "/out",
    "include": ["**/*"],
    "maxFileBytes": 1048576,
    "maxTotalBytes": 5242880,
    "inlineTextMaxBytes": 65536
  }
}
```

Runner result shape:

```jsonc
{
  "runId": "credentialed-run-...",
  "ok": true,
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "exchangePath": "/credentialed-tool-runs/credentialed-run-.../output",
  "artifacts": [
    {
      "artifactId": "artifact-...",
      "path": "report.json",
      "mediaType": "application/json",
      "sizeBytes": 1234,
      "sha256": "...",
      "inlineText": "{...}"
    }
  ]
}
```

Artifact rules:

- Artifact paths are relative to the configured output base directory.
- Reject absolute paths, parent traversal, symlinks escaping the output base, device files, sockets, and oversized files.
- Small text artifacts may be returned inline.
- Large or binary artifacts are stored in controller-managed runtime state and returned by `artifactId`.
- Artifact contents must pass the same redaction boundary as stdout/stderr before inline return.
- Artifacts and exchange files are read-only outputs by default. Applying them to the agent workspace is an explicit agent action using normal workspace tools.

Writeback policy:

- V1 should not directly write credentialed runner outputs into the agent workspace.
- The credentialed Tool VM writes only to `/out`.
- If direct writeback is added later, it must be a separate approved tool/function with destination path validation.
- Never mount the agent workspace read-write into a credentialed Tool VM in v1.

## Gondolin vm.exec Contract

The credentialed runner backend must call Gondolin like this:

```ts
const proc = credentialedToolVm.exec([config.cli.executable, ...argv], {
  cwd: config.cli.workingDirectory,
  env: resolvedEnv,
  stdout: "pipe",
  stderr: "pipe",
  windowBytes: config.cli.exec.windowBytes ?? 256 * 1024,
});
```

Rules:

- Use array form for all model-influenced argv.
- Require an absolute `cli.executable` path at config validation time.
- Never use string-form `vm.exec()` for `exec` calls.
- String-form `vm.exec()` may be allowed only for fixed operator-authored setup scripts with no model-supplied interpolation.
- Treat non-zero exit as a normal result, not an exception.
- Return `exitCode`, `ok`, `stdout`, `stderr`, `stdoutTruncated`, `stderrTruncated`, `durationMs`, and a stable `runId`.
- If stdout/stderr may be large, stream and enforce byte limits yourself. Do not rely on buffered mode for unknown CLI output.
- If a timeout fires, abort the local wait and close the credentialed Tool VM. Closing/destroying the VM is the actual kill boundary.
- On runner failure, redact credentials before returning errors to MCP Portal.
- Redact inside the credentialed runner before returning to MCP Portal. Portal may not know short-lived token values or credential files injected into the credentialed Tool VM.

## Adapter Work Required

Current `ManagedVm.exec` is too narrow:

```ts
exec(command: string): Promise<ExecResult>
```

Add one of these:

```ts
exec(command: string | readonly string[], options?: ManagedExecOptions): ManagedExecProcess
```

or:

```ts
exec(command: string): Promise<ExecResult>
execDirect(command: readonly [string, ...string[]], options?: ManagedExecOptions): ManagedExecProcess
```

Prefer `execDirect` if changing existing call sites would create churn. The credentialed runner can depend on `execDirect` and existing code can keep using string `exec`.

The managed adapter should expose enough of Gondolin `ExecProcess` to stream stdout/stderr and close the VM on timeout. It does not need to expose interactive `attach()` for credentialed runner v1.

## Credentialed Tool VM Lifecycle

V1 should use one credentialed Tool VM per `exec` call.

Flow:

1. MCP Portal receives `mcp_portal_call`.
2. Portal resolves the agent server-side.
3. Portal policy rejects unknown or denied namespace/tool before provider execution.
4. Credentialed runner provider validates arguments against the provider registry schema.
5. Controller-side runner authorizes zone, agent, MCP profile, credentialed provider, and credential profile.
6. Controller creates a credentialed Tool VM with:
   - approved credentialed tool image
   - approved memory/CPU profile
   - optional read-only agent workspace mount
   - per-run `/out` exchange mount
   - optional encrypted or isolated RealFS state mount for non-secret CLI state
   - short-lived credential material only when required
   - egress limited to provider hosts
7. Runner calls `vm.exec()` array form.
8. Runner streams and bounds output.
9. Runner closes the VM regardless of success, non-zero exit, timeout, or exception.

Persistent or warm credentialed Tool VMs can be a later optimization only after we have per-agent/profile partitioning, idle TTL, and cleanup tests.

Rootfs should use `cow` for the credentialed Tool VM profile unless a test explicitly opts into `memory`.

## SSH And Network Constraints

Gondolin `tcpHosts` is just TCP forwarding. SSH, HTTP, MCP, and any other TCP protocol can ride over it. That flexibility is useful, but credentialed Tool VMs must not expose arbitrary protocols to agents.

V1 rules:

- Credentialed Tool VM execution is passive: controller owns the VM object and calls `vm.exec()`.
- Do not expose sshd from the credentialed Tool VM to the gateway, standard Tool VM, or agent.
- Even if the credentialed image contains sshd for debugging or future work, v1 must not start it, publish a route to it, or return SSH identity material for it.
- Do not give the standard Tool VM a `tcpHosts` route to the credentialed Tool VM.
- Do not allow gateway plugin code to open arbitrary TCP or SSH into the credentialed Tool VM.
- Network egress from the credentialed Tool VM is provider-scoped and config-owned.
- Inter-VM routes for credentialed Tool VMs are absent by default.

Future HTTP/MCP service mode:

- If a credentialed Tool VM later hosts an internal service, expose only a typed service endpoint.
- The service must enforce the same registry/schema/argv/path/credential validation.
- It must not expose shell, SSH, arbitrary subprocess, or raw TCP forwarding.
- tcpHosts entries must be explicit per source VM and per destination service.
- Agent-visible arguments still cannot include identity, profile, executable, cwd, env, mount, or credential fields.

## Auth And Refresh

Do not put OAuth refresh tokens or long-lived credentials into the standard Tool VM.

Preferred v1:

- Controller-side credential broker resolves and refreshes tokens.
- Credentialed Tool VM receives only the short-lived access token or a minimal credential file needed for that one call.
- If refresh-token rotation occurs, the broker is the single writer back to 1Password or the configured source.
- If auth is missing or revoked, fail immediately with a typed result:
  - `auth_required`
  - `reauth_required`
  - `credential_profile_unavailable`
  - `unauthorized_cli`

Encrypted RealFS remains useful for non-secret CLI state:

- selected project/account defaults
- cached help indexes
- harmless CLI preferences
- short-lived temp files that survive VM restart only when explicitly configured

Do not rely on encrypted RealFS as the only protection for refresh tokens in v1. Encryption at rest does not protect tokens while the credentialed Tool VM is running.

## Portal Integration

MCP Portal should keep its agent-facing API unchanged.

Implementation options:

1. Extend the provider runtime so `mcp.config.jsonc` supports `kind: "credentialed-cli"` providers. The provider adapter uses `@agent-vm/credential-runner` to synthesize MCP tools and dispatch calls to the controller credentialed runner backend.
2. Alternatively expose `@agent-vm/credential-runner` as a Streamable HTTP MCP server and configure it as a normal `kind: "mcp"` provider. If this path is chosen, add a server-side identity channel from MCP Portal to the credentialed runner. Do not accept model-supplied `agentId`.

Decision for v1: prefer option 1 unless we already have a clean, hidden identity-bearing MCP transport from Portal to the controller. It keeps agent identity server-side and avoids a static gateway bearer token becoming the only defense around credentialed CLI execution.

The public behavior is the same either way: agents see credentialed CLIs through MCP Portal list/search/describe/call.

## Validation And Doctor

Add validation for:

- `credentialed-cli` executable is absolute.
- `credentialed-cli` namespace is unique across all providers.
- `credentialed-cli` argument schema is a JSON object schema.
- `credentialed-cli` generated function names are reserved and cannot collide with operator-defined aliases.
- `credentialed-cli` timeouts and output byte limits are positive and bounded.
- `credentialed-cli` argv policy blocks configured denied args and denied prefixes.
- `credentialed-cli` path policy is declarative and does not infer paths globally.
- `credentialed-cli` runner Tool VM profile references an existing credentialed Tool VM profile.
- `credentialed-cli` image profile references a managed image that contains the configured executable.
- Every agent that is allowed a credentialed CLI namespace has a valid MCP Portal profile binding.
- A credentialed CLI provider cannot be exposed to a worker zone unless worker adapter support is explicitly implemented.
- No credentialed CLI credential profile is mounted into the standard Tool VM or gateway workspace.
- No credentialed Tool VM exposes SSH, shell, or arbitrary TCP routes to agent-controlled code in v1.

Doctor should report:

- credentialed CLI providers discovered
- agents allowed for each credentialed CLI namespace
- credentialed Tool VM image/profile validity
- whether the executable exists in the credentialed tool image when image inspection is available
- auth profile availability without printing secret values
- egress hosts for the credentialed Tool VM

## Implementation Steps

- [ ] Create `packages/credential-runner`.
  - Registry schemas.
  - Tool generation for `help`, `search_help`, `exec`.
  - Function and argument validation before runtime dispatch.
  - Argv, path, env, mount, and credential profile policy checks.
  - Output truncation/redaction helpers.
  - Runtime interfaces for VM execution and credential resolution.

- [ ] Add credentialed provider schema to `packages/config-contracts`.
  - Extend MCP provider config as a discriminated union of upstream MCP providers and credentialed CLI providers.
  - Keep JSON Schema generation canonical.
  - Add tests for absolute executable path, namespace uniqueness, output limits, and argument schema.

- [ ] Extend `packages/gondolin-adapter`.
  - Add direct array-form exec support without forcing shell execution.
  - Expose enough streaming and result metadata for credentialed runner.
  - Add tests proving array-form exec passes argv without shell interpolation.

- [ ] Add controller credentialed Tool VM backend in `packages/agent-vm`.
  - Build credentialed Tool VM from profile/image.
  - Mount approved state only.
  - Resolve short-lived auth material.
  - Enforce timeout by closing the VM.
  - Always close VM in `finally`.

- [ ] Connect MCP Portal provider runtime.
  - Add `PortalProviderRuntime` and a composite runtime.
  - `listTools` includes credentialed CLI generated tools in the scoped catalog.
  - `callTool` dispatches credentialed CLI calls to the credentialed runner backend.
  - Denied tools never enter catalog/search.
  - No model-supplied agent ID or credential profile is accepted.

- [ ] Add validation and doctor coverage.
  - `agent-vm validate` checks config structure and cross-references.
  - OpenClaw deployment doctor reports credentialed runner readiness.

- [ ] Add docs.
  - Update `docs/subsystems/mcp-portal.md` with credentialed CLI as a provider class, not a new agent-facing API.
  - Add `docs/subsystems/credential-runner.md`.
  - Update `docs/reference/configuration/system-json.md` and MCP config docs.

- [ ] Test end to end.
  - Unit tests for registry schema.
  - Unit tests for function-name validation, unauthorized call rejection, forbidden argv rejection, and server-side identity handling.
  - Unit tests for vm.exec contract and timeout close behavior.
  - Portal tests showing credentialed CLI tools list/search/describe/call through existing portal tools.
  - Integration test with a fake CLI in a credentialed image or test VM.

## Open Questions

- Should `exec_many` be in v1, or should we rely on `mcp_portal_call` batching first?
- Should credentialed runner state RealFS be per credential profile or per agent plus credential profile?
- Which first provider should prove the path: `gog` only, or a fake CLI first and `gog` second?
- Do we need an out-of-band approval policy for destructive CLI argv, or is MCP Portal's existing approval layer enough for v1?
