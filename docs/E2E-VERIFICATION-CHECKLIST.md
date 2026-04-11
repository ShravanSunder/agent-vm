# E2E Verification Checklist

This checklist verifies the live `agent-vm` stack after the Phase 5 reorganization and review fixes.

## Prerequisites

- `gondolin --version`
  Expected: exits `0`
- `op whoami`
  Expected: exits `0`
- `pnpm install`
  Expected: exits `0`
- `pnpm build`
  Expected: exits `0`
- `pnpm test`
  Expected: exits `0`
- `pnpm test:integration`
  Expected: exits `0`

## 1. Controller Boot

Run:

```bash
pnpm --filter agent-vm exec agent-vm controller start --config system.json
```

Expected JSON fields:

- `controllerPort: 18800`
- `zoneId: "shravan"`
- `vmId`
- `ingress.host`
- `ingress.port`

## 2. Controller Health

Run:

```bash
curl -fsS http://127.0.0.1:18800/health
```

Expected:

- HTTP `200`
- JSON includes `"ok": true`

## 3. Controller Status

Run:

```bash
pnpm --filter agent-vm exec agent-vm controller status --config system.json
```

Expected JSON fields:

- `controllerPort: 18800`
- `toolProfiles`
- `zones`

## 4. Lease Creation

Run:

```bash
curl -fsS http://127.0.0.1:18800/lease \
  -H 'content-type: application/json' \
  -d '{
    "agentWorkspaceDir": "/home/openclaw/workspace",
    "profileId": "standard",
    "scopeKey": "manual-e2e-session",
    "workspaceDir": "/home/openclaw/.openclaw/sandboxes/workspace",
    "zoneId": "shravan"
  }'
```

Expected JSON fields:

- `leaseId`
- `ssh.host`
- `ssh.identityPem`
- `tcpSlot`
- `workdir: "/workspace"`

## 5. Lease Listing

Run:

```bash
pnpm --filter agent-vm exec agent-vm controller lease list --config system.json
```

Expected:

- JSON array contains the lease created in step 4

## 6. Gateway Logs

Run:

```bash
pnpm --filter agent-vm exec agent-vm controller logs --zone shravan --config system.json
```

Expected:

- JSON includes `zoneId: "shravan"`
- `output` is present

## 7. SSH Command

Run:

```bash
pnpm --filter agent-vm exec agent-vm controller ssh-cmd --zone shravan --config system.json
```

Expected:

- prints an SSH command or JSON SSH details for the gateway VM

## 8. Snapshot List

Run:

```bash
pnpm --filter agent-vm exec agent-vm controller snapshot list --zone shravan --config system.json
```

Expected:

- exits `0`
- returns a JSON array

## 9. Integration Coverage

Run:

```bash
pnpm test:integration
```

Expected:

- `5` files passed
- `8` tests passed
- `1` skipped

## 10. Shutdown

Run:

```bash
curl -fsS -X POST http://127.0.0.1:18800/stop-controller
```

Expected:

- JSON includes `"ok": true`

Verify shutdown:

```bash
curl -fsS http://127.0.0.1:18800/health
```

Expected:

- request fails because the controller has stopped
