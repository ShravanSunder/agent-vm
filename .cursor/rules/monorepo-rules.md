---
alwaysApply: true
---

# Monorepo Rules

## Monorepo Structure

Monorepo system combines python and typescript projects:

### Python Projects

- We use uv to manage dependencies and run commands `uv run`

Monorepo managed by **uv** workspaces:

- `services/py_**/pyproject.toml` - individual service applications
- `packages/py_**/pyproject.toml` - shared libraries

<example>
  ```
  services/<service-name>/
  ├── pyproject.toml          # Service dependencies & build config
  ├── <service-name>/         # Importable package root
  │   ├── __init__.py
  │   └── ...
  └── tests/                  # Service-specific tests
  ```
</example>

### Typescript Projects

- We use pnpm to manage dependencies and run commands `pnpm run`
- Monorepo managed by **pnpm** workspaces:

## Project Structure

- `/models` are pure datamodels, no business logic
  - Models should not depend on repos or services
  - Do not add database specific ddl to models
- `/repos` are used to interact with the database or external data sources
- `utils` or `helpers` are pure functions that are single responsibility logic

Do not create any `__init__.py` files unless the user asks. They are specifically only for package roots.

## Import Rules

- **Absolute imports only** - Always use absolute imports relative to the project root or package root. Never use relative imports like `../` or `./`.

## Additional Rules

- Python rules are in `@.cursor/rules/python-rules.mdc`
- TS rules are in `@.cursor/rules/ts-rules.mdc`

## Boundaries

- Do not edit `tsconfig.json` or `ruff.toml` or `pyrightconfig.json` or `ruff.toml` without explicit permission.
