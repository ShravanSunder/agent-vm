import { z } from 'zod';

import { ControllerDispatchIntentSchema } from '../../controller-dispatch-boundary/models/controller-dispatch-intent-schema.js';
import { ValidatedCliInvocationSchema } from './cli-invocation-policy-schema.js';

export const CredentialedRunnerRequestSchema = z
	.object({
		credentialProfileId: z.string().min(1),
		dispatch: ControllerDispatchIntentSchema,
		invocation: ValidatedCliInvocationSchema,
	})
	.strict();

export type CredentialedRunnerRequest = z.infer<typeof CredentialedRunnerRequestSchema>;
