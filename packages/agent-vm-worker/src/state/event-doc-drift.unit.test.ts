import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { taskEventSchema } from './task-event-types.js';

interface TaskEventSchemaOption {
	readonly shape?: {
		readonly event?: {
			readonly value?: unknown;
		};
	};
}

interface TaskEventSchemaWithOptions {
	readonly options?: readonly TaskEventSchemaOption[];
}

function isReadonlyStringArray(value: readonly unknown[]): value is readonly string[] {
	return value.every((entry) => typeof entry === 'string');
}

function readTaskEventNamesFromSchema(): readonly string[] {
	const schema = taskEventSchema as unknown as TaskEventSchemaWithOptions;
	const eventNames = schema.options?.map((option) => option.shape?.event?.value) ?? [];
	if (!isReadonlyStringArray(eventNames)) {
		throw new Error('Unable to read task event names from taskEventSchema.');
	}
	return eventNames;
}

function extractWorkerTaskEventTable(markdown: string): string {
	const headingMatch = /^### (?:All \d+ Event Types|Worker Task Event Types)$/mu.exec(markdown);
	if (!headingMatch) {
		throw new Error('Unable to find the worker task event table heading.');
	}
	const sectionStart = headingMatch.index;
	const remainingMarkdown = markdown.slice(sectionStart);
	const nextHeadingMatch = /\n### |\n## /u.exec(remainingMarkdown.slice(1));
	return nextHeadingMatch
		? remainingMarkdown.slice(0, nextHeadingMatch.index + 1)
		: remainingMarkdown;
}

function extractDocumentedTaskEventNames(markdown: string): readonly string[] {
	const tableMarkdown = extractWorkerTaskEventTable(markdown);
	return [...tableMarkdown.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1] ?? '');
}

describe('agent worker gateway event documentation', () => {
	it('lists every worker task event from the TaskEvent schema in order', async () => {
		const markdownUrl = new URL(
			'../../../../docs/architecture/agent-worker-gateway.md',
			import.meta.url,
		);
		const markdown = await readFile(markdownUrl, 'utf8');

		expect(extractDocumentedTaskEventNames(markdown)).toEqual(readTaskEventNamesFromSchema());
	});

	it('documents provider-neutral sessionRef fields instead of codex-shaped threadId fields', async () => {
		const markdownUrl = new URL(
			'../../../../docs/architecture/agent-worker-gateway.md',
			import.meta.url,
		);
		const markdown = await readFile(markdownUrl, 'utf8');

		expect(markdown).toContain('sessionRef');
		expect(markdown).not.toContain('threadId');
	});
});
