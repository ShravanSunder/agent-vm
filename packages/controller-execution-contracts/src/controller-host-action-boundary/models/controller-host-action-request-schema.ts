import { JsonObjectSchema } from '@agent-vm/agent-portal-sdk';
import { z } from 'zod';

import { ControllerDispatchIntentSchema } from '../../controller-dispatch-boundary/models/controller-dispatch-intent-schema.js';

export const ControllerHostActionRequestSchema = z
	.object({
		canonicalArguments: JsonObjectSchema,
		dispatch: ControllerDispatchIntentSchema,
		hostActionName: z.string().min(1),
	})
	.strict();

export type ControllerHostActionRequest = z.infer<typeof ControllerHostActionRequestSchema>;
