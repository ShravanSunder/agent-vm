import { operationKeySchema } from '@agent-collaboration/tool-engine/dispatch';

export function extractDirectOperationItem(
	metadata: Readonly<Record<string, unknown>> | undefined,
): string | null {
	const parsed = operationKeySchema.shape.item.safeParse(metadata?.['tool-portal/operation-item']);
	return parsed.success ? parsed.data : null;
}
