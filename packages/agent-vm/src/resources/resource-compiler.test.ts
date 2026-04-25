import { describe, expect, it } from 'vitest';

import { compileResourceOverlay } from './resource-compiler.js';

describe('compileResourceOverlay', () => {
	it('compiles finalized resources into tcpHosts, flat env, and read-only vfsMounts', () => {
		const overlay = compileResourceOverlay({
			externalResources: {
				pg: {
					name: 'pg',
					binding: { host: 'pg.local', port: 5432 },
					target: { host: 'example-postgres.internal', port: 5432 },
					env: { DATABASE_URL: 'postgres://example-postgres.internal:5432/app' },
				},
			},
			repoFinalizations: [
				{
					repoId: 'repo-a',
					outputDir: '/tmp/task/resources/repo-a',
					final: {
						resources: {
							'pg-blah': {
								binding: { host: 'pg-blah.local', port: 5432 },
								target: { host: '172.30.0.12', port: 5432 },
								env: { PG_BLAH_URL: 'postgres://pg-blah.local:5432/app' },
							},
						},
						generated: [{ kind: 'directory', path: 'unstructured' }],
					},
				},
			],
		});

		expect(overlay.tcpHosts).toEqual({
			'pg.local:5432': 'example-postgres.internal:5432',
			'pg-blah.local:5432': '172.30.0.12:5432',
		});
		expect(overlay.environment).toEqual({
			DATABASE_URL: 'postgres://example-postgres.internal:5432/app',
			PG_BLAH_URL: 'postgres://pg-blah.local:5432/app',
		});
		expect(overlay.vfsMounts).toEqual({
			'/agent-vm/resources/repo-a': {
				hostPath: '/tmp/task/resources/repo-a',
				kind: 'realfs-readonly',
			},
		});
	});

	it('mounts each finalized repo resource output directory even when no generated files were declared', () => {
		const overlay = compileResourceOverlay({
			externalResources: {},
			repoFinalizations: [
				{
					repoId: 'repo-a',
					outputDir: '/tmp/task/resources/repo-a',
					final: {
						resources: {},
						generated: [],
					},
				},
			],
		});

		expect(overlay.vfsMounts).toEqual({
			'/agent-vm/resources/repo-a': {
				hostPath: '/tmp/task/resources/repo-a',
				kind: 'realfs-readonly',
			},
		});
	});

	it('rejects resource env keys reserved for gateway boot', () => {
		expect(() =>
			compileResourceOverlay({
				externalResources: {
					pg: {
						name: 'pg',
						binding: { host: 'pg.local', port: 5432 },
						target: { host: 'example-postgres.internal', port: 5432 },
						env: { PATH: '/tmp/fake-bin' },
					},
				},
				repoFinalizations: [],
			}),
		).toThrow(/reserved environment key 'PATH'/u);
	});

	it('rejects conflicting env values across resources', () => {
		expect(() =>
			compileResourceOverlay({
				externalResources: {
					pg: {
						name: 'pg',
						binding: { host: 'pg.local', port: 5432 },
						target: { host: 'example-postgres.internal', port: 5432 },
						env: { DATABASE_URL: 'postgres://example-postgres.internal:5432/app' },
					},
					redis: {
						name: 'redis',
						binding: { host: 'redis.local', port: 6379 },
						target: { host: 'example-redis.internal', port: 6379 },
						env: { DATABASE_URL: 'redis://example-redis.internal:6379/0' },
					},
				},
				repoFinalizations: [],
			}),
		).toThrow(/conflicting environment key 'DATABASE_URL'/u);
	});

	it('allows duplicate env keys when the values are identical', () => {
		const overlay = compileResourceOverlay({
			externalResources: {
				pg: {
					name: 'pg',
					binding: { host: 'pg.local', port: 5432 },
					target: { host: 'example-postgres.internal', port: 5432 },
					env: { DATABASE_URL: 'postgres://example-postgres.internal:5432/app' },
				},
				'pg-readonly': {
					name: 'pg-readonly',
					binding: { host: 'pg-readonly.local', port: 5432 },
					target: { host: 'example-postgres.internal', port: 5432 },
					env: { DATABASE_URL: 'postgres://example-postgres.internal:5432/app' },
				},
			},
			repoFinalizations: [],
		});

		expect(overlay.environment.DATABASE_URL).toBe('postgres://example-postgres.internal:5432/app');
	});

	it('rejects conflicting tcp host bindings across resources', () => {
		expect(() =>
			compileResourceOverlay({
				externalResources: {
					pg: {
						name: 'pg',
						binding: { host: 'db.local', port: 5432 },
						target: { host: 'example-postgres.internal', port: 5432 },
						env: {},
					},
					'pg-blah': {
						name: 'pg-blah',
						binding: { host: 'db.local', port: 5432 },
						target: { host: 'repo-postgres.internal', port: 5432 },
						env: {},
					},
				},
				repoFinalizations: [],
			}),
		).toThrow(/conflicting TCP binding 'db.local:5432'/u);
	});

	it('rejects conflicting tcp host bindings between external and repo-finalized resources', () => {
		expect(() =>
			compileResourceOverlay({
				externalResources: {
					pg: {
						name: 'pg',
						binding: { host: 'db.local', port: 5432 },
						target: { host: 'example-postgres.internal', port: 5432 },
						env: {},
					},
				},
				repoFinalizations: [
					{
						repoId: 'repo-a',
						outputDir: '/tmp/task/resources/repo-a',
						final: {
							resources: {
								'pg-blah': {
									binding: { host: 'db.local', port: 5432 },
									target: { host: '172.30.0.12', port: 5432 },
									env: {},
								},
							},
							generated: [],
						},
					},
				],
			}),
		).toThrow(/conflicting TCP binding 'db.local:5432'/u);
	});
});
