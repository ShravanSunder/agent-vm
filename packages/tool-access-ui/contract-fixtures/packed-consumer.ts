import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks, isBuiltin, type ResolveFnOutput } from 'node:module';
import { fileURLToPath } from 'node:url';

const resolutions: string[] = [];
registerHooks({
	resolve(specifier, context, nextResolve): ResolveFnOutput {
		assert.ok(!isBuiltin(specifier), `Browser entry imported Node: ${specifier}`);
		assert.ok(
			!/^@agent-vm\/|^@agent-collaboration\/tool-host-/.test(specifier),
			`Host dependency: ${specifier}`,
		);
		const resolved = nextResolve(specifier, context);
		resolutions.push(resolved.url);
		return resolved;
	},
});
const panel = await import('@agent-collaboration/tool-access-ui');
const { createToolAccessPanelFixture } =
	await import('@agent-collaboration/tool-access-ui/fixture');
assert.equal(typeof panel.ToolAccessPanel, 'function');
assert.deepEqual(panel.approvalModes, ['approved', 'auto', 'requires approval', 'blocked']);
const port = createToolAccessPanelFixture();
const before = await port.read(panel.allAccessFilters);
const proposed = await port.proposeChange({
	rowId: 'gmail-send',
	mode: 'approved',
	reason: 'Packed consumer',
});
assert.equal(proposed.kind, 'proposed');
const accepted = await port.acceptProposal(proposed.proposal);
assert.equal(accepted.kind, 'accepted');
const after = await port.read(panel.allAccessFilters);
assert.equal(after.associations.find((row) => row.id === 'gmail-send')?.mode, 'approved');
assert.equal(before.audit.length, 0);
assert.equal(after.audit.length, 1);
const css = await readFile(
	fileURLToPath(import.meta.resolve('@agent-collaboration/tool-access-ui/styles.css')),
	'utf8',
);
assert.match(css, /#1c2026/i);
assert.ok(css.length > 1000);
assert.ok(resolutions.length > 10);
assert.ok(!resolutions.some((url) => url.includes('/packages/tool-access-ui/')));
process.stdout.write(
	`Packed panel + fixture + CSS passed; ${resolutions.length} runtime resolutions; no workspace fallback.`,
);
