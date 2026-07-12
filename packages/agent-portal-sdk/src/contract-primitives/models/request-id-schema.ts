import { z } from 'zod';

const reservedRequestIds = new Set(['__proto__', 'constructor', 'prototype']);

export const RequestIdSchema = z
	.string()
	.min(1)
	.refine((id) => !reservedRequestIds.has(id), {
		message: 'Portal request id uses a reserved object property name.',
	});

export const ItemIdSchema = RequestIdSchema;
