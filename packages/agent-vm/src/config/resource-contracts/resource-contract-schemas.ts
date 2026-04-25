import { z } from 'zod';

export const resourceNameSchema = z
	.string()
	.min(1)
	.regex(/^[a-z][a-z0-9-]*$/u, 'resource names must use lowercase letters, numbers, and hyphens');

export const resourceBindingSchema = z
	.object({
		host: z.string().min(1),
		port: z.number().int().min(1).max(65_535),
	})
	.strict();

export const RESERVED_RESOURCE_ENV_KEYS = new Set([
	'HOME',
	'LD_LIBRARY_PATH',
	'LD_PRELOAD',
	'NODE_OPTIONS',
	'OLDPWD',
	'OPENCLAW_CONFIG_PATH',
	'PATH',
	'PWD',
	'PYTHONPATH',
	'SHLVL',
	'WORKER_CONFIG_PATH',
	'_',
]);

export const resourceEnvSchema = z
	.record(z.string().min(1), z.string())
	.superRefine((resourceEnv, context) => {
		for (const key of Object.keys(resourceEnv)) {
			if (RESERVED_RESOURCE_ENV_KEYS.has(key)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [key],
					message: `Resource env contains reserved environment key '${key}'.`,
				});
			}
		}
	})
	.default(() => ({}));

function hasPathTraversal(value: string): boolean {
	return value.split('/').includes('..');
}

function isRelativeContainedPath(value: string): boolean {
	return !value.startsWith('/') && !hasPathTraversal(value);
}

export const generatedPathSchema = z
	.object({
		kind: z.enum(['file', 'directory']),
		path: z
			.string()
			.min(1)
			.refine((value) => !value.startsWith('/'), 'path must be relative')
			.refine((value) => !hasPathTraversal(value), 'path must not contain traversal'),
		description: z.string().optional(),
	})
	.strict();

export const repoResourceRequirementSchema = z
	.object({
		binding: resourceBindingSchema,
		env: resourceEnvSchema,
	})
	.strict();

export const composeResourceProviderSchema = z
	.object({
		type: z.literal('compose'),
		service: z.string().min(1),
	})
	.strict();

export const repoResourcesDescriptionSchema = z
	.object({
		setupCommand: z
			.string()
			.min(1)
			.refine((value) => !value.startsWith('/'), 'setupCommand must be relative')
			.refine((value) => isRelativeContainedPath(value), 'setupCommand must not contain traversal')
			.default('.agent-vm/run-setup.sh'),
		requires: z.record(resourceNameSchema, repoResourceRequirementSchema).default(() => ({})),
		provides: z.record(resourceNameSchema, composeResourceProviderSchema).default(() => ({})),
	})
	.strict();

export const finalizeRepoResourceSetupInputSchema = z
	.object({
		repoId: z.string().min(1),
		repoUrl: z.string().min(1),
		repoDir: z.string().min(1),
		outputDir: z.string().min(1),
		selectedResources: z.record(
			resourceNameSchema,
			z
				.object({
					binding: resourceBindingSchema,
					target: resourceBindingSchema,
				})
				.strict(),
		),
	})
	.strict();

export const finalizedResourceSchema = z
	.object({
		binding: resourceBindingSchema,
		target: resourceBindingSchema,
		env: resourceEnvSchema,
	})
	.strict();

export const repoResourcesFinalSchema = z
	.object({
		resources: z.record(resourceNameSchema, finalizedResourceSchema).default(() => ({})),
		generated: z.array(generatedPathSchema).default(() => []),
	})
	.strict();

export const externalResourceSchema = z
	.object({
		name: resourceNameSchema,
		binding: resourceBindingSchema,
		target: resourceBindingSchema,
		env: resourceEnvSchema,
	})
	.strict();

export const externalResourcesSchema = z
	.record(resourceNameSchema, externalResourceSchema)
	.superRefine((resources, context) => {
		for (const [key, resource] of Object.entries(resources)) {
			if (resource.name !== key) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: [key, 'name'],
					message: `resource key '${key}' must match resource.name '${resource.name}'`,
				});
			}
		}
	})
	.default(() => ({}));

export const workerTaskResourcesSchema = z
	.object({
		externalResources: externalResourcesSchema,
	})
	.strict()
	.default(() => ({
		externalResources: {},
	}));

export const repoTargetSchema = z
	.object({
		repoUrl: z.string().min(1).max(500).url(),
		baseBranch: z.string().min(1).max(200).default('main'),
	})
	.strict();

export const workerTaskRequestSchema = z
	.object({
		prompt: z.string().min(1).max(10_000),
		repos: z
			.array(repoTargetSchema)
			.max(20)
			.default(() => []),
		context: z.record(z.string(), z.unknown()).default(() => ({})),
		resources: workerTaskResourcesSchema,
	})
	.strict();

export const workerTaskControllerRequestSchema = workerTaskRequestSchema.extend({
	requestTaskId: z.string().min(1),
});

export const zoneResourcesPolicySchema = z
	.object({
		allowRepoResources: z.union([z.boolean(), z.array(z.string().min(1))]).default(true),
	})
	.strict();

export type ResourceName = z.infer<typeof resourceNameSchema>;
export type GeneratedPath = z.infer<typeof generatedPathSchema>;
export type ResolvedRepoResourceRequirement = z.infer<typeof repoResourceRequirementSchema>;
export type ResolvedComposeResourceProvider = z.infer<typeof composeResourceProviderSchema>;
export type ResolvedRepoResourcesDescription = z.infer<typeof repoResourcesDescriptionSchema>;
export type ResolvedFinalizeRepoResourceSetupInput = z.infer<
	typeof finalizeRepoResourceSetupInputSchema
>;
export type ResolvedFinalizedResource = z.infer<typeof finalizedResourceSchema>;
export type ResolvedRepoResourcesFinal = z.infer<typeof repoResourcesFinalSchema>;
export type ExternalResource = z.infer<typeof externalResourceSchema>;
export type ExternalResources = z.infer<typeof externalResourcesSchema>;
export type WorkerTaskResources = z.infer<typeof workerTaskResourcesSchema>;
export type RepoTarget = z.infer<typeof repoTargetSchema>;
export type WorkerTaskRequestInput = z.input<typeof workerTaskRequestSchema>;
export type WorkerTaskRequest = z.infer<typeof workerTaskRequestSchema>;
export type WorkerTaskControllerRequestInput = z.input<typeof workerTaskControllerRequestSchema>;
export type WorkerTaskControllerRequest = z.infer<typeof workerTaskControllerRequestSchema>;
export type ZoneResourcesPolicy = z.infer<typeof zoneResourcesPolicySchema>;

export type {
	ComposeResourceProvider,
	FinalizedResource,
	FinalizeRepoResourceSetupInput,
	RepoResourceRequirement,
	RepoResourcesDescription,
	RepoResourcesFinal,
	ResourceBinding,
	ResourceEnv,
} from './repo-resource-contract-types.js';
