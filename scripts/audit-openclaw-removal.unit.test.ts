import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { auditOpenClawRemoval } from './audit-openclaw-removal.js';

describe('OpenClaw removal audit', () => {
	it('finds forbidden active packages and production source residue', async () => {
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-openclaw-audit-'));
		try {
			await mkdir(path.join(repositoryRoot, 'packages', 'openclaw-gateway'), { recursive: true });
			await writeFile(
				path.join(repositoryRoot, 'packages', 'openclaw-gateway', 'package.json'),
				'{}\n',
				'utf8',
			);
			const sourcePath = path.join(repositoryRoot, 'packages', 'example', 'src', 'index.ts');
			await mkdir(path.dirname(sourcePath), { recursive: true });
			await writeFile(sourcePath, "export const framework = 'openclaw';\n", 'utf8');

			await expect(auditOpenClawRemoval(repositoryRoot)).resolves.toEqual([
				'packages/example/src/index.ts contains active OpenClaw residue',
				'packages/openclaw-gateway remains active',
			]);
		} finally {
			await rm(repositoryRoot, { force: true, recursive: true });
		}
	});

	it('finds removed Gateway protocol clients and OpenClaw LLM lane residue', async () => {
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-runtime-audit-'));
		try {
			const clientPath = path.join(
				repositoryRoot,
				'packages',
				'agent-vm',
				'src',
				'gateway-api-client',
				'gateway-websocket-client.ts',
			);
			await mkdir(path.dirname(clientPath), { recursive: true });
			await writeFile(clientPath, "export const method = 'chat.send';\n", 'utf8');

			const llmTestPath = path.join(
				repositoryRoot,
				'packages',
				'agent-vm',
				'src',
				'integration-tests',
				'live-agent-model-roundtrip.llm.e2e.test.ts',
			);
			await mkdir(path.dirname(llmTestPath), { recursive: true });
			await writeFile(llmTestPath, "const command = 'openclaw agent';\n", 'utf8');

			await expect(auditOpenClawRemoval(repositoryRoot)).resolves.toEqual([
				'packages/agent-vm/src/gateway-api-client remains active',
				'packages/agent-vm/src/integration-tests/live-agent-model-roundtrip.llm.e2e.test.ts contains active OpenClaw residue',
			]);
		} finally {
			await rm(repositoryRoot, { force: true, recursive: true });
		}
	});

	it('finds positive OpenClaw vocabulary in an unclassified active test', async () => {
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-test-audit-'));
		try {
			const testPath = path.join(
				repositoryRoot,
				'packages',
				'example',
				'src',
				'positive.unit.test.ts',
			);
			await mkdir(path.dirname(testPath), { recursive: true });
			await writeFile(testPath, "const profileName = 'openclaw';\n", 'utf8');

			await expect(auditOpenClawRemoval(repositoryRoot)).resolves.toEqual([
				'packages/example/src/positive.unit.test.ts contains active OpenClaw residue',
			]);
		} finally {
			await rm(repositoryRoot, { force: true, recursive: true });
		}
	});

	it('finds mechanically fabricated Hermes fixture vocabulary', async () => {
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-fixture-audit-'));
		try {
			const testPath = path.join(
				repositoryRoot,
				'packages',
				'example',
				'src',
				'fixture.unit.test.ts',
			);
			await mkdir(path.dirname(testPath), { recursive: true });
			await writeFile(testPath, "const secretName = 'HERMES_GATEWAY_TOKEN';\n", 'utf8');

			await expect(auditOpenClawRemoval(repositoryRoot)).resolves.toEqual([
				'packages/example/src/fixture.unit.test.ts contains misleading framework fixture residue',
			]);
		} finally {
			await rm(repositoryRoot, { force: true, recursive: true });
		}
	});

	it('finds misleading vocabulary in a compiled non-test helper', async () => {
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-helper-audit-'));
		try {
			const helperPath = path.join(
				repositoryRoot,
				'packages',
				'example',
				'src',
				'integration-tests',
				'e2e-harness.ts',
			);
			await mkdir(path.dirname(helperPath), { recursive: true });
			await writeFile(helperPath, "const namespace = 'claw-tests-worker';\n", 'utf8');

			await expect(auditOpenClawRemoval(repositoryRoot)).resolves.toEqual([
				'packages/example/src/integration-tests/e2e-harness.ts contains misleading framework fixture residue',
			]);
		} finally {
			await rm(repositoryRoot, { force: true, recursive: true });
		}
	});

	it('finds new OpenClaw residue added to a classified removal test', async () => {
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-classified-audit-'));
		try {
			const testPath = path.join(
				repositoryRoot,
				'packages',
				'agent-vm',
				'src',
				'cli',
				'agent-vm-command-parser.unit.test.ts',
			);
			await mkdir(path.dirname(testPath), { recursive: true });
			await writeFile(testPath, "const positiveProfile = 'openclaw';\n", 'utf8');

			await expect(auditOpenClawRemoval(repositoryRoot)).resolves.toEqual([
				'packages/agent-vm/src/cli/agent-vm-command-parser.unit.test.ts classified OpenClaw removal evidence count changed from 4 to 1',
			]);
		} finally {
			await rm(repositoryRoot, { force: true, recursive: true });
		}
	});

	it('finds removed SSH secret-mode residue in production source', async () => {
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-ssh-mode-audit-'));
		try {
			const sourcePath = path.join(repositoryRoot, 'packages', 'example', 'src', 'ssh.ts');
			await mkdir(path.dirname(sourcePath), { recursive: true });
			await writeFile(sourcePath, 'export const requestAllSecrets = false;\n', 'utf8');

			await expect(auditOpenClawRemoval(repositoryRoot)).resolves.toEqual([
				'packages/example/src/ssh.ts contains removed SSH secret-mode residue',
			]);
		} finally {
			await rm(repositoryRoot, { force: true, recursive: true });
		}
	});

	it('finds active OpenClaw residue in root quality config and architecture tooling', async () => {
		const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), 'agent-vm-quality-audit-'));
		try {
			await mkdir(path.join(repositoryRoot, 'scripts'), { recursive: true });
			await writeFile(
				path.join(repositoryRoot, '.oxlintrc.json'),
				'{"overrides":[{"files":["packages/openclaw-example/src/index.ts"]}]}\n',
				'utf8',
			);
			await writeFile(
				path.join(repositoryRoot, 'scripts', 'audit-portal-architecture.ts'),
				"const removedPrefix = 'packages/openclaw-example/src/';\n",
				'utf8',
			);

			await expect(auditOpenClawRemoval(repositoryRoot)).resolves.toEqual([
				'.oxlintrc.json contains active OpenClaw residue',
				'scripts/audit-portal-architecture.ts contains active OpenClaw residue',
			]);
		} finally {
			await rm(repositoryRoot, { force: true, recursive: true });
		}
	});

	it('finds no active residue in the current repository', async () => {
		await expect(auditOpenClawRemoval(process.cwd())).resolves.toEqual([]);
	});
});
