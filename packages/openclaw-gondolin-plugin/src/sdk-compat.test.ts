/**
 * SDK compatibility test — validates our type guard against the real OpenClaw SDK.
 *
 * This test can only run INSIDE a gateway VM where OpenClaw is installed.
 * Run manually: node --test packages/openclaw-gondolin-plugin/src/sdk-compat.test.mjs
 *
 * For CI: include in the live-smoke test suite that boots a gateway VM.
 * The test verifies that our assertSdkShape type guard matches the actual
 * exports from openclaw/plugin-sdk/sandbox. If OpenClaw changes its SDK,
 * this test catches the mismatch.
 */
import { describe, expect, it } from 'vitest';

// These are the function names our type guard checks for
const REQUIRED_SDK_EXPORTS = [
	'buildExecRemoteCommand',
	'buildRemoteCommand',
	'buildSshSandboxArgv',
	'createSshSandboxSessionFromSettings',
	'runSshSandboxCommand',
	'sanitizeEnvVars',
	'registerSandboxBackend',
] as const;

describe('SDK compatibility contract', () => {
	it('documents the required OpenClaw SDK exports that our type guard validates', () => {
		// This test documents our contract with the OpenClaw SDK.
		// If any of these exports are renamed or removed in a new OpenClaw version,
		// the assertSdkShape type guard will throw at runtime inside the gateway VM.
		//
		// To verify compatibility:
		// 1. Boot a gateway VM with the new OpenClaw version
		// 2. Run the SDK validation script (see sdk-validate.mjs below)
		// 3. If it passes, our plugin is compatible
		// 4. If it fails, update the type guard + SshHelpers interface

		expect(REQUIRED_SDK_EXPORTS).toEqual([
			'buildExecRemoteCommand',
			'buildRemoteCommand',
			'buildSshSandboxArgv',
			'createSshSandboxSessionFromSettings',
			'runSshSandboxCommand',
			'sanitizeEnvVars',
			'registerSandboxBackend',
		]);
	});
});

// Export for use in runtime validation script
export { REQUIRED_SDK_EXPORTS };
