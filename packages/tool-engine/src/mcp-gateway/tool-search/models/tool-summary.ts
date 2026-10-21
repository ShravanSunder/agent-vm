export interface ToolSchemaSummary {
	readonly optional: readonly string[];
	readonly propertyCount: number;
	readonly required: readonly string[];
	readonly type: string;
}

export interface ToolSafetySummary {
	readonly destructiveHint?: boolean;
	readonly readOnlyHint?: boolean;
}

export type ToolSchemaHintNext = 'call_ready' | 'describe_before_call';

export interface ToolSchemaHint {
	readonly message: string;
	readonly next: ToolSchemaHintNext;
}

export interface ToolSummary {
	readonly description?: string;
	readonly input: ToolSchemaSummary;
	readonly namespace: string;
	readonly output?: ToolSchemaSummary;
	readonly safety: ToolSafetySummary;
	readonly schemaHint?: ToolSchemaHint;
	readonly title?: string;
	readonly toolName: string;
	readonly toolRef: string;
}
