import { z } from 'zod';

const reservedZoneIds = new Set(['cache', 'controller-state', 'controller-runtime']);

export const agentIdSchema = z
	.string()
	.min(1)
	.max(1024)
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/u,
		'agent id must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens',
	);

export const zoneIdSchema = z
	.string()
	.min(1)
	.max(1024)
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/u,
		'zone id must start with a lowercase letter or number and contain only lowercase letters, numbers, dots, underscores, or hyphens',
	)
	.refine((zoneId) => !reservedZoneIds.has(zoneId), 'zone id is reserved for global storage');

export const projectNamespaceSchema = z
	.string()
	.min(1)
	.max(1024)
	.regex(
		/^[a-z0-9][a-z0-9-]*$/u,
		'projectNamespace must use lowercase letters, numbers, and hyphens only',
	);
