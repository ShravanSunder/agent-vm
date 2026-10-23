# Cloudflare Tool Portal host

Local development only. From the workspace root:

```sh
mise exec node@24.7.0 -- pnpm --filter @agent-collaboration/tool-host-cloudflare dev
```

The checked-in `wrangler.example.jsonc` declares organization authorization storage,
call analytics and the required variable names. Local development uses this same
configuration with the source entrypoint. It contains no account, route, or
deployment command. Remote Cloudflare resources and deployment require a separate owner decision (B4).

Agent management, sign-in client management, owners/managers and per-user
consents are deferred. Test compositions use an issuer and JWKS with test keys;
that stand-in does not prove the real sign-in service.

Worker types are committed in `worker-configuration.gen.d.ts` and generated with
Wrangler 4.124.0 from that one example configuration. Build first so its
`dist/index.js` entry is available, then run from the workspace root:

```sh
pnpm --filter @agent-collaboration/tool-host-cloudflare types:generate
pnpm --filter @agent-collaboration/tool-host-cloudflare types:check
```

The package typecheck runs the stale-type check before TypeScript. The example
uses public placeholders; private deployment configuration is never a type input.

This generated file retains Wrangler’s raw bytes. Wrangler 4.124.0 compares its
runtime header literally, including a trailing space when no compatibility flags
are set; formatting removes that space and makes fresh types appear stale. The
root formatter excludes this exact file. Regenerate it rather than editing it.
