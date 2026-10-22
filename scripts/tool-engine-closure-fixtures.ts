import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ToolEngineClosureFixture {
	readonly name: string;
	readonly source: string;
	readonly reason: string;
	readonly scanReason?: string;
	readonly declaration?: string;
}

/** Controlled dependency branches distinguish Node resolution from real Worker bundling. */
export async function prepareToolEngineClosureFixtures(root: string): Promise<void> {
	// Node-first clean entry makes accidental retention of Node's condition fail this control.
	const poisonDirectory = path.join(root, 'node_modules', 's4d-worker-closure-poison');
	await mkdir(poisonDirectory, { recursive: true });
	await writeFile(
		path.join(poisonDirectory, 'package.json'),
		JSON.stringify({
			name: 's4d-worker-closure-poison',
			type: 'module',
			exports: {
				'.': {
					node: './node.js',
					workerd: './worker.js',
					worker: './worker.js',
					browser: './worker.js',
					default: './node.js',
				},
			},
		}),
	);
	await writeFile(path.join(poisonDirectory, 'node.js'), 'export const selected = "node";');
	await writeFile(
		path.join(poisonDirectory, 'worker.js'),
		"import 'node:fs'; export const selected = 'worker';",
	);
	const browserPoisonDirectory = path.join(root, 'node_modules', 's4d-browser-field-poison');
	await mkdir(browserPoisonDirectory, { recursive: true });
	await writeFile(
		path.join(browserPoisonDirectory, 'package.json'),
		JSON.stringify({
			name: 's4d-browser-field-poison',
			type: 'module',
			main: './node.js',
			browser: './browser.js',
		}),
	);
	await writeFile(
		path.join(browserPoisonDirectory, 'node.js'),
		'export const marker = "node-clean";',
	);
	await writeFile(
		path.join(browserPoisonDirectory, 'browser.js'),
		"import 'node:fs'; export const marker = 'browser-poison';",
	);
}

export function toolEngineClosureFixtures(original: string): readonly ToolEngineClosureFixture[] {
	return [
		{
			name: 'lazy',
			source: original + "\nexport async function sdkLazyPoison(){return import('node:fs');}\n",
			reason: 'tool-engine forbidden import node:fs',
		},
		{
			name: 're-export',
			source: original + "\nexport * from 'node:fs';\n",
			reason: 'tool-engine forbidden import node:fs',
		},
		{
			name: 'compiler',
			source: original + "\nimport 'typescript';\n",
			reason: 'tool-engine forbidden import typescript',
		},
		{
			name: 'worker-third-party',
			source: original + "\nimport 's4d-worker-closure-poison';\n",
			reason: 'tool-engine forbidden import node:fs',
			scanReason: '[worker scan]',
		},
		{
			name: 'worker-third-party-require',
			source: original + "\nrequire('s4d-worker-closure-poison');\n",
			reason: 'tool-engine forbidden import node:fs',
			scanReason: '[worker scan]',
		},
		{
			name: 'browser-main-field',
			source:
				original +
				"\nimport { marker } from 's4d-browser-field-poison'; globalThis.closureBrowserMarker = marker;\n",
			reason: 'tool-engine forbidden import node:fs',
			scanReason: '[worker scan]',
		},
		{
			name: 'direct',
			source: `${original}\nimport 'node:fs';`,
			reason: 'tool-engine forbidden import node:fs',
			scanReason: '[first-party scan]',
		},
		{
			name: 'transitive',
			source: `${original}\nexport * from './s2-transitive-poison.js';`,
			reason: 'tool-engine forbidden import node:fs',
		},
		{
			name: 'host',
			source: `${original}\nimport '@agent-collaboration/tool-host-node';`,
			reason: 'tool-engine forbidden import @agent-collaboration/tool-host-node',
		},
		{
			name: 'managed-type',
			source: original,
			reason: 'tool-engine managed type GatewayRuntimeTrustedInvocationContext',
		},
		{
			name: 'transitive-type',
			source: original,
			reason: 'tool-engine managed type GatewayRuntimeTrustedInvocationContext',
		},
		{
			name: 'agent-vm',
			source: `${original}\nimport '@agent-vm/agent-vm';`,
			reason: 'tool-engine forbidden import @agent-vm/agent-vm',
		},
		{
			name: 'gondolin',
			source: `${original}\nimport '@gondolin/provider';`,
			reason: 'tool-engine forbidden import @gondolin/provider',
		},
		{
			name: 'controller-test-alias',
			source: original,
			declaration:
				"import type { ControllerApprovalLedger } from '@agent-vm/controller-test-support/approval/controller-approval-ledger.js'; export type AliasPoison = ControllerApprovalLedger;",
			reason:
				'tool-engine forbidden import @agent-vm/controller-test-support/approval/controller-approval-ledger.js',
		},
		{
			name: 'config-test-alias',
			source: original,
			declaration:
				"import type { createOAuthPolicyCompilerTestInput } from '@agent-vm/config-contracts-test-support/oauth-policy-compiler-test-fixture.js'; export type AliasPoison = typeof createOAuthPolicyCompilerTestInput;",
			reason:
				'tool-engine forbidden import @agent-vm/config-contracts-test-support/oauth-policy-compiler-test-fixture.js',
		},
		{
			name: 'policy-test-alias',
			source: original,
			declaration:
				"import type { callPolicyDecision } from '@agent-vm/tool-portal/policy-comparison'; export type AliasPoison = typeof callPolicyDecision;",
			reason: 'tool-engine forbidden import @agent-vm/tool-portal/policy-comparison',
		},
	];
}
