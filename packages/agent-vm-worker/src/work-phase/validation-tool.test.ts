import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { buildValidationTool } from './validation-tool.js';

describe('buildValidationTool', () => {
	const tmpDirs: string[] = [];

	afterEach(async () => {
		const dirs = tmpDirs.splice(0);
		await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
	});

	test('conforms to ToolDefinition shape', () => {
		const tool = buildValidationTool({
			commands: [],
			cwd: '/tmp',
			timeoutMs: 5_000,
			rawLogDir: '/tmp',
			attemptLabelPrefix: 'verify',
		});

		expect(tool.name).toBe('run_validation');
		expect(typeof tool.description).toBe('string');
		expect(tool.inputSchema).toEqual({
			type: 'object',
			properties: {},
			additionalProperties: false,
		});
		expect(typeof tool.execute).toBe('function');
	});

	test('execute runs commands and returns results', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'validation-tool-workspace-'));
		const logs = await mkdtemp(join(tmpdir(), 'validation-tool-logs-'));
		tmpDirs.push(workspace, logs);
		const tool = buildValidationTool({
			commands: [
				{ name: 'echo-ok', command: 'echo hi' },
				{ name: 'fail', command: 'node -e "process.exit(7)"' },
			],
			cwd: workspace,
			timeoutMs: 10_000,
			rawLogDir: logs,
			attemptLabelPrefix: 'verify',
		});

		const results = await tool.execute({});

		expect(results).toMatchObject([
			{ name: 'echo-ok', passed: true, exitCode: 0 },
			{ name: 'fail', passed: false, exitCode: 7 },
		]);
	});

	test('multiple execute calls use incrementing attempt labels', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'validation-tool-workspace-'));
		const logs = await mkdtemp(join(tmpdir(), 'validation-tool-logs-'));
		tmpDirs.push(workspace, logs);
		const tool = buildValidationTool({
			commands: [{ name: 'echo-ok', command: 'echo hi' }],
			cwd: workspace,
			timeoutMs: 5_000,
			rawLogDir: logs,
			attemptLabelPrefix: 'verify',
		});

		await tool.execute({});
		await tool.execute({});

		expect((await readdir(logs)).toSorted()).toEqual([
			'verify-call-1-echo-ok.log',
			'verify-call-2-echo-ok.log',
		]);
	});

	test('empty command list returns an empty array', async () => {
		const workspace = await mkdtemp(join(tmpdir(), 'validation-tool-workspace-'));
		tmpDirs.push(workspace);
		const tool = buildValidationTool({
			commands: [],
			cwd: workspace,
			timeoutMs: 5_000,
			rawLogDir: workspace,
			attemptLabelPrefix: 'verify',
		});

		await expect(tool.execute({})).resolves.toEqual([]);
	});
});
