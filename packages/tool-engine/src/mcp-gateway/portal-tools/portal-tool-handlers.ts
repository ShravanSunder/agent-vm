import type { AgentCatalogView } from '#mcp-gateway/agent-catalog-views/models/agent-catalog-view';
import type { PortalCallAuthorization } from '#mcp-gateway/call-approvals/models/call-approval';
import {
	type PortalToolRuntime,
	type PortalToolHandlers,
	type PortalToolHandlerCall,
	type PortalBatchResult,
	callExecutionInputSchema,
	type PortalToolResult,
	describeInputSchema,
	listInputSchema,
	searchInputSchema,
} from '#mcp-gateway/portal-tools/models/portal-tool-contracts';
import {
	invalidPortalInput,
	duplicateIdResult,
	portalBatchResult,
	itemError,
	discoveryDiagnostics,
} from '#mcp-gateway/portal-tools/portal-batch-results';
import {
	preparePortalCall,
	isPreparedPortalCall,
	addExecutableCallResults,
} from '#mcp-gateway/portal-tools/portal-call-execution';
import {
	describeRequestResult,
	listRequestResult,
	searchRequestResult,
} from '#mcp-gateway/portal-tools/portal-catalog-requests';

export function createPortalToolHandlers(runtime: PortalToolRuntime): PortalToolHandlers {
	return {
		async call(call: PortalToolHandlerCall): Promise<PortalBatchResult> {
			const parsedInput = callExecutionInputSchema.safeParse(call.input);
			if (!parsedInput.success) {
				return invalidPortalInput(parsedInput.error);
			}
			const duplicateResult = duplicateIdResult(parsedInput.data.calls);
			if (duplicateResult) {
				return duplicateResult;
			}

			let session: AgentCatalogView;
			try {
				session = await runtime.getView(call.identity);
			} catch {
				return portalBatchResult(
					Object.fromEntries(
						parsedInput.data.calls.map((request) => [
							request.id,
							itemError({
								input: request,
								error: { kind: 'not-dispatched', reason: 'catalog-unavailable' },
							}),
						]),
					),
				);
			}
			const preparedResults = parsedInput.data.calls.map((request) =>
				(() => {
					try {
						return preparePortalCall(session, request);
					} catch {
						return itemError({
							input: request,
							error: { kind: 'not-dispatched', reason: 'preparation-failed' },
						});
					}
				})(),
			);
			const executableCalls = preparedResults.filter(isPreparedPortalCall);
			const results: Record<string, PortalToolResult> = {};
			for (const preparedResult of preparedResults) {
				if (!isPreparedPortalCall(preparedResult)) {
					const id = preparedResult.input.id;
					if (typeof id === 'string') results[id] = preparedResult;
				}
			}
			let authorizations: ReadonlyMap<string, PortalCallAuthorization>;
			try {
				authorizations =
					(await runtime.authorizeCalls?.(executableCalls, parsedInput.data.portalApprovalToken)) ??
					new Map();
			} catch {
				authorizations = new Map(
					executableCalls.map((entry) => [
						entry.input.id,
						{ kind: 'refused', reason: 'approval-unavailable' },
					]),
				);
			}
			await addExecutableCallResults({
				authorizations,
				identity: call.identity,
				preparedCalls: executableCalls,
				results,
				runtime,
			});

			return portalBatchResult(results, discoveryDiagnostics(session));
		},
		async describe(call: PortalToolHandlerCall): Promise<PortalBatchResult> {
			const parsedInput = describeInputSchema.safeParse(call.input);
			if (!parsedInput.success) {
				return invalidPortalInput(parsedInput.error);
			}
			const duplicateResult = duplicateIdResult(parsedInput.data.requests);
			if (duplicateResult) {
				return duplicateResult;
			}

			const session = await runtime.getView(call.identity);
			return portalBatchResult(
				Object.fromEntries(
					await Promise.all(
						parsedInput.data.requests.map(async (request) => [
							request.id,
							await describeRequestResult(session, request),
						]),
					),
				),
				discoveryDiagnostics(session),
			);
		},
		async list(call: PortalToolHandlerCall): Promise<PortalBatchResult> {
			const parsedInput = listInputSchema.safeParse(call.input);
			if (!parsedInput.success) {
				return invalidPortalInput(parsedInput.error);
			}
			const duplicateResult = duplicateIdResult(parsedInput.data.requests);
			if (duplicateResult) {
				return duplicateResult;
			}

			const session = await runtime.getView(call.identity);
			return portalBatchResult(
				Object.fromEntries(
					parsedInput.data.requests.map((request) => [
						request.id,
						listRequestResult(session, request),
					]),
				),
				discoveryDiagnostics(session),
			);
		},
		async search(call: PortalToolHandlerCall): Promise<PortalBatchResult> {
			const parsedInput = searchInputSchema.safeParse(call.input);
			if (!parsedInput.success) {
				return invalidPortalInput(parsedInput.error);
			}
			const duplicateResult = duplicateIdResult(parsedInput.data.requests);
			if (duplicateResult) {
				return duplicateResult;
			}

			const session = await runtime.getView(call.identity);
			return portalBatchResult(
				Object.fromEntries(
					parsedInput.data.requests.map((request) => [
						request.id,
						searchRequestResult(session, request),
					]),
				),
				discoveryDiagnostics(session),
			);
		},
	};
}
