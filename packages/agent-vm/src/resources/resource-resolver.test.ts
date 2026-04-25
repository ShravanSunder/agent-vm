import { describe, expect, it } from 'vitest';

import { resolveTaskResources } from './resource-resolver.js';

describe('resolveTaskResources', () => {
	it('dedupes logical resource names by task while keeping pg and pg-blah distinct', () => {
		const resolved = resolveTaskResources({
			allowRepoResources: true,
			externalResources: {},
			repos: [
				{
					repoId: 'repo-a',
					repoUrl: 'https://github.com/example/repo-a.git',
					description: {
						setupCommand: '.agent-vm/run-setup.sh',
						requires: {
							pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
							'pg-blah': { binding: { host: 'pg-blah.local', port: 5432 }, env: {} },
						},
						provides: {
							pg: {
								type: 'compose',
								service: 'pg',
							},
							'pg-blah': {
								type: 'compose',
								service: 'pg',
							},
						},
					},
				},
				{
					repoId: 'repo-b',
					repoUrl: 'https://github.com/example/repo-b.git',
					description: {
						setupCommand: '.agent-vm/run-setup.sh',
						requires: {
							pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
						},
						provides: {
							pg: {
								type: 'compose',
								service: 'pg',
							},
						},
					},
				},
			],
		});

		expect(resolved.selectedRepoProviders.map((provider) => provider.resourceName)).toEqual([
			'pg',
			'pg-blah',
		]);
		expect(resolved.selectedRepoProviders[0]?.repoId).toBe('repo-a');
		expect(resolved.selectedRepoProviders[0]?.setupCommand).toBe('.agent-vm/run-setup.sh');
		expect(resolved.selectedRepoProviders[1]?.provider.service).toBe('pg');
	});

	it('uses external resources as authoritative and does not select repo providers for the same name', () => {
		const resolved = resolveTaskResources({
			allowRepoResources: true,
			externalResources: {
				pg: {
					name: 'pg',
					binding: { host: 'pg.local', port: 5432 },
					target: { host: 'example-postgres.internal', port: 5432 },
					env: { DATABASE_URL: 'postgres://example-postgres.internal:5432/app' },
				},
			},
			repos: [
				{
					repoId: 'repo-a',
					repoUrl: 'https://github.com/example/repo-a.git',
					description: {
						setupCommand: '.agent-vm/run-setup.sh',
						requires: {
							pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
						},
						provides: {
							pg: {
								type: 'compose',
								service: 'pg',
							},
						},
					},
				},
			],
		});

		expect(resolved.selectedRepoProviders).toEqual([]);
		expect(resolved.externalResources.pg?.target.host).toBe('example-postgres.internal');
	});

	it('rejects deduped repo resources when consumers disagree on the binding', () => {
		expect(() =>
			resolveTaskResources({
				allowRepoResources: true,
				externalResources: {},
				repos: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						description: {
							setupCommand: '.agent-vm/run-setup.sh',
							requires: {
								pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
							},
							provides: {
								pg: {
									type: 'compose',
									service: 'pg',
								},
							},
						},
					},
					{
						repoId: 'repo-b',
						repoUrl: 'https://github.com/example/repo-b.git',
						description: {
							setupCommand: '.agent-vm/run-setup.sh',
							requires: {
								pg: { binding: { host: 'postgres.local', port: 5432 }, env: {} },
							},
							provides: {},
						},
					},
				],
			}),
		).toThrow(/conflicting bindings/u);
	});

	it('rejects external resources whose binding disagrees with repo requirements', () => {
		expect(() =>
			resolveTaskResources({
				allowRepoResources: true,
				externalResources: {
					pg: {
						name: 'pg',
						binding: { host: 'postgres.local', port: 5432 },
						target: { host: 'example-postgres.internal', port: 5432 },
						env: {},
					},
				},
				repos: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						description: {
							setupCommand: '.agent-vm/run-setup.sh',
							requires: {
								pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
							},
							provides: {},
						},
					},
				],
			}),
		).toThrow(/does not match required binding/u);
	});

	it('enforces zone allowRepoResources before selecting repo providers', () => {
		expect(() =>
			resolveTaskResources({
				allowRepoResources: ['https://github.com/example/allowed.git'],
				externalResources: {},
				repos: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/blocked.git',
						description: {
							setupCommand: '.agent-vm/run-setup.sh',
							requires: {
								pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
							},
							provides: {
								pg: {
									type: 'compose',
									service: 'pg',
								},
							},
						},
					},
				],
			}),
		).toThrow(/not allowed/u);
	});

	it('normalizes allowRepoResources URL entries before matching provider repos', () => {
		const resolved = resolveTaskResources({
			allowRepoResources: ['https://github.com/example/allowed'],
			externalResources: {},
			repos: [
				{
					repoId: 'allowed',
					repoUrl: 'https://github.com/example/allowed.git/',
					description: {
						setupCommand: '.agent-vm/run-setup.sh',
						requires: {
							pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
						},
						provides: {
							pg: {
								type: 'compose',
								service: 'pg',
							},
						},
					},
				},
			],
		});

		expect(resolved.selectedRepoProviders).toHaveLength(1);
	});

	it('rejects required resources without an external resource or repo provider', () => {
		expect(() =>
			resolveTaskResources({
				allowRepoResources: true,
				externalResources: {},
				repos: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						description: {
							setupCommand: '.agent-vm/run-setup.sh',
							requires: {
								pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
							},
							provides: {},
						},
					},
				],
			}),
		).toThrow(/no external resource or repo provider/u);
	});

	it('rejects malformed repo resource allow-list URLs', () => {
		expect(() =>
			resolveTaskResources({
				allowRepoResources: ['not a url'],
				externalResources: {},
				repos: [
					{
						repoId: 'repo-a',
						repoUrl: 'https://github.com/example/repo-a.git',
						description: {
							setupCommand: '.agent-vm/run-setup.sh',
							requires: {
								pg: { binding: { host: 'pg.local', port: 5432 }, env: {} },
							},
							provides: {
								pg: {
									type: 'compose',
									service: 'pg',
								},
							},
						},
					},
				],
			}),
		).toThrow(/Invalid repo resource allow-list URL/u);
	});
});
