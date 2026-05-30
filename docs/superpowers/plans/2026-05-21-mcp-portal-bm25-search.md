# MCP Portal BM25 Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace MCP Portal's scoped substring search with a fully tested BM25 search mechanism that is part of the `@agent-vm/mcp-portal` library surface.

**Architecture:** BM25 is a reusable package mechanism under `packages/mcp-portal/src/search/`. MCP-specific catalog shaping stays in `packages/mcp-portal/src/search-index.ts`. `portal-session.ts` still builds one scoped index from the agent-visible catalog after access-policy filtering. `core/*` and `mcp-proxy/*` keep their current response shapes and do not learn BM25 internals.

**Tech Stack:** TypeScript, Vitest, Node 24, Zod-backed MCP Portal catalog records, zero-dependency Okapi BM25 implementation.

---

## Current Repo Shape

Reviewed against current `origin/master` on 2026-05-30. MCP Portal now has these package surfaces:

- `packages/mcp-portal/src/bin`
  - `mcp-portal` executable entrypoint.
  - Validates catalogs, generates helpers, serves the MCP proxy, prints client config, and performs direct portal calls.
  - Loads `mcp.config.jsonc` and `mcp-portal.config.jsonc` through `@agent-vm/config-contracts`.
  - Out of scope except for package export/build verification.
- `packages/mcp-portal/src/cli`
  - Server startup, profile policy map construction, 1Password/environment secret resolution, Hono `serve`, and structured server logging.
  - Out of scope.
- `packages/mcp-portal/src/core`
  - Native portal core and portal tool handlers.
  - `core/portal-tools.ts` imports `ToolSearchResult` from `../search-index.js`.
  - `mcp_portal_search` remains request-keyed and controlled by `schemaDetail`.
  - `core/portal-tools.test.ts` covers keyed multi-request search output.
- `packages/mcp-portal/src/mcp-proxy`
  - MCP protocol adapter over `PortalCore`.
  - `portal-http-server.ts` owns Hono, `/agents/:agentId/mcp`, bearer auth, auth audit events, active MCP sessions, and session close cleanup.
  - `portal-mcp-server.ts` owns MCP SDK tool listing/calling and `isError` mapping.
  - Must not know BM25 exists.
- `packages/mcp-portal/src/portal-auth`
  - HMAC and bearer token helpers.
  - Out of scope.
- `packages/mcp-portal/src/portal-config`
  - TypeScript/Zod catalog artifacts.
  - Out of scope.
- `packages/mcp-portal/src/search-index.ts`
  - Owns MCP-specific catalog document construction.
  - Currently uses lowercase substring scoring and recursive schema string collection.
- `packages/mcp-portal/src/portal-session.ts`
  - Builds scoped catalogs after access-policy filtering.
  - Builds `ToolGraph`.
  - Creates `createSearchIndex(sortedTools, graph)`.
  - This is the only runtime caller that should need the search index.
- `packages/mcp-portal/src/core/provider-runtime.ts`
  - Converts resolved MCP provider config into upstream runtime server configs.
  - Out of scope.
- `packages/mcp-portal/package.json`
  - Already exports package subpaths for core, proxy, CLI, config, auth, and testing.
  - This plan adds a real `./search` subpath for the BM25 mechanism.

This plan is the current implementation contract.

---

## File Structure

- Create: `packages/mcp-portal/src/search/tokenizer.ts`
  - Generic search tokenizer.
  - No MCP, portal, agent, namespace, schema, approval, Hono, OpenClaw, or runtime imports.
- Create: `packages/mcp-portal/src/search/tokenizer.test.ts`
  - Unit tests for tokenizer contract.
- Create: `packages/mcp-portal/src/search/bm25-index.ts`
  - Generic in-memory BM25 index over caller-provided `{ id, text }` documents.
  - No MCP-specific imports.
- Create: `packages/mcp-portal/src/search/bm25-index.test.ts`
  - Unit tests for ranking, query-term dedupe, limits, tie ordering, empty documents, and no stemming.
- Create: `packages/mcp-portal/src/search/index.ts`
  - Public library barrel for the search mechanism.
  - Exports `createBm25Index`, `tokenizeSearchText`, and their types.
- Modify: `packages/mcp-portal/package.json`
  - Add a public `./search` export:

```json
"./search": {
	"types": "./dist/search/index.d.ts",
	"import": "./dist/search/index.js"
}
```

- Modify: `packages/mcp-portal/src/index.ts`
  - Export `./search/index.js` from the package root if the existing package root is intended to expose library utilities.
