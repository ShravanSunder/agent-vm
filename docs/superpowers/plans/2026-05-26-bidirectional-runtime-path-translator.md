# Bidirectional Runtime Path Translator Decision Record

## Goal

OpenClaw/Gondolin Tool VM leases are scoped by `(zoneId, agentId)`. Runtime
paths must not become lease identity, but the system still needs to translate
path intent between the three runtime path languages:

```text
tool-vm-guest      /workspace, /workspace/app, /work/tmp
openclaw-gateway   /zone/agents/beta, /home/openclaw/.openclaw/state/sandboxes/<child>
controller-host    zoneFilesDir, stateDir/sandboxes/<child>
```

The failure this design fixes is the same-agent subagent path leak where
OpenClaw can pass `/workspace` as both `agentWorkspaceDir` and `workspaceDir`.
The plugin must translate that Tool VM guest path before the controller sees a
lease request. The controller must continue to reject `/workspace` and `/work`
as direct `workMountDir` values.

## Decisions

1. `@agent-vm/gateway-interface` owns a pure runtime path translator.

   Runtime-specific packages inject mappings. The translator performs no
   filesystem access and knows nothing about OpenClaw config or controller
   state.

2. Runtime path mappings are namespace-based.

   A mapping root declares which namespaces it exists in. The translator accepts
   an input path, optional source namespace, target namespace, and purpose, then
   returns either a translated path or structured retry guidance.

3. Storage backing constrains mapping shape.

   `host-realfs` roots must expose at least one host/gateway namespace.
   `guest-rootfs-cow` roots exist only in `tool-vm-guest` and cannot be
   `leaseMount` roots.

4. OpenClaw plugin resolves canonical agent workspace source first.

   If OpenClaw leaks runtime paths such as `/workspace`, `/work`, or sandbox
   fallback paths as `agentWorkspaceDir`, the plugin resolves the real
   lease-backed source from OpenClaw runtime config or stateDir. Invalid agent
   ids are rejected instead of falling back to `main`.

5. Plugin path intent returns both lease source and guest cwd.

   `leaseWorkMountDir` is the OpenClaw gateway path sent to `POST /lease`.
   `effectiveGuestCwd` is the Tool VM guest cwd used by command execution. They
   are deliberately different fields because they live in different path
   languages.

6. Controller remains the security boundary.

   The controller validates `workMountDir` using the OpenClaw gateway mapping,
   realpath checks, and root-path rules. It rejects Tool VM guest paths as
   invalid controller lease mounts.

7. Session and agent ids are strict.

   Malformed `sessionKey` values and invalid explicit agent ids must throw or
   return a request error. They must not silently coerce to `main`, because the
   lease cache key is `(zoneId, agentId)`.

8. Smoke means E2E.

   Unit and integration tests prove translator and controller contracts. The
   OpenClaw subagent smoke must boot the system path and prove a same-agent
   subagent can run with `/workspace`-style context without sending `/workspace`
   to the controller as `workMountDir`.

## Test Coverage

```text
unit
  packages/gateway-interface/src/runtime-paths/runtime-path-mapping.test.ts
  packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-tool-vm-path-mapping.test.ts
  packages/openclaw-agent-vm-plugin/src/sandbox-backend/openclaw-agent-workspace-source.test.ts
  packages/openclaw-agent-vm-plugin/src/openclaw-gondolin-contract.test.ts

integration
  packages/openclaw-agent-vm-plugin/src/sandbox-backend-factory.test.ts
  packages/agent-vm/src/controller/leases/lease-work-mount-paths.test.ts
  packages/agent-vm/src/controller/http/controller-http-routes.test.ts

e2e smoke
  packages/agent-vm/src/integration-tests/openclaw-subagent-lease.smoke.test.ts
```

The smoke currently covers same-agent subagent contexts for `/workspace`,
`/workspace/subdir`, and `/work/tmp`. Cross-agent collision, concurrent child
spawns, and parent-death/child-renew behavior remain follow-up coverage.

## Non-Goals

This design does not make path strings part of lease identity. It also does not
move guest-path acceptance into the controller. Guest path translation belongs
at the plugin adapter boundary; controller validation remains strict.
