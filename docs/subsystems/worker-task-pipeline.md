# Worker Task Pipeline

[Overview](../README.md) > [Architecture](../architecture/overview.md) > Worker Task Pipeline

This page focuses on the host-side lifecycle for a Worker task. The controller
owns repo cloning, config assembly, resource setup, VM boot, task submission,
polling, and teardown. For the in-VM task loop itself, see
[Agent Worker Gateway](../architecture/agent-worker-gateway.md).

## Flow

```text
POST /zones/:zoneId/worker-tasks
  -> clone repos on host
  -> merge zone config + repo-local overrides
  -> resolve resources
  -> start selected repo-local providers
  -> boot Gondolin VM
  -> POST /tasks to agent-vm-worker
  -> poll task state
  -> host-side push / pull-default operations
  -> cleanup resources and VM
```

## Repo Resource Routing

Repo-local providers can contribute docker-compose-backed resources for a task.
The controller starts only the selected providers, extracts container-network
addresses, and projects them into Gondolin `tcpHosts` and read-only VFS mounts.

The VM never talks to Docker directly. It only sees:

- synthetic TCP hosts such as `postgres.local:5432`
- env vars produced by resource finalization
- generated files mounted under resource output directories

## Related Files

- `packages/agent-vm/src/controller/worker-task-runner.ts`
- `packages/agent-vm/src/resources/resource-resolver.ts`
- `packages/agent-vm/src/resources/repo-resource-provider-runner.ts`
- `packages/agent-vm/src/resources/resource-compiler.ts`