- Modify: `packages/mcp-portal/src/search-index.ts`
  - Import from `./search/index.js`.
  - Replace substring scoring with `createBm25Index`.
  - Replace broad recursive schema text collection with recursive input property-name collection.
  - Preserve `SearchIndex`, `SearchQuery`, `SearchResultSet`, and `ToolSearchResult` shapes.
- Modify: `packages/mcp-portal/src/search-index.test.ts`
  - Add integration tests for tokenized ranking, schema noise exclusion, recursive field names, namespace filters, and deterministic empty-query listing.
- Inspect: `packages/mcp-portal/src/bin/mcp-portal.test.ts`
  - Keep CLI argument/config dispatch behavior passing.
- Inspect: `packages/mcp-portal/src/cli/serve-command.test.ts`
  - Keep server startup, profile policy, and secret-resolution tests passing.
- Inspect: `packages/mcp-portal/src/core/portal-tools.test.ts`
  - Keep existing keyed search-output tests passing.
- Inspect: `packages/mcp-portal/src/core/portal-core.test.ts`
  - Keep core stream/collection tests passing.
- Inspect: `packages/mcp-portal/src/mcp-proxy/portal-mcp-server.test.ts`
  - Keep MCP adapter tool exposure and error-shape tests passing.
- Inspect: `packages/mcp-portal/src/mcp-proxy/portal-http-server.test.ts`
  - Keep Hono Streamable HTTP session/auth behavior passing.

Do not add facets, vector search, search config, config migrations, Hono changes, OpenClaw changes, or tool-hint enrichment in this change.

---

## Library Boundary

BM25 is part of the MCP Portal library. The boundary is:

- `src/search/*` is generic and reusable.
- `src/search-index.ts` adapts MCP Portal catalog records into generic search documents.
- `src/core/*` consumes `SearchIndex` results only.
- `src/mcp-proxy/*` consumes core tool results only.
- `src/bin/*` and `src/cli/*` launch and operate the portal but do not participate in ranking.

The search library must not import from these files or folders:

- `src/bin`
- `src/cli`
- `src/core`
- `src/mcp-proxy`
- `src/portal-auth`
- `src/portal-config`
- `src/upstream-*`
- `src/catalog-types.ts`
- `src/tool-ref.ts`

The only allowed direction is MCP-specific code importing the generic search mechanism.

---

## Tokenizer Contract

One tokenizer is used for both indexed documents and query text.

Rules, in order:

- Split acronym/title boundaries:
  - `HTTPServer` -> `http`, `server`
  - `HTTPServerConfig` -> `http`, `server`, `config`
- Split camelCase and digit-to-capital boundaries:
  - `createIssue` -> `create`, `issue`
  - `s3GetObject` -> `s3`, `get`, `object`
- Treat `_`, `-`, `.`, `/`, `:`, and `@` as separators.
- Treat all remaining non-letter and non-number characters as separators.
- Lowercase.
- Split whitespace and remove empty tokens.
- Keep Unicode letters.
- Preserve numbers inside tokens.
- Do not stem.
- Do not remove stopwords.
- Do not minimum-length-filter.

Pinned examples:

- `''` -> `[]`
- `HTTPSSL` -> `['httpssl']`
- `search_issues` -> `['search', 'issues']`
- `linear/search_issues` -> `['linear', 'search', 'issues']`
- `owner.name:mcp` -> `['owner', 'name', 'mcp']`
- `mcp__memory__create_entities` -> `['mcp', 'memory', 'create', 'entities']`
- `cafe/muenchen_naive` -> `['cafe', 'muenchen', 'naive']`
- `café/münchen_naïve` -> `['café', 'münchen', 'naïve']`
- `v2 oauth2` -> `['v2', 'oauth2']`

---

## BM25 Contract

The search mechanism implements standard Okapi BM25 with these defaults:

- `k1 = 1.2`
- `b = 0.75`
- `idf = Math.log(1 + (documentCount - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5))`

Behavior:

- Tokenize documents at index construction.
- Store term counts per document.
- Calculate document frequency and IDF once at construction.
- Deduplicate query terms before scoring so repeated query text does not double-score.
- Return no results for empty queries.
- Return no results for unmatched queries.
- Return no results for non-finite, zero, or negative limits.
- Floor positive fractional limits.
- Return only positive-score results.
- Sort by score descending, then document ID ascending for deterministic ties.
- Handle empty documents without division by zero.
- Avoid `!`, `any`, and unsafe casts.

---

## Search Document Contract

For each already-scoped `PortalToolRecord`, `search-index.ts` indexes:

- `namespace`
- `toolName`
- `${namespace}/${toolName}`
- `${namespace}.${toolName}`
- `title`
- top-level tool `description`
- recursive input schema property names
- relationship hint `field`, `reason`, `sourceToolRef`, and `type`
- scoped skill `title`, `description`, and `tags`

