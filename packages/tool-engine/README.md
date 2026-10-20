# Tool engine

`@agent-collaboration/tool-engine/dispatch` admits capabilities through the shared
access assessor, an operation authority, an approval authority and an injected
resource backend. It has no Node or managed-VM imports.

The public operation key is authority, stable principal and the caller's original
item. Intent is separately versioned and hashed; changing a connection or admission
revision does not create a new key. Resource-owned context and receipt references
are selectors, never permissions. The resource must validate them before effects.

Every admitted call enters `OperationPort.createOrRead`. Only calls needing no
approval can use the managed authority's explicit `untracked` result. Such calls
carry no reuse or recovery guarantee. Public host stores must retain their records.
An unavailable store, invalid facts or an approval mismatch never invokes a backend.

The managed adapter currently lives in gateway-runtime's new `managed-tool-engine`
module. The existing production composition remains on the previous engine until
the separately planned cutover. Managed public lookup returns `unsupported-version`;
no stable-key index or public durable store is implemented by this slice.

Production build and typecheck commands select `tsconfig.production.json`, which
cannot resolve the managed test aliases. Default `tsconfig.json` files retain the
editor/test context for type-aware linting; `tsconfig.tests.json` owns the test
path map. The root quality gate checks both contexts, and the architecture audit
rejects test-only aliases in production source and declarations.
