import { z } from 'zod';

interface ManagementObservation {
	readonly point: 'before-provider-owner-read';
	readonly requestId: string;
}

export interface ManagementProofControls {
	readonly armManagementHold: (requestId: string) => Promise<{ readonly armed: boolean }>;
	readonly enteredManagementHold: (requestId: string) => Promise<ManagementObservation>;
	readonly managementHoldStatus: (
		requestId: string,
	) => Promise<{ readonly armed: boolean; readonly observed: boolean }>;
	readonly releaseManagementHold: (requestId: string) => Promise<{ readonly released: boolean }>;
}

interface ProofBarrier {
	readonly entered: PromiseWithResolvers<unknown>;
	readonly released: PromiseWithResolvers<void>;
	observed: boolean;
}

/** Node owns these promises; no promise or continuation crosses Worker request contexts. */
export function createAuthProofBarrierServer(): {
	readonly handle: (pathname: string, method: string, body: string) => Promise<Response | null>;
	readonly close: () => void;
	readonly managementHolds: ManagementProofControls;
} {
	const barriers = new Map<string, ProofBarrier>();
	async function handleBarrier(
		pathname: string,
		method: string,
		body: string,
	): Promise<Response | null> {
		const url = new URL(pathname, 'http://proof.invalid');
		const match =
			/^\/__auth-proof\/(hold|management-hold)\/(arm|status|entered|arrive|release)$/u.exec(
				url.pathname,
			);
		if (match === null) return null;
		const key = `${match[1]}:${z
			.string()
			.min(1)
			.parse(url.searchParams.get('key') ?? url.searchParams.get('client'))}`;
		const operation = match[2];
		if (operation === 'arm' && method === 'POST') {
			if (barriers.has(key)) return Response.json({ error: 'already-armed' }, { status: 409 });
			barriers.set(key, {
				entered: Promise.withResolvers<unknown>(),
				released: Promise.withResolvers<void>(),
				observed: false,
			});
			return Response.json({ armed: true });
		}
		const barrier = barriers.get(key);
		if (operation === 'status')
			return Response.json({
				armed: barrier !== undefined,
				observed: barrier?.observed ?? false,
			});
		if (barrier === undefined)
			return operation === 'arrive'
				? new Response(null, { status: 204 })
				: Response.json({ error: 'not-armed' }, { status: 404 });
		if (operation === 'entered') return Response.json(await barrier.entered.promise);
		if (operation === 'arrive' && method === 'POST') {
			const event: unknown = JSON.parse(body);
			barrier.observed = true;
			barrier.entered.resolve(event);
			await barrier.released.promise;
			return new Response(null, { status: 204 });
		}
		if (operation === 'release' && method === 'POST') {
			barrier.released.resolve();
			barriers.delete(key);
			return Response.json({ released: true });
		}
		return Response.json({ error: 'invalid-control' }, { status: 400 });
	}
	async function managementControl(
		requestId: string,
		operation: 'arm' | 'status' | 'entered' | 'release',
	): Promise<Response> {
		const response = await handleBarrier(
			`/__auth-proof/management-hold/${operation}?key=${encodeURIComponent(requestId)}`,
			['status', 'entered'].includes(operation) ? 'GET' : 'POST',
			'',
		);
		if (response === null || !response.ok)
			throw new Error(`Node management barrier ${operation} refused`);
		return response;
	}
	return {
		handle: handleBarrier,
		managementHolds: {
			async armManagementHold(requestId: string): Promise<{ readonly armed: boolean }> {
				return z
					.object({ armed: z.boolean() })
					.parse(await (await managementControl(requestId, 'arm')).json());
			},
			async enteredManagementHold(requestId: string): Promise<ManagementObservation> {
				return z
					.object({ point: z.literal('before-provider-owner-read'), requestId: z.string() })
					.parse(await (await managementControl(requestId, 'entered')).json());
			},
			async managementHoldStatus(
				requestId: string,
			): Promise<{ readonly armed: boolean; readonly observed: boolean }> {
				return z
					.object({ armed: z.boolean(), observed: z.boolean() })
					.parse(await (await managementControl(requestId, 'status')).json());
			},
			async releaseManagementHold(requestId: string): Promise<{ readonly released: boolean }> {
				return z
					.object({ released: z.boolean() })
					.parse(await (await managementControl(requestId, 'release')).json());
			},
		},
		close(): void {
			for (const barrier of barriers.values()) {
				barrier.entered.resolve({ error: 'barrier-closed' });
				barrier.released.resolve();
			}
			barriers.clear();
		},
	};
}