Do not index:

- JSON Schema structural keys: `type`, `properties`, `required`, `items`, `additionalProperties`, `allOf`, `anyOf`, `oneOf`, `enum`, `default`, `format`, `$ref`, `$defs`, `definitions`
- JSON Schema type values: `object`, `string`, `number`, `integer`, `boolean`, `array`, `null`
- enum values
- defaults
- examples
- per-property descriptions
- output schema content
- tool hints
- config-driven enriched text

`schemaFieldMatches` returns original input field names such as `issueId` and `teamKey`. Tokenization is used only to decide whether a field matches a query.

---

### Task 1: Add Tokenizer Tests First

**Files:**
- Create: `packages/mcp-portal/src/search/tokenizer.test.ts`

- [ ] **Step 1: Write the failing tokenizer tests**

Create `packages/mcp-portal/src/search/tokenizer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { tokenizeSearchText } from './tokenizer.js';

describe('tokenizeSearchText', () => {
	const cases = [
		['', []],
		['   \t  ', []],
		['createIssue', ['create', 'issue']],
		['HTTPServer', ['http', 'server']],
		['HTTPServerConfig', ['http', 'server', 'config']],
		['HTTPSSL', ['httpssl']],
		['s3GetObject', ['s3', 'get', 'object']],
		['search_issues', ['search', 'issues']],
		['repo-name', ['repo', 'name']],
		['linear/search_issues', ['linear', 'search', 'issues']],
		['owner.name:mcp', ['owner', 'name', 'mcp']],
		['mcp__memory__create_entities', ['mcp', 'memory', 'create', 'entities']],
		['a__b--c..d//e', ['a', 'b', 'c', 'd', 'e']],
		['  leading   and trailing  ', ['leading', 'and', 'trailing']],
		['cafe/muenchen_naive', ['cafe', 'muenchen', 'naive']],
		['café/münchen_naïve', ['café', 'münchen', 'naïve']],
		['v2 oauth2', ['v2', 'oauth2']],
		['!!!,,,', []],
	] satisfies readonly (readonly [string, readonly string[]])[];

	it.each(cases)('tokenizes %j', (input, expected) => {
		expect(tokenizeSearchText(input)).toEqual(expected);
	});
});
```

