import { z } from 'zod';

interface ProofBarrier {
	readonly entered: PromiseWithResolvers<unknown>;
	readonly released: PromiseWithResolvers<void>;
	observed: boolean;
}

/** Node owns these promises; no promise or continuation crosses Worker request contexts. */
export function createAuthProofBarrierServer(): {
	readonly handle: (pathname: string, method: string, body: string) => Promise<Response | null>;
	readonly close: () => void;
} {
	const barriers = new Map<string, ProofBarrier>();
	return {
		async handle(pathname, method, body): Promise<Response | null> {
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
