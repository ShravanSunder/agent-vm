import fs from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
	currentE2eArchitecture,
	removeE2eTempRoot,
	scaffoldOpenClawE2eProject,
} from './e2e-harness.js';

const temporaryRoots: string[] = [];

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readObjectField(
	record: Record<string, unknown>,
	fieldName: string,
): Record<string, unknown> {
	const value = record[fieldName];
	if (!isObjectRecord(value)) {
		throw new Error(`Expected ${fieldName} to be an object.`);
	}
	return value;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map(async (temporaryRoot) => {
			await removeE2eTempRoot(temporaryRoot);
		}),
	);
});

describe('e2e: OpenClaw default runtime scaffold', () => {
	it('pins scaffolded OpenAI defaults to the PI runtime', async () => {
		const project = await scaffoldOpenClawE2eProject({
			agents: ['sun'],
			architecture: currentE2eArchitecture(),
			prefix: 'openclaw-control-link-e2e-',
			zoneId: 'openclaw-default-runtime',
		});
		temporaryRoots.push(project.tempRoot);

		const config = JSON.parse(await fs.readFile(project.zone.gateway.config, 'utf8')) as unknown;
		if (!isObjectRecord(config)) {
			throw new Error('Generated OpenClaw config must be an object.');
		}
		const agents = readObjectField(config, 'agents');
		const defaults = readObjectField(agents, 'defaults');
		const defaultModel = readObjectField(defaults, 'model');
		const models = readObjectField(defaults, 'models');
		const defaultRuntimeModel = readObjectField(models, 'openai/gpt-5.5');
		const agentRuntime = readObjectField(defaultRuntimeModel, 'agentRuntime');

		expect(defaultModel.primary).toBe('openai/gpt-5.5');
		expect(agentRuntime.id).toBe('pi');
		expect(defaults).not.toHaveProperty('thinkingDefault');
	});
});
