import { z } from 'zod';

export const helperOrganizationsSchema = z.record(
	z.string().regex(/^[a-z0-9-]+$/u),
	z.strictObject({
		organizationId: z.uuid(),
		credential: z.string().min(16),
	}),
);
export const publicJwksSchema = z.strictObject({
	keys: z
		.array(
			z.strictObject({
				kty: z.literal('EC'),
				crv: z.literal('P-256'),
				['x']: z.string().min(1),
				['y']: z.string().min(1),
				kid: z.string().min(1),
				alg: z.literal('ES256'),
				use: z.literal('sig'),
			}),
		)
		.min(1),
});
export const admissionInputSchema = z.strictObject({
	organizationId: z.uuid(),
	agentId: z.string().min(1),
	state: z.enum(['listed', 'removed']),
});
export const controlledCallSchema = z.object({
	runId: z.string().min(1).max(100),
	callId: z.string().min(1).max(100),
	hold: z.boolean().default(false),
	responseBytes: z
		.number()
		.int()
		.min(0)
		.max(4 * 1024 * 1024 + 1)
		.default(0),
	value: z.string().default('ok'),
});
export const rpcInputSchema = z.object({
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string(),
	params: z
		.object({
			name: z.string().optional(),
			arguments: z.record(z.string(), z.unknown()).default({}),
		})
		.optional(),
});
export const callObservationSchema = z.strictObject({
	organizationLabel: z.string(),
	callId: z.string(),
	credential: z.string(),
	toolName: z.string(),
	effects: z.number().int().nonnegative(),
	inFlight: z.number().int().nonnegative(),
});
export const runObservationsSchema = z.strictObject({
	runId: z.string(),
	calls: z.array(callObservationSchema),
	activeCalls: z.number().int().nonnegative(),
	peakCalls: z.number().int().nonnegative(),
});
export type CallObservation = z.infer<typeof callObservationSchema>;
export type RunObservations = z.infer<typeof runObservationsSchema>;
export type ControlledCall = z.infer<typeof controlledCallSchema>;
export interface ObservationPort {
	readonly begin: (call: Omit<CallObservation, 'effects' | 'inFlight'>) => Promise<void>;
	readonly finish: (callId: string) => Promise<void>;
	readonly snapshot: () => Promise<RunObservations>;
	readonly reset: () => Promise<void>;
	readonly hold: (callId: string) => Promise<void>;
	readonly release: () => Promise<void>;
}
export interface HelperRoutePorts {
	readonly publicJwks: unknown;
	readonly organizations: z.infer<typeof helperOrganizationsSchema>;
	readonly admissionSecret: string;
	readonly setAdmission: (input: z.infer<typeof admissionInputSchema>) => Promise<void>;
	readonly observations: (runId: string) => ObservationPort;
}
