import type { GatewayRuntimeApprovalAuthorityContext } from '@agent-vm/gateway-control-contracts';
import type { Hono } from 'hono';
import { z } from 'zod/v4';

import type {
	ControllerApprovalLedger,
	ControllerApprovalOperatorIdentity,
} from '../approval/controller-approval-ledger.js';

export interface ApprovalBearerAuthenticationRequest {
	readonly authorizationHeader: string | undefined;
	readonly zoneId: string;
}

export type ApprovalBearerAuthenticationResult =
	| {
			readonly kind: 'authenticated';
			readonly operator: ControllerApprovalOperatorIdentity;
	  }
	| {
			readonly kind: 'unauthorized';
			readonly reason: 'malformed' | 'missing' | 'stale' | 'unknown';
	  }
	| {
			readonly kind: 'forbidden';
			readonly reason: 'recognized-non-approval-credential' | 'wrong-audience';
	  };

export interface ControllerApprovalRoutePorts {
	readonly authenticateBearer: (
		request: ApprovalBearerAuthenticationRequest,
	) => Promise<ApprovalBearerAuthenticationResult>;
	readonly readCurrentAuthorityContext: (
		zoneId: string,
	) => Promise<GatewayRuntimeApprovalAuthorityContext | null>;
	readonly resolveLedger: (zoneId: string) => ControllerApprovalLedger | null;
}

const EmptyApprovalMutationBodySchema = z.object({}).strict();

async function readStrictEmptyMutationBody(request: Request): Promise<'invalid' | 'valid'> {
	try {
		return EmptyApprovalMutationBodySchema.safeParse(await request.json()).success
			? 'valid'
			: 'invalid';
	} catch {
		return 'invalid';
	}
}

export function registerControllerApprovalRoutes(
	app: Hono,
	ports: ControllerApprovalRoutePorts,
): void {
	async function authenticate(props: {
		readonly authorizationHeader: string | undefined;
		readonly zoneId: string;
	}): Promise<ApprovalBearerAuthenticationResult> {
		return await ports.authenticateBearer(props);
	}

	app.get('/zones/:zoneId/approvals', async (context) => {
		const zoneId = context.req.param('zoneId');
		const authentication = await authenticate({
			authorizationHeader: context.req.header('authorization'),
			zoneId,
		});
		if (authentication.kind === 'unauthorized') {
			return context.json({ error: authentication.reason }, 401);
		}
		if (authentication.kind === 'forbidden') {
			return context.json({ error: authentication.reason }, 403);
		}
		const ledger = ports.resolveLedger(zoneId);
		if (ledger === null) {
			return context.json({ error: 'not-found' }, 404);
		}
		return context.json({ approvals: await ledger.list() }, 200);
	});

	app.get('/zones/:zoneId/approvals/:approvalId', async (context) => {
		const zoneId = context.req.param('zoneId');
		const authentication = await authenticate({
			authorizationHeader: context.req.header('authorization'),
			zoneId,
		});
		if (authentication.kind === 'unauthorized') {
			return context.json({ error: authentication.reason }, 401);
		}
		if (authentication.kind === 'forbidden') {
			return context.json({ error: authentication.reason }, 403);
		}
		const ledger = ports.resolveLedger(zoneId);
		if (ledger === null) {
			return context.json({ error: 'not-found' }, 404);
		}
		const approval = await ledger.read(context.req.param('approvalId'));
		return approval === null
			? context.json({ error: 'not-found' }, 404)
			: context.json({ approval }, 200);
	});

	for (const action of ['approve', 'deny', 'revoke'] as const) {
		app.post(`/zones/:zoneId/approvals/:approvalId/${action}`, async (context) => {
			const zoneId = context.req.param('zoneId');
			const authentication = await authenticate({
				authorizationHeader: context.req.header('authorization'),
				zoneId,
			});
			if (authentication.kind === 'unauthorized') {
				return context.json({ error: authentication.reason }, 401);
			}
			if (authentication.kind === 'forbidden') {
				return context.json({ error: authentication.reason }, 403);
			}
			if ((await readStrictEmptyMutationBody(context.req.raw)) === 'invalid') {
				return context.json({ error: 'invalid-request' }, 400);
			}
			const ledger = ports.resolveLedger(zoneId);
			if (ledger === null) {
				return context.json({ error: 'not-found' }, 404);
			}
			const approvalId = context.req.param('approvalId');
			if ((await ledger.read(approvalId)) === null) {
				return context.json({ error: 'not-found' }, 404);
			}
			const authorityContext = await ports.readCurrentAuthorityContext(zoneId);
			if (authorityContext === null) {
				return context.json({ error: 'stale-authority' }, 409);
			}
			const result =
				action === 'revoke'
					? await ledger.revoke({
							approvalId,
							authorityContext,
							operator: authentication.operator,
						})
					: await ledger.decide({
							approvalId,
							authorityContext,
							decision: action === 'approve' ? 'approve' : 'deny',
							operator: authentication.operator,
						});
			return result.kind === 'recorded'
				? context.json({ approval: result.view }, 200)
				: context.json({ error: result.reason }, 409);
		});
	}
}
