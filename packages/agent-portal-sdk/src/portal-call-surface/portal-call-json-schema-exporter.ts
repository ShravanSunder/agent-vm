import { z } from 'zod';

import { PortalCallRequestSchema } from './models/portal-call-request-schema.js';
import { PortalDescribeRequestSchema } from './models/portal-describe-request-schema.js';
import { PortalListRequestSchema } from './models/portal-list-request-schema.js';
import { PortalSearchRequestSchema } from './models/portal-search-request-schema.js';

export interface PortalCallSurfaceJsonSchemas {
	readonly call: Record<string, unknown>;
	readonly describe: Record<string, unknown>;
	readonly list: Record<string, unknown>;
	readonly search: Record<string, unknown>;
}

export function createPortalCallSurfaceJsonSchemas(): PortalCallSurfaceJsonSchemas {
	return {
		call: z.toJSONSchema(PortalCallRequestSchema, { io: 'input' }),
		describe: z.toJSONSchema(PortalDescribeRequestSchema, { io: 'input' }),
		list: z.toJSONSchema(PortalListRequestSchema, { io: 'input' }),
		search: z.toJSONSchema(PortalSearchRequestSchema, { io: 'input' }),
	};
}
