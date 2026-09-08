import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);

async function installedServerOperationsUrl(): Promise<string> {
	const consumerRoot = process.env.AGENT_VM_TEST_PACKED_CONSUMER_ROOT;
	if (consumerRoot === undefined)
		return new URL('./sandbox/server-ops.js', import.meta.resolve('@earendil-works/gondolin')).href;
	// Optional packaging qualification follows the real transitive dependency,
	// rather than accidentally proving the source workspace's patched install.
	const resolved = await executeFile(
		process.execPath,
		[
			'--experimental-import-meta-resolve',
			'--input-type=module',
			'-e',
			`import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const root = await realpath(process.argv[1]);
const application = import.meta.resolve('@agent-vm/agent-vm', pathToFileURL(path.join(root, 'package.json')).href);
const adapter = import.meta.resolve('@agent-vm/gondolin-vm-adapter', application);
const gondolin = import.meta.resolve('@earendil-works/gondolin', adapter);
for (const entry of [application, adapter, gondolin]) assert.ok((await realpath(new URL(entry))).startsWith(root + path.sep));
console.log(new URL('./sandbox/server-ops.js', gondolin).href);`,
			consumerRoot,
		],
		{ maxBuffer: 16 * 1024, timeout: 10_000 },
	);
	return resolved.stdout.trim();
}

// The installed dependency, not a copied implementation, must contain our
// approved PR #136 patch. Run in a child so an unhandled private-promise rejection
// is fatal without installing a process-global suppression handler in Vitest.
// See docs/architecture/gondolin-patches.md for approval and removal conditions.
const probeSource = String.raw`
import assert from 'node:assert/strict';
const { SandboxServerOps } = await import(process.argv[1]);
const scenario = process.argv[2];
const failure = new Error('intentional-file-operation-failure');
const abortController = new AbortController();
const server = Object.assign(new SandboxServerOps(), {
  fileOps: new Map(), inflight: new Map(), startedExecs: new Set(),
  execQueue: [], nextFileOpId: 1, activeFileOpId: null,
  start: async () => {}, waitForExecIdle: async () => {},
  scheduleControllerIdlePause: () => {}, pumpExecQueue: () => {},
});
server.sendControlMessage = async (message, signal) => {
  if (signal?.aborted) throw failure;
  if (scenario.endsWith('transport')) throw failure;
  if (scenario === 'success' && message.t === 'file_write_data' && message.p.eof) {
    server.resolveFileOperation(message.id);
  }
};
async function* input() {
  yield Buffer.of(0, 255, 128);
  if (scenario === 'write-input') throw failure;
  if (scenario === 'write-abort') abortController.abort();
}
let rejected = false;
try {
  if (scenario === 'delete-transport') {
    await server.deleteGuestFile('/operation/file');
  } else {
    await server.writeGuestFile('/operation/file', input(), {
      signal: abortController.signal,
    });
  }
} catch (error) {
  assert.equal(error, failure);
  rejected = true;
}
assert.equal(rejected, scenario !== 'success');
assert.equal(server.fileOps.size, 0);
assert.equal(server.activeFileOpId, null);
// Advance one event-loop turn: hidden rejections must fail the child first.
await new Promise(resolve => setImmediate(resolve));
console.log(JSON.stringify({ scenario, rejected, settled: true }));
`;

describe('installed Gondolin file-operation rejection patch', () => {
	it.each(['write-input', 'write-transport', 'write-abort', 'delete-transport', 'success'])(
		'contains %s without an unhandled process rejection',
		async (scenario) => {
			// Arrange: only the VM/transport edge is injected; promise handling is
			// the actual installed Gondolin implementation in a real Node process.
			const moduleUrl = await installedServerOperationsUrl();

			// Act: strict rejection behavior cannot be hidden by a test listener.
			const result = await executeFile(
				process.execPath,
				[
					'--unhandled-rejections=strict',
					'--input-type=module',
					'-e',
					probeSource,
					moduleUrl,
					scenario,
				],
				{ maxBuffer: 16 * 1_024, timeout: 10_000 },
			);

			// Assert: the public failure is preserved while the child stays healthy.
			expect(JSON.parse(result.stdout.trim())).toEqual({
				rejected: scenario !== 'success',
				scenario,
				settled: true,
			});
			expect(result.stderr).toBe('');
		},
	);
});
