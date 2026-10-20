import { z } from 'zod';

export const catalogTools = [
	{
		id: 'web-search',
		name: 'Search the web',
		group: 'Useful cloud services',
		source: 'Search MCP',
		detail: 'Public web results',
		approval: 'Not required',
		accountRequired: false,
	},
	{
		id: 'web-scrape',
		name: 'Read a web page',
		group: 'Useful cloud services',
		source: 'Firecrawl MCP',
		detail: 'Extract a public page',
		approval: 'Not required',
		accountRequired: false,
	},
	{
		id: 'calendar-read',
		name: 'Read team calendar',
		group: 'Cloud integrations',
		source: 'Team Google account',
		detail: 'Events and availability',
		approval: 'Not required',
		accountRequired: true,
	},
	{
		id: 'calendar-write',
		name: 'Change team calendar',
		group: 'Cloud integrations',
		source: 'Team Google account',
		detail: 'Create or update events',
		approval: 'Approval required',
		accountRequired: true,
	},
	{
		id: 'files-read',
		name: 'Read team documents',
		group: 'Cloud integrations',
		source: 'Team Google account',
		detail: 'Read selected files',
		approval: 'Not required',
		accountRequired: true,
	},
	{
		id: 'mac-capture',
		name: 'Capture a screen',
		group: 'Computer tools',
		source: 'Sunbook computer MCP',
		detail: 'Read the current display',
		approval: 'Approval required',
		accountRequired: false,
	},
	{
		id: 'mac-input',
		name: 'Control the computer',
		group: 'Computer tools',
		source: 'Sunbook computer MCP',
		detail: 'Keyboard and pointer actions',
		approval: 'Approval required',
		accountRequired: false,
	},
] as const;

export const toolGroups = [
	'Useful cloud services',
	'Cloud integrations',
	'Computer tools',
] as const;
export const harnessNames = [
	'Codex',
	'Claude Code',
	'Hermes',
	'Cursor',
	'Pi',
	'Other MCP client',
] as const;
const nameSchema = z.string().trim().min(1, 'Enter a name.').max(60, 'Use 60 characters or fewer.');
const toolIdsSchema = z
	.array(z.string())
	.refine(
		(ids): boolean =>
			new Set(ids).size === ids.length &&
			ids.every((id): boolean => catalogTools.some((tool): boolean => tool.id === id)),
		'Choose tools from the catalog.',
	);
export const agentInputSchema = z.object({
	name: nameSchema,
	harness: z.enum(harnessNames),
	toolIds: toolIdsSchema,
});
export type AgentInput = z.infer<typeof agentInputSchema>;
export const accountInputSchema = z.object({ alias: nameSchema });
const revisionSchema = z.number().int().nonnegative();
export const reviewCommandSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('workspace-tools'),
		revision: revisionSchema,
		toolIds: toolIdsSchema,
	}),
	agentInputSchema.extend({ kind: z.literal('register-agent'), revision: revisionSchema }),
	accountInputSchema.extend({ kind: z.literal('confirm-account'), revision: revisionSchema }),
	z.object({ kind: z.literal('cancel-account'), revision: revisionSchema }),
]);
export type ReviewCommand = z.infer<typeof reviewCommandSchema>;
export const reviewStateSchema = z.object({
	revision: revisionSchema,
	workspaceToolIds: toolIdsSchema,
	agents: z.array(agentInputSchema.extend({ id: z.string() })),
	account: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('pending') }),
		z.object({ kind: z.literal('connected'), alias: nameSchema }),
		z.object({ kind: z.literal('cancelled') }),
	]),
	auditEvents: z.array(
		z.object({
			id: z.string(),
			action: z.string(),
			subject: z.string(),
			actor: z.string(),
			time: z.string(),
			before: z.string(),
			after: z.string(),
		}),
	),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;
export const responseSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('saved'), state: reviewStateSchema }),
	z.object({ kind: z.literal('rejected'), message: z.string() }),
]);
export const initialReviewState: ReviewState = {
	revision: 0,
	workspaceToolIds: ['web-search', 'web-scrape', 'calendar-read', 'files-read', 'mac-capture'],
	agents: [
		{
			id: 'agent-research',
			name: 'Research assistant',
			harness: 'Codex',
			toolIds: ['web-search', 'web-scrape'],
		},
	],
	account: { kind: 'pending' },
	auditEvents: [],
};
