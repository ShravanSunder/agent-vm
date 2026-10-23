import { describe, expect, it } from 'vitest';

import { collectAuthCoreViolations } from './audit-portal-architecture.js';

describe('auth core dependency boundary', () => {
	it.each([
		"import { betterAuth } from 'better-auth';",
		"export * from '@better-auth/oauth-provider';",
		"export type Database = import('@cloudflare/workers-types').D1Database;",
		"import '#auth/d1-persistence/person-admission-store';",
		"const load = () => import('#auth/better-auth-provider/provider-configuration');",
		"import { WorkerEntrypoint } from 'cloudflare:workers';",
		'export interface Store { database: D1Database }',
		"export type Database = AuthWorkerEnv['DB'];",
		"import '#auth/cloudflare-host/worker-configuration.gen';",
	])('rejects an auth core runtime dependency: %s', (sourceText) => {
		expect(
			collectAuthCoreViolations({
				filePath: 'packages/auth/src/sign-in-core/client-policy.ts',
				sourceText,
			}).length,
		).toBeGreaterThan(0);
	});
	it('permits Web requests, parsed domain values and injected semantic ports', () => {
		expect(
			collectAuthCoreViolations({
				filePath: 'packages/auth/src/sign-in-core/client-policy.ts',
				sourceText:
					"import { z } from 'zod'; export const answer = (request: Request): Response => Response.json({url:request.url});",
			}),
		).toEqual([]);
	});
	it('leaves the Better Auth adapter with its own runtime dependencies', () => {
		expect(
			collectAuthCoreViolations({
				filePath: 'packages/auth/src/better-auth-provider/provider-configuration.ts',
				sourceText: "import { betterAuth } from 'better-auth';",
			}),
		).toEqual([]);
	});
});
