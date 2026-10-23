# Cloudflare Tool Portal host

Local development only. From the workspace root:

```sh
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/tool-host-cloudflare dev
```

The local Wrangler configuration binds organization authorization storage and
call analytics. It contains no account, route, or deployment command. Remote
Cloudflare resources and deployment require a separate owner decision (B4).

Agent management, sign-in client management, owners/managers and per-user
consents are deferred. Test compositions use an issuer and JWKS with test keys;
that stand-in does not prove the real sign-in service.
