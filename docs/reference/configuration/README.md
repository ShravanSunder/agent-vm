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
  Per-agent Google policy defaults and the finite executable Gog surface.

config/gateways/<zone>/oauth.config.jsonc
  Optional controller-owned OAuth broker configuration.
  Clerk human identity, owners/editors, application bindings and ceilings.
```

| Need | Read |
| --- | --- |
| Google account authorization and managed Gog policy | [system-json.md#managed-gateway-tool-portal-defaults](system-json.md#managed-gateway-tool-portal-defaults) |
| Start from a validated synthetic OAuth v2 and Tool Portal pair | [examples/oauth-v2.config.jsonc](examples/oauth-v2.config.jsonc) and [examples/tool-portal-google-policy.config.jsonc](examples/tool-portal-google-policy.config.jsonc) |
| Host, controller, zone, storage, image, lease, and secret fields | [system-json.md](system-json.md) |
| Static versus runtime checks | [../validate-and-doctor.md](../validate-and-doctor.md) |
| MCP Portal architecture | [../../subsystems/mcp-portal.md](../../subsystems/mcp-portal.md) |
| Secret boundaries | [../../subsystems/secrets-and-credentials.md](../../subsystems/secrets-and-credentials.md) |
