import { describe, expect, it } from 'vitest';

import { buildRuntimeInstructions } from './runtime-instructions-builder.js';

describe('buildRuntimeInstructions', () => {
	it('describes work paths, agent-visible runtime files, controller tools, resources, and auth hints', () => {
		const runtime = buildRuntimeInstructions({
			gatewayType: 'worker',
			resolvedResources: [
				{
					name: 'pg',
					host: 'pg.local',
					port: 5432,
					envVars: ['DATABASE_URL'],
					outputPath: '/agent-vm/resources/portal',
				},
			],
			runtimeAuthHints: [
				{
					kind: 'service-token',
					secret: 'GITHUB_TOKEN',
					service: 'github',
					hosts: ['api.github.com'],
					tools: ['gh'],
				},
				{
					kind: 'service-token',
					secret: 'NPM_AUTH_TOKEN',
					service: 'npm',
					hosts: ['registry.npmjs.org'],
					tools: ['npm', 'pnpm', 'yarn'],
				},
				{
					kind: 'service-token',
					secret: 'PYPI_TOKEN',
					service: 'pypi-private',
					hosts: ['pypi.example.test'],
					tools: ['uv'],
				},
				{
					kind: 'service-token',
					secret: 'MAVEN_TOKEN',
					service: 'maven-private',
					hosts: ['maven.example.test'],
					tools: ['mvn'],
				},
			],
			taskId: 'task-123',
			workDir: '/work/repos',
		});

		expect(runtime.runtimeInstructions).toContain('Runtime instructions');
		expect(runtime.runtimeInstructions).toContain('/work/repos/AGENTS.md');
		expect(runtime.runtimeInstructions).toContain('/work/repos/CLAUDE.md');
		expect(runtime.runtimeInstructions).toContain('/agent-vm/agents.md');
		expect(runtime.runtimeInstructions).toContain('/agent-vm/CLAUDE.md');
		expect(runtime.runtimeInstructions).toContain('/agent-vm/resources/portal');
		expect(runtime.runtimeInstructions).toContain('pg.local:5432');
		expect(runtime.runtimeInstructions).toContain('DATABASE_URL');
		expect(runtime.runtimeInstructions).toContain('git-push');
		expect(runtime.runtimeInstructions).toContain('github');
		expect(runtime.runtimeInstructions).toContain('gh');
		expect(runtime.runtimeInstructions).toContain('NPM_AUTH_TOKEN');
		expect(runtime.runtimeInstructions).toContain('registry.npmjs.org');
		expect(runtime.runtimeInstructions).toContain(
			'You MUST configure each tool below before running any command that uses it.',
		);
		expect(runtime.runtimeInstructions).toContain(
			`printf '//registry.npmjs.org/:_authToken=\${NPM_AUTH_TOKEN}\\n' > "$HOME/.npmrc"`,
		);
		expect(runtime.runtimeInstructions).toContain('npm, pnpm, and yarn-classic');
		expect(runtime.runtimeInstructions).toContain('If you must use yarn-berry');
		expect(runtime.runtimeInstructions).toContain('GH_TOKEN="$GITHUB_TOKEN" gh pr create');
		expect(runtime.runtimeInstructions).toContain(
			'UV_INDEX_URL="https://__token__:$PYPI_TOKEN@pypi.example.test/simple"',
		);
		expect(runtime.runtimeInstructions).not.toContain('PIP_INDEX_URL');
		expect(runtime.runtimeInstructions).not.toContain('poetry config');
		expect(runtime.runtimeInstructions).not.toContain('TWINE_PASSWORD');
		expect(runtime.runtimeInstructions).toContain(
			'Before using these tools, you MUST configure your toolchain to read the placeholder env var $MAVEN_TOKEN.',
		);
		expect(runtime.agentRuntimeFiles['agents.md']).toContain('/agent-vm/runtime-instructions.md');
		expect(runtime.agentRuntimeFiles['agents.md']).toContain('pg.local:5432');
		expect(runtime.agentRuntimeFiles['agents.md']).not.toContain('$NPM_AUTH_TOKEN');
	});

	it('describes Linear mediated auth through LINEAR_API_KEY', () => {
		const runtime = buildRuntimeInstructions({
			gatewayType: 'worker',
			resolvedResources: [],
			runtimeAuthHints: [
				{
					kind: 'service-token',
					secret: 'LINEAR_API_KEY',
					service: 'linear',
					hosts: ['api.linear.app'],
					tools: ['linear'],
				},
			],
			taskId: 'task-linear',
			workDir: '/work',
		});

		expect(runtime.runtimeInstructions).toContain(
			'LINEAR_API_KEY="$LINEAR_API_KEY" linear issue mine',
		);
		expect(runtime.runtimeInstructions).toContain('linear auth whoami');
		expect(runtime.runtimeInstructions).toContain('Do not store the API key in .linear.toml');
	});

	it('describes Readwise mediated auth through MCP-backed CLI commands', () => {
		const runtime = buildRuntimeInstructions({
			gatewayType: 'worker',
			resolvedResources: [],
			runtimeAuthHints: [
				{
					kind: 'service-token',
					secret: 'READWISE_ACCESS_TOKEN',
					service: 'readwise',
					hosts: ['mcp2.readwise.io'],
					tools: ['readwise'],
				},
			],
			taskId: 'task-readwise',
			workDir: '/work',
		});

		expect(runtime.runtimeInstructions).toContain(
			'readwise login-with-token "$READWISE_ACCESS_TOKEN"',
		);
		expect(runtime.runtimeInstructions).toContain('mcp2.readwise.io');
		expect(runtime.runtimeInstructions).toContain(
			'readwise reader-search-documents --query "test"',
		);
		expect(runtime.runtimeInstructions).toContain('stores the placeholder, not the raw token');
	});

	it('rejects non-worker runtime instruction callers after type bypass', () => {
		expect(() =>
			buildRuntimeInstructions({
				gatewayType: 'hermes',
				resolvedResources: [],
				runtimeAuthHints: [],
				taskId: 'task-hermes',
				workDir: '/work',
			} as never),
		).toThrow('Runtime instructions are only supported for worker gateway zones.');
	});
});