- [ ] **Step 2: Run the tokenizer test and verify it fails**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test:unit -- search/tokenizer.test.ts
```

Expected: FAIL because `./tokenizer.js` does not exist.

- [ ] **Step 3: Do not commit the red test**

Continue directly to Task 2.

---

### Task 2: Implement Tokenizer

**Files:**
- Create: `packages/mcp-portal/src/search/tokenizer.ts`
- Test: `packages/mcp-portal/src/search/tokenizer.test.ts`

- [ ] **Step 1: Add the tokenizer implementation**

Create `packages/mcp-portal/src/search/tokenizer.ts`:

```ts
export function tokenizeSearchText(text: string): readonly string[] {
	const normalizedText = text
		.replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
		.replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
		.replace(/[_\-.\/:@]+/gu, ' ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.toLowerCase();

	return normalizedText
		.split(/\s+/u)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
}
```

- [ ] **Step 2: Run tokenizer tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test:unit -- search/tokenizer.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package typecheck**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit tokenizer**

Run:

```bash
git add packages/mcp-portal/src/search/tokenizer.ts packages/mcp-portal/src/search/tokenizer.test.ts
git commit -m "feat: add mcp portal search tokenizer

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: Add BM25 Index Tests First

**Files:**
- Create: `packages/mcp-portal/src/search/bm25-index.test.ts`

- [ ] **Step 1: Write the failing BM25 tests**

Create `packages/mcp-portal/src/search/bm25-index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { createBm25Index } from './bm25-index.js';

describe('createBm25Index', () => {
	it('ranks documents with focused rare term matches above broad common matches', () => {
		const index = createBm25Index({
			documents: [
				{ id: 'linear/search_issues', text: 'linear search issues issue issue assignee bug triage' },
				{ id: 'github/create_issue', text: 'github create issue title body repository' },
				{ id: 'readwise/search_highlights', text: 'readwise search highlights annotation quote' },
			],
		});

		expect(index.search({ query: 'assignee bug issue', limit: 3 }).map((result) => result.id)).toEqual([
			'linear/search_issues',
			'github/create_issue',
		]);
	});

	it('downweights terms that appear in every document', () => {
		const index = createBm25Index({
			documents: [
				{ id: 'a/get_user', text: 'get user account' },
				{ id: 'b/get_team', text: 'get team account' },
				{ id: 'c/get_org', text: 'get org account' },
			],
		});

		expect(index.search({ query: 'get team account', limit: 3 })[0]?.id).toBe('b/get_team');
	});

	it('deduplicates query terms instead of double-scoring repeated query text', () => {
		const index = createBm25Index({
			documents: [
				{ id: 'x/one', text: 'issue' },
				{ id: 'y/two', text: 'issue bug' },
			],
		});

		expect(index.search({ query: 'issue', limit: 5 }).map((result) => result.id)).toEqual(
			index.search({ query: 'issue issue', limit: 5 }).map((result) => result.id),
		);
	});

	it('does not stem singular and plural terms in v1', () => {
		const index = createBm25Index({
			documents: [
				{ id: 'singular/tool', text: 'issue' },
				{ id: 'plural/tool', text: 'issues' },
			],
		});

		expect(index.search({ query: 'issue', limit: 5 }).map((result) => result.id)).toEqual(['singular/tool']);
		expect(index.search({ query: 'issues', limit: 5 }).map((result) => result.id)).toEqual(['plural/tool']);
	});

	it('returns deterministic ordering when scores tie', () => {
		const index = createBm25Index({
			documents: [
				{ id: 'zeta/tool', text: 'shared token' },
				{ id: 'alpha/tool', text: 'shared token' },
			],
		});

		expect(index.search({ query: 'shared', limit: 10 }).map((result) => result.id)).toEqual([
			'alpha/tool',
			'zeta/tool',
		]);
	});

	it('returns no results for empty queries, zero limits, and unmatched terms', () => {
		const index = createBm25Index({
			documents: [{ id: 'linear/search_issues', text: 'linear search issues' }],
		});

		expect(index.search({ query: '', limit: 10 })).toEqual([]);
		expect(index.search({ query: 'linear', limit: 0 })).toEqual([]);
		expect(index.search({ query: 'calendar', limit: 10 })).toEqual([]);
	});

	it('returns no results for non-finite and negative limits', () => {
		const index = createBm25Index({
			documents: [{ id: 'linear/search_issues', text: 'linear search issues' }],
		});

		expect(index.search({ query: 'linear', limit: Number.NaN })).toEqual([]);
		expect(index.search({ query: 'linear', limit: Number.POSITIVE_INFINITY })).toEqual([]);
		expect(index.search({ query: 'linear', limit: -1 })).toEqual([]);
	});

	it('floors positive fractional limits', () => {
		const index = createBm25Index({
			documents: [
				{ id: 'a/tool', text: 'linear issue' },
				{ id: 'b/tool', text: 'linear issue' },
			],
		});

		expect(index.search({ query: 'linear', limit: 1.9 })).toHaveLength(1);
	});

	it('handles empty documents without division by zero', () => {
		const index = createBm25Index({
			documents: [{ id: 'empty/tool', text: '' }],
		});

		expect(index.search({ query: 'anything', limit: 10 })).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the BM25 test and verify it fails**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test:unit -- search/bm25-index.test.ts
```

Expected: FAIL because `./bm25-index.js` does not exist.

- [ ] **Step 3: Do not commit the red test**

Continue directly to Task 4.

---

### Task 4: Implement BM25 Index

**Files:**
- Create: `packages/mcp-portal/src/search/bm25-index.ts`
- Test: `packages/mcp-portal/src/search/bm25-index.test.ts`

- [ ] **Step 1: Add the BM25 implementation**

Create `packages/mcp-portal/src/search/bm25-index.ts`:

```ts
import { tokenizeSearchText } from './tokenizer.js';

export interface Bm25Document<TDocumentId extends string> {
	readonly id: TDocumentId;
	readonly text: string;
}

export interface Bm25IndexProps<TDocumentId extends string> {
	readonly b?: number;
	readonly documents: readonly Bm25Document<TDocumentId>[];
	readonly k1?: number;
}

export interface Bm25SearchQuery {
	readonly limit: number;
	readonly query: string;
}

export interface Bm25SearchResult<TDocumentId extends string> {
	readonly id: TDocumentId;
	readonly score: number;
}

export interface Bm25Index<TDocumentId extends string> {
	readonly search: (query: Bm25SearchQuery) => readonly Bm25SearchResult<TDocumentId>[];
}

interface IndexedBm25Document<TDocumentId extends string> {
	readonly id: TDocumentId;
	readonly length: number;
	readonly termCounts: ReadonlyMap<string, number>;
}

interface Bm25Settings {
	readonly b: number;
	readonly k1: number;
}

function countTerms(tokens: readonly string[]): ReadonlyMap<string, number> {
	const termCounts = new Map<string, number>();
	for (const token of tokens) {
		termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
	}
	return termCounts;
}

function createIndexedDocument<TDocumentId extends string>(
	document: Bm25Document<TDocumentId>,
): IndexedBm25Document<TDocumentId> {
	const tokens = tokenizeSearchText(document.text);
	return {
		id: document.id,
		length: tokens.length,
		termCounts: countTerms(tokens),
	};
}

function calculateDocumentFrequency<TDocumentId extends string>(
	documents: readonly IndexedBm25Document<TDocumentId>[],
): ReadonlyMap<string, number> {
	const documentFrequency = new Map<string, number>();
	for (const document of documents) {
		for (const term of document.termCounts.keys()) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
	}
	return documentFrequency;
}

function calculateIdfByTerm(
	documentCount: number,
	documentFrequency: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
	const idfByTerm = new Map<string, number>();
	for (const [term, documentsWithTerm] of documentFrequency.entries()) {
		idfByTerm.set(
			term,
			Math.log(1 + (documentCount - documentsWithTerm + 0.5) / (documentsWithTerm + 0.5)),
		);
	}
	return idfByTerm;
}

function normalizeSearchLimit(limit: number): number {
	if (!Number.isFinite(limit)) {
		return 0;
	}
	return Math.max(0, Math.floor(limit));
}

function scoreDocument<TDocumentId extends string>(props: {
	readonly averageDocumentLength: number;
	readonly document: IndexedBm25Document<TDocumentId>;
	readonly idfByTerm: ReadonlyMap<string, number>;
	readonly queryTerms: readonly string[];
	readonly settings: Bm25Settings;
}): number {
	if (props.document.length === 0 || props.averageDocumentLength === 0) {
		return 0;
	}

	let score = 0;
	for (const queryTerm of props.queryTerms) {
		const termFrequency = props.document.termCounts.get(queryTerm) ?? 0;
		if (termFrequency === 0) {
			continue;
		}

		const inverseDocumentFrequency = props.idfByTerm.get(queryTerm) ?? 0;
		if (inverseDocumentFrequency <= 0) {
			continue;
		}

		const denominator =
			termFrequency +
			props.settings.k1 *
				(1 -
					props.settings.b +
					props.settings.b * (props.document.length / props.averageDocumentLength));
		if (denominator === 0) {
			continue;
		}

		score +=
			inverseDocumentFrequency *
			((termFrequency * (props.settings.k1 + 1)) / denominator);
	}

	return score;
}

export function createBm25Index<TDocumentId extends string>(
	props: Bm25IndexProps<TDocumentId>,
): Bm25Index<TDocumentId> {
	const settings = {
		b: props.b ?? 0.75,
		k1: props.k1 ?? 1.2,
	} satisfies Bm25Settings;
	const documents = props.documents.map(createIndexedDocument);
	const documentCount = documents.length;
	const totalDocumentLength = documents.reduce((total, document) => total + document.length, 0);
	const averageDocumentLength = documentCount === 0 ? 0 : totalDocumentLength / documentCount;
	const documentFrequency = calculateDocumentFrequency(documents);
	const idfByTerm = calculateIdfByTerm(documentCount, documentFrequency);

	return {
		search(query: Bm25SearchQuery): readonly Bm25SearchResult<TDocumentId>[] {
			const limit = normalizeSearchLimit(query.limit);
			if (limit === 0) {
				return [];
			}

			const queryTerms = Array.from(new Set(tokenizeSearchText(query.query)));
			if (queryTerms.length === 0) {
				return [];
			}

			return documents
				.map((document) => ({
					id: document.id,
					score: scoreDocument({
						averageDocumentLength,
						document,
						idfByTerm,
						queryTerms,
						settings,
					}),
				}))
				.filter((result) => result.score > 0)
				.toSorted((left, right) => {
					if (right.score !== left.score) {
						return right.score - left.score;
					}
					return left.id.localeCompare(right.id);
				})
				.slice(0, limit);
		},
	};
}
```

- [ ] **Step 2: Run tokenizer and BM25 tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test:unit -- search/tokenizer.test.ts search/bm25-index.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package typecheck**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit BM25 index**

Run:

```bash
git add packages/mcp-portal/src/search/bm25-index.ts packages/mcp-portal/src/search/bm25-index.test.ts
git commit -m "feat: add mcp portal bm25 index

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Export The Search Mechanism

**Files:**
- Create: `packages/mcp-portal/src/search/index.ts`
- Modify: `packages/mcp-portal/src/index.ts`
- Modify: `packages/mcp-portal/package.json`

- [ ] **Step 1: Add the search barrel**

Create `packages/mcp-portal/src/search/index.ts`:

```ts
export {
	createBm25Index,
	type Bm25Document,
	type Bm25Index,
	type Bm25IndexProps,
	type Bm25SearchQuery,
	type Bm25SearchResult,
} from './bm25-index.js';
export { tokenizeSearchText } from './tokenizer.js';
```

- [ ] **Step 2: Add package exports**

In `packages/mcp-portal/package.json`, add `./search` beside the existing package subpath exports:

```json
"./search": {
	"types": "./dist/search/index.d.ts",
	"import": "./dist/search/index.js"
}
```

If `packages/mcp-portal/src/index.ts` exports library surfaces, add:

```ts
export * from './search/index.js';
```

- [ ] **Step 3: Guard the export surface**

Run:

```bash
rg -n "\"\\./search\"|from './search/index.js'|from './search/" packages/mcp-portal/package.json packages/mcp-portal/src/index.ts packages/mcp-portal/src/core packages/mcp-portal/src/mcp-proxy
```

Expected:

- `package.json` exposes `./search`.
- `src/index.ts` may export `./search/index.js`.
- `src/core` and `src/mcp-proxy` do not import `src/search/*`.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit search mechanism export**

Run:

```bash
git add packages/mcp-portal/src/search/index.ts packages/mcp-portal/src/index.ts packages/mcp-portal/package.json
git commit -m "feat: export mcp portal search mechanism

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 6: Add Search Index Integration Tests Before Rewiring

**Files:**
- Modify: `packages/mcp-portal/src/search-index.test.ts`

- [ ] **Step 1: Add failing integration tests**

Append tests inside the existing `describe('scoped search index', () => { ... })` block in `packages/mcp-portal/src/search-index.test.ts`:

```ts
	it('uses BM25 ranking over tokenized catalog text', () => {
		const searchIndex = createSearchIndex([
			{
				description: 'Create a GitHub issue with title and body.',
				inputSchema: {
					properties: { body: { type: 'string' }, title: { type: 'string' } },
					type: 'object',
				},
				namespace: 'github',
				toolName: 'create_issue',
			},
			{
				description: 'Search Linear issues by assignee, team, project, and bug triage terms.',
				inputSchema: {
					properties: {
						assigneeId: { type: 'string' },
						filter: {
							properties: {
								teamKey: { type: 'string' },
							},
							type: 'object',
						},
						query: { type: 'string' },
					},
					type: 'object',
				},
				namespace: 'linear',
				toolName: 'search_issues',
			},
			{
				description: 'Search saved highlights and annotations.',
				inputSchema: {
					properties: { query: { type: 'string' } },
					type: 'object',
				},
				namespace: 'readwise',
				toolName: 'search_highlights',
			},
		]);

		const results = searchIndex.search({ query: 'assignee bug team-key', limit: 10 }).results;

		expect(results.map((result) => result.toolRef)).toEqual([
			encodeToolRef({ namespace: 'linear', toolName: 'search_issues' }),
		]);
		expect(results[0]?.schemaFieldMatches).toEqual(['assigneeId', 'teamKey']);
	});

	it('does not index JSON Schema reserved keys, type values, defaults, or output schema text', () => {
		const searchIndex = createSearchIndex([
			{
				inputSchema: {
					additionalProperties: false,
					properties: {
						status: { default: 'backlog', enum: ['backlog', 'done'], type: 'string' },
						title: { description: 'Customer visible summary', type: 'string' },
					},
					required: ['title'],
					type: 'object',
				},
				namespace: 'linear',
				outputSchema: {
					properties: {
						secretToken: { type: 'string' },
					},
					type: 'object',
				},
				toolName: 'create_issue',
			},
		]);

		expect(
			searchIndex.search({
				query: 'object string properties additionalProperties required backlog customer token',
				limit: 10,
			}).results,
		).toEqual([]);
		expect(searchIndex.search({ query: 'title status', limit: 10 }).results.map((result) => result.toolRef)).toEqual([
			encodeToolRef({ namespace: 'linear', toolName: 'create_issue' }),
		]);
	});

	it('matches recursive input field names with split-token some semantics', () => {
		const searchIndex = createSearchIndex([
			{
				inputSchema: {
					properties: {
						filter: {
							properties: {
								teamKey: { type: 'string' },
							},
							type: 'object',
						},
						issueId: { type: 'string' },
					},
					type: 'object',
				},
				namespace: 'linear',
				toolName: 'search_issues',
			},
		]);

		expect(searchIndex.search({ query: 'team', limit: 10 }).results[0]?.schemaFieldMatches).toEqual(['teamKey']);
		expect(searchIndex.search({ query: 'id', limit: 10 }).results[0]?.schemaFieldMatches).toEqual(['issueId']);
	});

	it('keeps namespace filters after BM25 ranking', () => {
		const searchIndex = createSearchIndex([
			{
				description: 'Search Linear issues.',
				inputSchema: { type: 'object' },
				namespace: 'linear',
				toolName: 'search_issues',
			},
			{
				description: 'Search GitHub issues.',
				inputSchema: { type: 'object' },
				namespace: 'github',
				toolName: 'search_issues',
			},
		]);

		expect(
			searchIndex.search({ query: 'search issues', namespaces: ['github'], limit: 10 }).results.map(
				(result) => result.toolRef,
			),
		).toEqual([encodeToolRef({ namespace: 'github', toolName: 'search_issues' })]);
	});

	it('treats non-finite search limits as empty result requests', () => {
		const searchIndex = createSearchIndex([
			{
				description: 'Search Linear issues.',
				inputSchema: { type: 'object' },
				namespace: 'linear',
				toolName: 'search_issues',
			},
		]);

		expect(searchIndex.search({ query: 'linear', limit: Number.NaN }).results).toEqual([]);
		expect(searchIndex.search({ query: 'linear', limit: Number.POSITIVE_INFINITY }).results).toEqual([]);
	});
```

- [ ] **Step 2: Run search-index tests and verify failure**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test:unit -- search-index.test.ts
```

Expected: FAIL because current `search-index.ts`:

- uses substring scoring,
- indexes schema string values,
- indexes output schema content,
- reports only top-level input properties,
- does not guard `NaN` and `Infinity` limits.

- [ ] **Step 3: Do not commit the red tests**

Continue directly to Task 7.

---

### Task 7: Rewire Search Index To Use BM25

**Files:**
- Modify: `packages/mcp-portal/src/search-index.ts`
- Test: `packages/mcp-portal/src/search-index.test.ts`

- [ ] **Step 1: Update imports**

Modify the import block at the top of `packages/mcp-portal/src/search-index.ts`:

```ts
import { createBm25Index, tokenizeSearchText } from './search/index.js';
import { portalToolRecordSchema, type PortalToolRecord } from './catalog-types.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json-schema.js';
import type { ToolGraph, ToolRelationship } from './tool-graph.js';
import { createToolSummary, type ToolSummary } from './tool-summary.js';
```

- [ ] **Step 2: Replace schema collection and field matching helpers**

In `packages/mcp-portal/src/search-index.ts`, replace `collectSchemaText`, `normalizeSearchText`, `buildSearchText`, `propertiesFromSchema`, and `scoreEntry` with helpers that:

- recursively collect input schema property names from `properties`, `items`, `allOf`, `anyOf`, `oneOf`, and object-valued `additionalProperties`,
- never collect schema structural keys or schema scalar values,
- build search text from the contract above,
- use `tokenizeSearchText` for field matching,
- normalize non-finite and negative limits to zero.

- [ ] **Step 3: Build the BM25 index once per `SearchIndex`**

Inside `createSearchIndex`, keep the existing `entries` mapper but build a BM25 index after entries are constructed:

```ts
	const bm25Index = createBm25Index({
		documents: entries.map((entry) => ({
			id: entry.summary.toolRef,
			text: entry.searchText,
		})),
	});
	const entriesByToolRef = new Map(entries.map((entry) => [entry.summary.toolRef, entry]));
```

- [ ] **Step 4: Replace the `search` method body**

For non-empty queries, call `bm25Index.search({ query, limit: entries.length })`, map IDs back to entries, then apply namespace filtering. For empty queries, keep deterministic list-style results over filtered entries. Always apply the normalized limit before returning.

- [ ] **Step 5: Verify stale helpers are gone**

Run:

```bash
rg -n "normalizeSearchText|scoreEntry|collectSchemaText" packages/mcp-portal/src/search-index.ts
```

Expected: no matches.

- [ ] **Step 6: Run search-index tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test:unit -- search-index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run package unit tests and typecheck**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test:unit
pnpm --filter @agent-vm/mcp-portal typecheck
```

Expected: both commands PASS.

- [ ] **Step 8: Commit search integration**

Run:

```bash
git add packages/mcp-portal/src/search-index.ts packages/mcp-portal/src/search-index.test.ts
git commit -m "feat: rank mcp portal search with bm25

Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 8: Guard Current Runtime Surfaces

**Files:**
- Inspect: `packages/mcp-portal/src/bin/mcp-portal.test.ts`
- Inspect: `packages/mcp-portal/src/cli/serve-command.test.ts`
- Inspect: `packages/mcp-portal/src/core/portal-tools.test.ts`
- Inspect: `packages/mcp-portal/src/core/portal-core.test.ts`
- Inspect: `packages/mcp-portal/src/mcp-proxy/portal-mcp-server.test.ts`
- Inspect: `packages/mcp-portal/src/mcp-proxy/portal-http-server.test.ts`

- [ ] **Step 1: Confirm imports respect the boundary**

Run:

```bash
rg -n "from '../search|from '../../search|from './search" packages/mcp-portal/src/bin packages/mcp-portal/src/cli packages/mcp-portal/src/core packages/mcp-portal/src/mcp-proxy
```

Expected: no matches. `bin`, `cli`, `core`, and `mcp-proxy` stay above the search mechanism.

- [ ] **Step 2: Run CLI, core, and proxy regression tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test:unit -- bin/mcp-portal.test.ts
pnpm --filter @agent-vm/mcp-portal test:unit -- cli/serve-command.test.ts
pnpm --filter @agent-vm/mcp-portal test:unit -- core/portal-tools.test.ts
pnpm --filter @agent-vm/mcp-portal test:unit -- core/portal-core.test.ts
pnpm --filter @agent-vm/mcp-portal test:unit -- mcp-proxy/portal-mcp-server.test.ts
pnpm --filter @agent-vm/mcp-portal test:unit -- mcp-proxy/portal-http-server.test.ts
```

Expected: all commands PASS.

- [ ] **Step 3: Confirm keyed search output remains covered**

Run:

```bash
rg -n "searches multiple requests and keys each output by request id" packages/mcp-portal/src/core/portal-tools.test.ts
```

Expected: one matching test.

- [ ] **Step 4: Commit only if this task changed files**

If Task 8 changed files, run:

```bash
git add packages/mcp-portal/src/bin/mcp-portal.test.ts packages/mcp-portal/src/cli/serve-command.test.ts packages/mcp-portal/src/core/portal-tools.test.ts packages/mcp-portal/src/core/portal-core.test.ts packages/mcp-portal/src/mcp-proxy/portal-mcp-server.test.ts packages/mcp-portal/src/mcp-proxy/portal-http-server.test.ts
git commit -m "test: preserve mcp portal core search surface

Co-authored-by: Codex <noreply@openai.com>"
```

If Task 8 changed nothing, do not create an empty commit.

---

### Task 9: Full Verification

**Files:**
- Verify package and monorepo gates.

- [ ] **Step 1: Run MCP Portal unit tests**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal test:unit
```

Expected: PASS.

- [ ] **Step 2: Run MCP Portal typecheck**

Run:

```bash
pnpm --filter @agent-vm/mcp-portal typecheck
```

Expected: PASS.

- [ ] **Step 3: Run repository check**

Run:

```bash
pnpm check
```

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD
git diff --check
```

Expected:

- only intentional BM25 search files are modified,
- no whitespace errors,
- no `mcp-portal.config.jsonc` schema changes,
- no facets,
- no tool hints,
- no rank-fusion wiring,
- no Hono, OpenClaw, bin, CLI, core, proxy, auth, or config imports in `src/search/*`.

- [ ] **Step 5: Final review checklist**

Confirm all items before opening a PR:

- `search/tokenizer.test.ts` directly covers tokenizer behavior.
- `search/bm25-index.test.ts` directly covers BM25 ranking behavior.
- `search/bm25-index.test.ts` covers repeated query terms and no stemming.
- `search/bm25-index.test.ts` covers non-finite and negative limits.
- `search/index.ts` exports the reusable search mechanism.
- `package.json` exports `./search`.
- `search-index.test.ts` covers BM25 integration.
- `search-index.test.ts` covers recursive input schema property names.
- `search-index.test.ts` covers schema noise exclusion.
- `search-index.test.ts` covers namespace filters.
- Empty query remains deterministic list-style search.
- `mcp_portal_search` response shape remains request-keyed through `core/portal-tools.test.ts`.
- `mcp-portal` CLI behavior remains covered through `bin/mcp-portal.test.ts`.
- `mcp-proxy serve` startup behavior remains covered through `cli/serve-command.test.ts`.
- Hono Streamable HTTP auth/session behavior remains covered through `mcp-proxy/portal-http-server.test.ts`.
- No facets, search config, vectors, tool hints, or rank fusion are introduced.

---

## Self-Review Notes

- Spec coverage: This plan covers the current `bin` + `cli` + `/core` + `/mcp-proxy` package layout, a reusable search library mechanism, tokenizer contract, TDD-first red tests, integration rewiring, public-surface exports, and full verification.
- Type consistency: The search mechanism types are `Bm25Document`, `Bm25IndexProps`, `Bm25SearchQuery`, `Bm25SearchResult`, and `Bm25Index`; later tasks refer to those exact names.
- Scope guard: v1 is BM25 plus tokenizer only. Facets, vectors, search hints, and config enrichment are intentionally excluded.
