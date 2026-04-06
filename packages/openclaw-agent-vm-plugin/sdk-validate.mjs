#!/usr/bin/env node
/**
 * Runtime SDK validation — run this INSIDE a gateway VM to verify
 * our plugin's type guard matches the actual OpenClaw SDK exports.
 *
 * Usage (inside VM):
 *   node /opt/extensions/gondolin/sdk-validate.mjs
 *
 * Exit 0 = compatible, Exit 1 = mismatch (lists missing exports)
 */
const SDK_PATH = '/usr/local/lib/node_modules/openclaw/dist/plugin-sdk/sandbox.js';

const REQUIRED_EXPORTS = [
	'buildExecRemoteCommand',
	'buildRemoteCommand',
	'buildSshSandboxArgv',
	'createSshSandboxSessionFromSettings',
	'runSshSandboxCommand',
	'sanitizeEnvVars',
	'registerSandboxBackend',
];

try {
	const sdk = await import(SDK_PATH);
	const missing = REQUIRED_EXPORTS.filter((name) => typeof sdk[name] !== 'function');

	if (missing.length > 0) {
		console.error('SDK MISMATCH — missing exports:', missing.join(', '));
		console.error('Update assertSdkShape() and SshHelpers interface in plugin.ts');
		process.exit(1);
	}

	console.log('SDK COMPATIBLE — all', REQUIRED_EXPORTS.length, 'required exports found');
	process.exit(0);
} catch (err) {
	console.error('SDK LOAD FAILED:', err.message);
	console.error('Is OpenClaw installed? Expected at:', SDK_PATH);
	process.exit(1);
}
