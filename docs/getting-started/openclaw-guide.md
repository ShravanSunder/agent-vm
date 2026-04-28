# OpenClaw Gateway Guide

[Overview](../README.md) > Getting Started > OpenClaw Gateway

How to configure and run agent-vm in OpenClaw Gateway — interactive chat agent with sandboxed tool execution.

---

## What OpenClaw Gateway Does

A long-running gateway VM hosts the OpenClaw interactive agent. Users chat via Discord or WhatsApp. When the agent needs to execute code, it requests a tool VM lease from the controller. Tool VMs are ephemeral — created on demand, destroyed after use.

For the full OpenClaw architecture, see [architecture/openclaw-gateway.md](../architecture/openclaw-gateway.md).

---

## Configuration

### system.json — Define an OpenClaw Zone

```json
{
  "zones": [{
    "id": "my-openclaw",
    "gateway": {
      "type": "openclaw",
      "memory": "2G",
      "cpus": 2,
      "port": 18791,
      "config": "./my-openclaw/openclaw.json",
      "stateDir": "../state/my-openclaw",
      "zoneFilesDir": "../zone-files/my-openclaw",
      "authProfilesRef": {
        "source": "1password",
        "ref": "op://agent-vm/auth-profiles/credential"
      }
    },
    "secrets": {
      "OPENCLAW_GATEWAY_TOKEN": {
        "source": "1password",
        "ref": "op://agent-vm/openclaw-token/credential",
        "injection": "env"
      }
    },
    "allowedHosts": [
      "api.anthropic.com",
      "api.openai.com",
      "auth.openai.com",
      "chatgpt.com",
      "generativelanguage.googleapis.com"
    ],
    "websocketBypass": ["gateway.discord.gg:443"],
    "toolProfile": "standard"
  }]
}
```

For all system.json fields, see
[reference/configuration/system-json.md](../reference/configuration/system-json.md).

### openclaw.json — OpenClaw Configuration

Controls the OpenClaw agent platform: model selection, sandbox mode, plugin registration.

### OpenClaw Version

`agent-vm init` writes a gateway Dockerfile with a tested OpenClaw version, for example:

```dockerfile
RUN pnpm add -g openclaw@2026.4.24
```

That pin is a scaffold default, not a host-side package lock. After scaffold, the catalog repo owns `vm-images/gateways/openclaw/Dockerfile`; edit that line in the catalog when you want to try or pin a different OpenClaw release.

For host-side validation, install the same OpenClaw version in the catalog:

```bash
pnpm add -D openclaw@2026.4.24
```

`agent-vm doctor` and `agent-vm validate` use the catalog's `openclaw`
binary, so OpenClaw stays loosely coupled: the catalog chooses the OpenClaw
version, and agent-vm validates against that choice.

### Auth Profiles

Auth profiles (OAuth tokens for model providers) are resolved from 1Password and written to the host-side state directory before the VM boots. The VM accesses them via VFS mount.

See [subsystems/secrets-and-credentials.md](../subsystems/secrets-and-credentials.md#auth-profiles) for the full flow.

---

## Starting the Gateway

```bash
agent-vm controller start --zone my-openclaw
```

The controller:
1. Resolves secrets (1Password / env)
2. Builds the gateway VM image (cached by fingerprint)
3. Writes effective config + auth profiles to state dir
4. Boots the gateway VM (long-running)
5. Starts the OpenClaw process inside the VM
6. Waits for health check, enables ingress

The gateway stays running until you stop it or the controller shuts down.

---

## Tool VMs and Leases

When the agent needs to run code, OpenClaw requests a tool VM lease from the controller:

```
  OpenClaw (inside gateway VM)
       |
       | POST /lease { scopeKey, zoneId, profileId }
       v
  Controller
       |
       | Allocates TCP slot, boots tool VM
       v
  Tool VM (Zone 3 — untrusted)
       | /workspace mounted, no secrets, no network
       | SSH access via tool-{slot}.vm.host:22
```

Leases are scoped by `scopeKey` for reuse within the same conversation. Idle leases are reaped after 30 minutes.

For internals, see [architecture/openclaw-gateway.md](../architecture/openclaw-gateway.md#tool-vm-leases).

---

## Channels (Discord, WhatsApp)

WebSocket connections to Discord and WhatsApp bypass HTTP mediation (they need raw WebSocket, not proxied HTTP). Configure in `zones[].websocketBypass`:

```json
"websocketBypass": ["gateway.discord.gg:443", "web.whatsapp.com:443"]
```

---

## SSH Access

```bash
agent-vm controller ssh --zone my-openclaw
```

Opens an SSH session into the gateway VM for debugging.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Gateway won't start | Auth profiles missing | Check `authProfilesRef` in system.json |
| Codex OAuth expired | Token expires ~10 days | Re-auth: `agent-vm auth-interactive codex --zone <id>` |
| Tool calls fail | Lease creation failing | Check `toolProfile` exists, TCP pool has free slots |
| Discord not connecting | WebSocket not bypassed | Add `gateway.discord.gg:443` to `websocketBypass` |
| Can't reach external API | Host not allowlisted | Add to `zones[].allowedHosts` |
