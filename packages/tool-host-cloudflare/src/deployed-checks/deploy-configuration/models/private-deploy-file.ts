import { z } from 'zod';

const workerNameSchema = z.string().regex(/^[a-z0-9-]+$/u);
const httpsOriginSchema = z
	.url()
	.refine((value) => {
		const parsed = new URL(value);
		return (
			parsed.protocol === 'https:' &&
			parsed.pathname === '/' &&
			parsed.search === '' &&
			parsed.hash === '' &&
			parsed.username === '' &&
			parsed.password === ''
		);
	})
	.transform((value) => new URL(value).origin);
const privateWorkerSchema = z.strictObject({
	name: workerNameSchema,
	origin: httpsOriginSchema,
	workerId: z.string().min(1).optional(),
});
export const privateOrganizationSchema = z.strictObject({
	label: workerNameSchema,
	organizationId: z.uuid(),
	credential: z.string().min(16),
	approvalKeyHex: z.string().regex(/^[a-f0-9]{64}$/u),
});
export const privateDeployFileSchema = z
	.strictObject({
		runId: z.string().regex(/^[a-z0-9-]{8,70}$/u),
		accountId: z.string().regex(/^[a-f0-9]{32}$/u),
		portalA: privateWorkerSchema,
		portalB: privateWorkerSchema,
		helper: privateWorkerSchema,
		analyticsDataset: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/u),
		audience: z.string().min(1),
		agentId: z.string().min(1),
		otherAgentId: z.string().min(1),
		signingKeyId: z.string().min(1),
		privateSigningJwk: z.strictObject({
			kty: z.literal('EC'),
			crv: z.literal('P-256'),
			['x']: z.string().min(1),
			['y']: z.string().min(1),
			['d']: z.string().min(1),
		}),
		admissionSecret: z.string().min(16),
		access: z.strictObject({
			clientId: z.string().min(1),
			clientSecret: z.string().min(1),
			ownerEmail: z.email().optional(),
			serviceTokenId: z.string().min(1).optional(),
			applicationAId: z.string().min(1).optional(),
			applicationBId: z.string().min(1).optional(),
		}),
		organizations: z.tuple([privateOrganizationSchema, privateOrganizationSchema]),
		evidenceDirectory: z.string().min(1),
		logFile: z.string().min(1),
		analyticsSqlFile: z.string().min(1),
	})
	.superRefine((value, context) => {
		if (
			value.organizations[0].organizationId === value.organizations[1].organizationId ||
			value.organizations[0].credential === value.organizations[1].credential ||
			value.organizations[0].approvalKeyHex === value.organizations[1].approvalKeyHex ||
			value.organizations[0].label === value.organizations[1].label ||
			value.agentId === value.otherAgentId ||
			new Set([value.portalA.name, value.portalB.name, value.helper.name]).size !== 3
		)
			context.addIssue({
				code: 'custom',
				message: 'Test identities, Workers and credentials must be distinct.',
			});
	});
export type PrivateDeployFile = z.infer<typeof privateDeployFileSchema>;
export type PrivateOrganization = z.infer<typeof privateOrganizationSchema>;

export const renderSelectionSchema = z.strictObject({
	worker: z.enum(['all', 'a', 'b', 'helper']).default('all'),
	workersDev: z.boolean().default(false),
});
export type RenderSelection = z.infer<typeof renderSelectionSchema>;
