import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type {
	ComposeResourceProvider,
	FinalizedResource,
	FinalizeRepoResourceSetupInput,
	RepoResourceRequirement,
	RepoResourcesDescription,
	RepoResourcesFinal,
	ResourceBinding,
	ResourceEnv,
} from './repo-resource-contract-types.js';
import {
	externalResourcesSchema,
	generatedPathSchema,
	repoResourcesDescriptionSchema,
	repoTargetSchema,
	workerTaskRequestSchema,
	zoneResourcesPolicySchema,
} from './resource-contract-schemas.js';
import type {
	composeResourceProviderSchema,
	finalizedResourceSchema,
	finalizeRepoResourceSetupInputSchema,
	repoResourceRequirementSchema,
	repoResourcesFinalSchema,
	resourceBindingSchema,
	resourceEnvSchema,
} from './resource-contract-schemas.js';

describe('resource contract schemas', () => {
	it('keeps Zod schemas assignable to repo resource contract types', () => {
		expectTypeOf<z.output<typeof resourceBindingSchema>>().toMatchTypeOf<ResourceBinding>();
		expectTypeOf<ResourceBinding>().toMatchTypeOf<z.input<typeof resourceBindingSchema>>();
		expectTypeOf<z.output<typeof resourceEnvSchema>>().toMatchTypeOf<ResourceEnv>();
		expectTypeOf<ResourceEnv>().toMatchTypeOf<z.input<typeof resourceEnvSchema>>();
		expectTypeOf<
			z.output<typeof repoResourceRequirementSchema>
		>().toMatchTypeOf<RepoResourceRequirement>();
		expectTypeOf<RepoResourceRequirement>().toMatchTypeOf<
			z.input<typeof repoResourceRequirementSchema>
		>();
		expectTypeOf<
			z.output<typeof composeResourceProviderSchema>
		>().toMatchTypeOf<ComposeResourceProvider>();
		expectTypeOf<ComposeResourceProvider>().toMatchTypeOf<
			z.input<typeof composeResourceProviderSchema>
		>();
		expectTypeOf<
			z.output<typeof repoResourcesDescriptionSchema>
		>().toMatchTypeOf<RepoResourcesDescription>();
		expectTypeOf<RepoResourcesDescription>().toMatchTypeOf<
			z.input<typeof repoResourcesDescriptionSchema>
		>();
		expectTypeOf<
			z.output<typeof finalizeRepoResourceSetupInputSchema>
		>().toMatchTypeOf<FinalizeRepoResourceSetupInput>();
		expectTypeOf<FinalizeRepoResourceSetupInput>().toMatchTypeOf<
			z.input<typeof finalizeRepoResourceSetupInputSchema>
		>();
		expectTypeOf<z.output<typeof finalizedResourceSchema>>().toMatchTypeOf<FinalizedResource>();
		expectTypeOf<FinalizedResource>().toMatchTypeOf<z.input<typeof finalizedResourceSchema>>();
		expectTypeOf<z.output<typeof repoResourcesFinalSchema>>().toMatchTypeOf<RepoResourcesFinal>();
		expectTypeOf<RepoResourcesFinal>().toMatchTypeOf<z.input<typeof repoResourcesFinalSchema>>();
	});

	it('accepts repo resource descriptions with separate requires and provides maps', () => {
		const parsed = repoResourcesDescriptionSchema.parse({
			setupCommand: '.agent-vm/run-setup.sh',
			requires: {
				pg: {
					binding: { host: 'pg.local', port: 5432 },
					env: { DATABASE_URL: 'postgres://app:app@pg.local:5432/app' },
				},
				'pg-blah': {
					binding: { host: 'pg-blah.local', port: 5432 },
					env: {},
				},
			},
			provides: {
				pg: {
					type: 'compose',
					service: 'pg',
				},
			},
		});

		expect(Object.keys(parsed.requires)).toEqual(['pg', 'pg-blah']);
		expect(parsed.setupCommand).toBe('.agent-vm/run-setup.sh');
		expect(parsed.provides.pg).toEqual({ type: 'compose', service: 'pg' });
	});

	it('defaults repo-level setup metadata for resource descriptions', () => {
		const parsed = repoResourcesDescriptionSchema.parse({
			requires: {},
			provides: {
				pg: {
					type: 'compose',
					service: 'pg',
				},
			},
		});

		expect(parsed.setupCommand).toBe('.agent-vm/run-setup.sh');
	});

	it('rejects resource bindings outside the TCP port range', () => {
		expect(() =>
			repoResourcesDescriptionSchema.parse({
				requires: {
					pg: {
						binding: { host: 'pg.local', port: 70_000 },
						env: {},
					},
				},
				provides: {},
			}),
		).toThrow(/Too big/u);
	});

	it('rejects generated paths that escape the resource output directory', () => {
		expect(() =>
			generatedPathSchema.parse({
				kind: 'file',
				path: '../secrets.json',
			}),
		).toThrow(/traversal/u);
		expect(() =>
			generatedPathSchema.parse({
				kind: 'directory',
				path: '/tmp/secrets',
			}),
		).toThrow(/relative/u);
	});

	it('accepts task requests with external resources but no request-side repoResources', () => {
		const parsed = workerTaskRequestSchema.parse({
			prompt: 'wire both repos to pg',
			repos: [{ repoUrl: 'https://github.com/example/app.git', baseBranch: 'main' }],
			context: {},
			resources: {
				externalResources: {
					pg: {
						name: 'pg',
						binding: { host: 'pg.local', port: 5432 },
						target: { host: 'example-postgres.internal', port: 5432 },
						env: { DATABASE_URL: 'postgres://example-postgres.internal:5432/app' },
					},
				},
			},
		});

		expect(parsed.resources.externalResources.pg?.target.host).toBe('example-postgres.internal');
		expect('repoResources' in parsed.resources).toBe(false);
	});

	it('rejects resource env keys reserved for gateway boot at the schema boundary', () => {
		expect(() =>
			repoResourcesDescriptionSchema.parse({
				requires: {
					pg: {
						binding: { host: 'pg.local', port: 5432 },
						env: { PATH: '/tmp/fake-bin' },
					},
				},
				provides: {},
			}),
		).toThrow(/reserved environment key 'PATH'/u);
		expect(() =>
			externalResourcesSchema.parse({
				pg: {
					name: 'pg',
					binding: { host: 'pg.local', port: 5432 },
					target: { host: 'example-postgres.internal', port: 5432 },
					env: { NODE_OPTIONS: '--require ./exfiltrate.js' },
				},
			}),
		).toThrow(/reserved environment key 'NODE_OPTIONS'/u);
	});

	it('enforces controller task request bounds and repo URLs', () => {
		expect(() =>
			workerTaskRequestSchema.parse({
				prompt: 'x'.repeat(10_001),
				repos: [],
				context: {},
				resources: { externalResources: {} },
			}),
		).toThrow(/Too big/u);
		expect(() =>
			repoTargetSchema.parse({
				repoUrl: 'not-a-url',
				baseBranch: 'main',
			}),
		).toThrow(/Invalid URL/u);
		expect(() =>
			repoTargetSchema.parse({
				repoUrl: `https://github.com/example/${'a'.repeat(490)}.git`,
				baseBranch: 'main',
			}),
		).toThrow(/Too big/u);
		expect(() =>
			repoTargetSchema.parse({
				repoUrl: 'https://github.com/example/app.git',
				baseBranch: 'x'.repeat(201),
			}),
		).toThrow(/Too big/u);
		expect(repoTargetSchema.parse({ repoUrl: 'https://github.com/example/app.git' })).toEqual({
			repoUrl: 'https://github.com/example/app.git',
			baseBranch: 'main',
		});
		expect(() =>
			workerTaskRequestSchema.parse({
				prompt: 'wire repos',
				repos: Array.from({ length: 21 }, (_, index) => ({
					repoUrl: `https://github.com/example/app-${String(index)}.git`,
				})),
				context: {},
				resources: { externalResources: {} },
			}),
		).toThrow(/Too big/u);
	});

	it('rejects setup commands that escape the repo', () => {
		expect(() =>
			repoResourcesDescriptionSchema.parse({
				setupCommand: '/etc/cronjob.sh',
				requires: {},
				provides: {},
			}),
		).toThrow(/relative/u);
		expect(() =>
			repoResourcesDescriptionSchema.parse({
				setupCommand: '../outside.sh',
				requires: {},
				provides: {},
			}),
		).toThrow(/traversal/u);
		expect(() =>
			repoResourcesDescriptionSchema.parse({
				setupCommand: '.agent-vm/../outside.sh',
				requires: {},
				provides: {},
			}),
		).toThrow(/traversal/u);
	});

	it('rejects provider-level setupCommand because setup is repo-level', () => {
		expect(() =>
			repoResourcesDescriptionSchema.parse({
				requires: {},
				provides: {
					pg: {
						type: 'compose',
						service: 'pg',
						setupCommand: '.agent-vm/run-setup.sh',
					},
				},
			}),
		).toThrow(/Unrecognized key/u);
	});

	it('rejects external resource entries whose key and name differ', () => {
		expect(() =>
			externalResourcesSchema.parse({
				pg: {
					name: 'pg-blah',
					binding: { host: 'pg.local', port: 5432 },
					target: { host: 'db.internal', port: 5432 },
					env: {},
				},
			}),
		).toThrow(/must match/u);
	});

	it('rejects legacy repo contract fields instead of silently stripping them', () => {
		expect(() =>
			repoResourcesDescriptionSchema.parse({
				requires: {
					pg: {
						binding: { host: 'pg.local', port: 5432 },
						env: {},
						kind: 'postgres',
					},
				},
				provides: {
					pg: {
						type: 'compose',
						service: 'pg',
						hookId: 'old-hook',
					},
				},
				setupHookIds: ['old-hook'],
			}),
		).toThrow(/setupHookIds|kind|hookId/u);
	});

	it('rejects legacy request-side repoResources payloads', () => {
		expect(() =>
			workerTaskRequestSchema.parse({
				prompt: 'wire both repos to pg',
				repos: [],
				context: {},
				resources: {
					externalResources: {},
					repoResources: [{ name: 'pg' }],
				},
			}),
		).toThrow(/repoResources/u);
	});

	it('supports boolean and URL-list zone repo-resource policy', () => {
		expect(zoneResourcesPolicySchema.parse({})).toEqual({
			allowRepoResources: true,
		});
		expect(zoneResourcesPolicySchema.parse({ allowRepoResources: true })).toEqual({
			allowRepoResources: true,
		});
		expect(
			zoneResourcesPolicySchema.parse({
				allowRepoResources: ['https://github.com/example/app.git'],
			}),
		).toEqual({
			allowRepoResources: ['https://github.com/example/app.git'],
		});
		expect(() =>
			zoneResourcesPolicySchema.parse({
				allowRepoResources: true,
				allowedKinds: ['postgres'],
			}),
		).toThrow(/allowedKinds/u);
	});
});
