import { JsonObjectSchema } from '@agent-vm/agent-portal-sdk';
import { z } from 'zod';

import { ControllerDispatchIntentSchema } from '../../controller-dispatch-boundary/models/controller-dispatch-intent-schema.js';

export const ControllerExecutionRequestSchema = z
	.object({
		canonicalArguments: JsonObjectSchema,
		dispatch: ControllerDispatchIntentSchema,
		operationName: z.string().min(1),
	})
	.strict();

export type ControllerExecutionRequest = z.infer<typeof ControllerExecutionRequestSchema>;
