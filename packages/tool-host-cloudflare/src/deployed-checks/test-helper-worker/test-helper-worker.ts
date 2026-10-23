import { DurableObject } from 'cloudflare:workers';

import { handleHelperRequest } from '#worker-host/deployed-checks/test-helper-worker/helper-routes';
import {
	helperOrganizationsSchema,
	publicJwksSchema,
	runObservationsSchema,
	type CallObservation,
	type RunObservations,
} from '#worker-host/deployed-checks/test-helper-worker/models/helper-contracts';
import {
	beginObservation,
	emptyObservations,
	finishObservation,
} from '#worker-host/deployed-checks/test-helper-worker/observation-counters';
import type { OrganizationAuthorization } from '#worker-host/durable-organization-authority/organization-authorization';

interface HelperBindings {
	readonly ORGANIZATIONS: DurableObjectNamespace<OrganizationAuthorization>;
	readonly OBSERVATIONS: DurableObjectNamespace<TestObservations>;
	readonly TEST_ORGANIZATIONS: string;
	readonly TEST_PUBLIC_JWKS: string;
	readonly ADMISSION_SECRET: string;
}
export class TestObservations extends DurableObject {
	private readonly holds = new Map<string, () => void>();
	private released = false;
	async snapshot(): Promise<RunObservations> {
		return runObservationsSchema.parse(
			(await this.ctx.storage.get('observations')) ?? emptyObservations('uninitialized'),
		);
	}
	async initialize(runId: string): Promise<void> {
		await this.ctx.storage.transaction(async (storage): Promise<void> => {
			if ((await storage.get('observations')) === undefined)
				await storage.put('observations', emptyObservations(runId));
		});
	}
	async begin(call: Omit<CallObservation, 'effects' | 'inFlight'>): Promise<void> {
		await this.ctx.storage.transaction(async (storage): Promise<void> => {
			const snapshot = runObservationsSchema.parse(await storage.get('observations'));
			await storage.put('observations', beginObservation(snapshot, call));
		});
	}
	async finish(callId: string): Promise<void> {
		await this.ctx.storage.transaction(async (storage): Promise<void> => {
			await storage.put(
				'observations',
				finishObservation(runObservationsSchema.parse(await storage.get('observations')), callId),
			);
		});
	}
	async reset(): Promise<void> {
		const snapshot = await this.snapshot();
		if (snapshot.activeCalls !== 0) throw new Error('Cannot reset active observations.');
		this.released = false;
		await this.ctx.storage.put('observations', emptyObservations(snapshot.runId));
	}
	async hold(callId: string): Promise<void> {
		if (!this.released) await new Promise<void>((resolve) => this.holds.set(callId, resolve));
	}
	async release(): Promise<void> {
		this.released = true;
		for (const resolve of this.holds.values()) resolve();
		this.holds.clear();
	}
}
export default {
	async fetch(request: Request, bindings: HelperBindings): Promise<Response> {
		try {
			const namespaces = new Map<string, ReturnType<HelperBindings['OBSERVATIONS']['get']>>();
			return await handleHelperRequest(request, {
				publicJwks: publicJwksSchema.parse(JSON.parse(bindings.TEST_PUBLIC_JWKS)),
				organizations: helperOrganizationsSchema.parse(JSON.parse(bindings.TEST_ORGANIZATIONS)),
				admissionSecret: bindings.ADMISSION_SECRET,
				setAdmission: async (input): Promise<void> =>
					bindings.ORGANIZATIONS.get(
						bindings.ORGANIZATIONS.idFromName(input.organizationId),
					).setAgentAdmission(input.agentId, input.state),
				observations: (runId) => {
					const stub =
						namespaces.get(runId) ??
						bindings.OBSERVATIONS.get(bindings.OBSERVATIONS.idFromName(runId));
					namespaces.set(runId, stub);
					return {
						begin: async (call): Promise<void> => {
							await stub.initialize(runId);
							await stub.begin(call);
						},
						finish: async (callId): Promise<void> => stub.finish(callId),
						snapshot: async (): Promise<RunObservations> => {
							await stub.initialize(runId);
							return stub.snapshot();
						},
						reset: async (): Promise<void> => {
							await stub.initialize(runId);
							await stub.reset();
						},
						hold: async (callId): Promise<void> => stub.hold(callId),
						release: async (): Promise<void> => stub.release(),
					};
				},
			});
		} catch {
			return Response.json({ error: 'invalid-helper-request' }, { status: 400 });
		}
	},
};
