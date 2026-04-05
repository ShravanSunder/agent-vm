---
alwaysApply: true
---

# TypeScript Rules

## Types

- **No `any` type** - Always use explicit, narrow types or generics
- **Use `satisfies` over `as` casts** - Prefer `satisfies` for type checking without losing type inference
  - Example: `const config = { ... } satisfies ConfigType` instead of `const config = ... as ConfigType`
- **Strict types everywhere**
  - Enable `strict: true` in tsconfig (already configured)
  - Always provide explicit return types on functions
  - Always provide explicit parameter types
  - Use discriminated unions instead of loose object types
- **Generics over `any`**
  - Use `<T>`, `<T extends SomeType>` for flexible, type-safe functions
  - Example: `function getValue<T>(obj: Record<string, T>, key: string): T`
- **Prefer readonly for immutable data**
  - Use `readonly` on array and object properties when data shouldn't be mutated
  - Example: `pkColumns: readonly string[]` instead of `pkColumns: string[]`

## Function Signatures

- Always explicitly type parameters and return types
  - `function fetch<T>(url: string): Promise<T> { ... }`
  - `function fetch(url) { ... }` (missing types)
- For functions with >3 parameters, use an interface or type alias
  - Example: `interface QueryProps { table: string; filters: Filter[]; limit?: number }`
  - Then: `function query(props: QueryProps): Promise<Row[]>`
- Use union types for multiple valid return states instead of nullable generics
  - Example: `type Result<T> = { ok: true; data: T } | { ok: false; error: Error }`

## Type Organization

- Colocate type definitions near their usage
- Use `interface` for object contracts, `type` for aliases and unions
- Prefer discriminated unions for variant handling
  - Example: `type Change = { type: 'insert'; data: Row } | { type: 'delete'; id: string }`

## Naming & Organization

- **Descriptive folder names** - Use multi-word, descriptive folder names that clearly convey purpose
  - `src/database-adapters/`, `src/query-builders/`, `src/error-handlers/`
  - Not: `src/db/`, `src/sync/`
- **Descriptive file names** - Use clear, descriptive file names that indicate the file's responsibility
  - `database-connection.ts`, `query-builder.ts`, `error-handler.ts`
  - Not: `db.ts`, `util.ts`, `helper.ts`, `mutators.ts`, `sync.ts`

## Formatting & Style

- Use tabs for indentation (Oxfmt default)
- Follow Oxlint strict category rules without exceptions
- Use `const` by default; only use `let` when mutation is necessary
- Prefer template literals over string concatenation

## Schema Validation

- **Prefer Zod schema derivation over TypeScript type inference** - Keep validation and types in sync by deriving schemas, not just types
  - Use Zod's `.omit()`, `.pick()`, `.partial()`, `.merge()` methods to derive related schemas
  - Good - Zod-derived:
    ```typescript
    export const sectorConfigInputSchema = sectorConfigSchema.omit({
    	version: true,
    	updatedAt: true,
    });
    export type SectorConfigInput = z.infer<typeof sectorConfigInputSchema>;
    ```
  - Avoid - Type inference only:
    ```typescript
    export type SectorConfigInput = Omit<SectorConfig, 'version' | 'updatedAt'>;
    // Schema and type can drift apart
    ```

## Advanced Type Patterns

- **Mapped types with indexed access** - Follow the `RpcFnParams<T>` pattern for type-safe mapped types
  - Use direct indexed access for mapped type properties
  - Avoid redundant wrapper types that just return the input

- **Registry pattern with `satisfies`** - Type-check registry objects while preserving literal types
  - Use `as const satisfies` to validate registry structure and maintain type inference

## Tools

- Use `oxlint <path>` to check for lint errors and warnings in the given path.
- Use `oxlint --fix <path>` to auto-fix lint issues in the given path.
- Use `oxlint --type-aware` to run type-aware lint rules (no-floating-promises, etc.).
- Use `oxfmt <path>` to format files. Use `oxfmt --check <path>` to verify formatting.
- Use `pnpm vitest run <path>` to run the tests.
