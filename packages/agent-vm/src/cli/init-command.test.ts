import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { scaffoldAgentVmProject } from './init-command.js';

const createdDirectories: string[] = [];

afterEach(() => {
	for (const directoryPath of createdDirectories.splice(0)) {
		fs.rmSync(directoryPath, { force: true, recursive: true });
	}
});

function createTestDirectory(): string {
	const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vm-init-test-'));
	createdDirectories.push(testDirectory);
	return testDirectory;
}

describe('scaffoldAgentVmProject', () => {
	it('creates system.json with the requested zone', () => {
		const targetDir = createTestDirectory();

		const result = scaffoldAgentVmProject({ targetDir, zoneId: 'test-zone' });
		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8')) as {
			readonly zones: readonly [{ readonly id: string }];
		};

		expect(result.created).toContain('system.json');
		expect(config.zones[0]?.id).toBe('test-zone');
	});

	it('creates .env.local from the default template', () => {
		const targetDir = createTestDirectory();

		const result = scaffoldAgentVmProject({ targetDir, zoneId: 'test-zone' });
		const envContent = fs.readFileSync(path.join(targetDir, '.env.local'), 'utf8');

		expect(result.created).toContain('.env.local');
		expect(envContent).toContain('OP_SERVICE_ACCOUNT_TOKEN=');
		expect(envContent).toContain('DISCORD_BOT_TOKEN_REF=');
	});

	it('creates config and state directories', () => {
		const targetDir = createTestDirectory();

		scaffoldAgentVmProject({ targetDir, zoneId: 'my-zone' });

		expect(fs.existsSync(path.join(targetDir, 'config', 'my-zone'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'state', 'my-zone'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'workspaces', 'my-zone'))).toBe(true);
		expect(fs.existsSync(path.join(targetDir, 'workspaces', 'tools'))).toBe(true);
	});

	it('does not overwrite an existing system.json', () => {
		const targetDir = createTestDirectory();
		fs.writeFileSync(path.join(targetDir, 'system.json'), '{"existing":true}\n', 'utf8');

		const result = scaffoldAgentVmProject({ targetDir, zoneId: 'test-zone' });
		const config = JSON.parse(fs.readFileSync(path.join(targetDir, 'system.json'), 'utf8')) as {
			readonly existing: boolean;
		};

		expect(result.skipped).toContain('system.json');
		expect(config.existing).toBe(true);
	});
});
