import { z } from 'zod';

import { withPortableSuperRefinement } from '../../portable-contracts/portable-refinement-authoring.js';

const reservedRequestIds = new Set(['__proto__', 'constructor', 'prototype']);

export const RequestIdSchema = withPortableSuperRefinement({
	refinement: (id, context) => {
		if (reservedRequestIds.has(id)) {
			context.addIssue({
				code: 'custom',
				message: 'Portal request id uses a reserved object property name.',
			});
		}
	},
	refinementIdentity: 'portal.request-id.not-reserved',
	schema: z.string().min(1),
});

export const ItemIdSchema = RequestIdSchema;
