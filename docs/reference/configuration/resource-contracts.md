# Resource contracts

Resource contracts describe TCP resources a Worker task can use. There are two
sources:

- Repo resources live in a requested repo under `.agent-vm/`.
- External resources come from the task request and point at infrastructure
  outside the repos.

Zone policy controls whether repo-local Compose providers may satisfy logical
resources. External resources are always task input; they are not declared in
repo files.

## Zone policy

`system.json` controls whether repo-local providers may be selected:

```json
{
  "zones": [
    {
      "id": "coding-agent",
      "resources": {
        "allowRepoResources": [
          "https://github.com/example/example-repo"
        ]
      }
    }
  ]
}
```

`allowRepoResources` may be:

- `false`: repo-local providers are disabled; required resources must be
  supplied as external resources.
- `true`: any requested repo may provide resources. This is the default.
- `string[]`: only matching repo URLs may provide resources.

Repo URL matching normalizes trailing `.git` and trailing slash forms.

This policy gates provider selection, not repo contract loading. When resource
resolution succeeds, the controller still runs each requested repo's
`run-setup.sh` and `finalizeRepoResourceSetup(input)` so repos can publish
generated mocks, fixtures, logs, or env derived from selected external
resources.

## Repo files

Run this in a target repo:

```bash
agent-vm resources init
agent-vm resources validate
```

The command creates:

```text
.agent-vm/
  repo-resources.ts       user-authored typed contract
  repo-resources.d.ts     generated editor/type declarations
  run-setup.sh          user-authored repo setup script
  docker-compose.yml      user-authored repo-local compose services
  AGENTS.md              generated local instructions
  README.md              generated local reference
```

`agent-vm resources update` rewrites only generated files:
`repo-resources.d.ts`, `AGENTS.md`, and `README.md`. It never rewrites
`repo-resources.ts`, `run-setup.sh`, or `docker-compose.yml`.

## Contract functions

`repo-resources.ts` exports two functions:

```ts
export function describeRepoResources(): RepoResourcesDescription {
  return {
    requires: {
      pg: {
        binding: { host: 'pg.local', port: 5432 },
        env: { DATABASE_URL: 'postgres://app:app@pg.local:5432/app' },
      },
    },
    provides: {
      pg: {
        type: 'compose',
        service: 'pg',
      },
    },
  };
}

export async function finalizeRepoResourceSetup(
  input: FinalizeRepoResourceSetupInput,
): Promise<RepoResourcesFinal> {
  return {
    resources: Object.fromEntries(
      Object.entries(input.selectedResources).map(([name, resource]) => [
        name,
        {
          binding: resource.binding,
          target: resource.target,
          env: { DATABASE_URL: `postgres://app:app@${resource.binding.host}:5432/app` },
        },
      ]),
    ),
    generated: [{ kind: 'directory', path: 'unstructured' }],
  };
}
```

`repo-resources.d.ts` supplies these types for editor and lint support. It is
generated and inlined, so target repos do not need a runtime dependency on
`@agent-vm/agent-vm`. The declaration text is generated from
`packages/agent-vm/src/config/resource-contracts/repo-resource-contract-types.ts`; the Zod schemas
in `packages/agent-vm/src/config/resource-contracts/resource-contract-schemas.ts` include
compile-time compatibility checks against those same types.

## Runtime flow

For each Worker task, the controller:

1. clones requested repos in parallel
2. loads every repo's `.agent-vm/repo-resources.ts` in parallel using
   Node 24 `--experimental-strip-types`
3. resolves logical resource names once at task scope
4. starts selected repo-local Compose providers in parallel
5. runs `run-setup.sh` once per requested repo
6. calls `finalizeRepoResourceSetup(input)`
7. compiles final resources into Gondolin `tcpHosts`, flat env, and read-only
   VFS mounts

External resources are authoritative. If task input supplies external `pg`, the
controller does not start a repo provider for `pg`. The names `pg` and
`pg-blah` are different logical resources and can both exist.

External resources are passed in the Worker task request:

```json
{
  "prompt": "Run the tests that need Postgres",
  "repos": [
    {
      "repoUrl": "https://github.com/example/example-repo",
      "baseBranch": "main"
    }
  ],
  "resources": {
    "externalResources": {
      "pg": {
        "name": "pg",
        "binding": { "host": "pg.local", "port": 5432 },
        "target": { "host": "example-postgres.internal", "port": 5432 },
        "env": {
          "DATABASE_URL": "postgres://app:app@pg.local:5432/app"
        }
      }
    }
  }
}
```

Task input is capped at 20 repos. Repos still start together within that
bounded request shape; the cap keeps parallel setup from becoming unbounded
host fan-out.

## Compose rules

Compose service names are repo-local. Two repos can both define a service named
`pg` because each repo gets a separate Compose project namespace.

The current project name shape is:

```text
agent-vm-<taskId>-<repoId>
```

Important architecture note: `<taskId>` is currently the Worker task id used as
a temporary per-run namespace. Resource task segregation is not fully modeled
yet. If resources gain a lifecycle separate from Worker tasks, this should move
to an explicit resource namespace/id.

Do not publish host ports in repo-resource compose files. Use internal service
ports (`expose` or image-level `EXPOSE`) and let the controller map Docker
network IPs into Gondolin `tcpHosts`. Published host ports collide across
parallel repos and parallel tasks, so selected services with `ports:` are
rejected.

The controller starts selected services with `docker compose up --no-deps`.
Provider services should be self-contained, or each required service should be
modeled as its own logical resource provider.

Selected services must expose exactly one Docker-network IP. Multi-network
services are rejected because the controller cannot know which IP is reachable
from the VM.

## Generated files

`run-setup.sh` receives environment variables, not positional arguments:

```bash
COMPOSE_PROJECT_NAME=agent-vm-<taskId>-<repoId>
RESOURCE_OUTPUT_DIR=/path/to/task/state/resources/<repoId>
```

`COMPOSE_PROJECT_NAME` lets the script run repo-owned Compose commands against
the controller-created project. For repos that did not provide a selected
Compose service, that project may have no running services. `RESOURCE_OUTPUT_DIR`
is where the script writes generated mocks, fixtures, logs, or other
agent-visible artifacts. The script does not receive logical resource names or
resolved host/port values; use `finalizeRepoResourceSetup(input)` for
schema-shaped final env and binding logic.

Generated mocks and fixtures should be written under:

```text
$RESOURCE_OUTPUT_DIR/unstructured/
```

`finalizeRepoResourceSetup()` reports generated files and directories relative
to `RESOURCE_OUTPUT_DIR`. The controller verifies those paths resolve inside
`RESOURCE_OUTPUT_DIR` before mounting:

```text
/agent-vm/resources/<repoId> -> <task state>/resources/<repoId>
```

The mount is read-only inside the VM.

## HTTP egress

Resources are TCP bindings. They do not update `zones[].allowedHosts`.

If the task needs direct HTTPS access to Stripe, OpenAI, or another public API,
add that host to `zones[].allowedHosts` and configure mediated secrets
separately.
