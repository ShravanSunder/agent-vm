# Configuration

Agent VM uses a Hermes-only system configuration plus service-specific files.
Human-authored agent-vm files may be JSONC so operators can keep short comments
beside load-bearing settings. Runtime records and API payloads remain strict
JSON or JSONL.

```text
config/system.jsonc
  Host/controller, Hermes zones, image profiles, secrets, leases, and storage.

config/gateways/<zone>/hermes-managed/config.yaml
  Deployment-owned Hermes framework policy.

config/gateways/<zone>/mcp.config.jsonc
  Upstream MCP providers, transports, egress, and provider secrets.

config/gateways/<zone>/tool-portal.config.jsonc
  Managed Tool Portal agent/profile assignments and capability policy.

config/gateways/<zone>/oauth.config.jsonc
  Optional controller-owned OAuth broker configuration.
```

| Need | Read |
| --- | --- |
| Host, controller, zone, storage, image, lease, and secret fields | [system-json.md](system-json.md) |
| Static versus runtime checks | [../validate-and-doctor.md](../validate-and-doctor.md) |
| MCP Portal architecture | [../../subsystems/mcp-portal.md](../../subsystems/mcp-portal.md) |
| Secret boundaries | [../../subsystems/secrets-and-credentials.md](../../subsystems/secrets-and-credentials.md) |
