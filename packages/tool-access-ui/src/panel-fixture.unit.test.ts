import { createToolAccessPanelFixture } from '@tool-access-ui/panel-fixture';
import { routePanelRequest } from '@tool-access-ui/panel-request-router';
import {
	allAccessFilters,
	approvalModes,
	modeBadgeVariant,
	type ProposalDraft,
} from '@tool-access-ui/panel-view-types';
import { describe, expect, it } from 'vitest';
async function proposal(
	port: ReturnType<typeof createToolAccessPanelFixture>,
): Promise<ProposalDraft> {
	const result = await port.proposeChange({
		rowId: 'gmail-send',
		mode: 'blocked',
		reason: 'Literal fixture change',
	});
	if (result.kind !== 'proposed') throw new Error(result.message);
	return result.proposal;
}
describe('in-memory stand-in contract', (): void => {
	it('isolates reads and fixture instances', async (): Promise<void> => {
		const first = createToolAccessPanelFixture();
		const other = createToolAccessPanelFixture();
		const read = await first.read(allAccessFilters);
		await first.acceptProposal(await proposal(first));
		expect(read.associations.find((row): boolean => row.id === 'gmail-send')?.mode).toBe(
			'requires approval',
		);
		expect(
			(await other.read(allAccessFilters)).associations.find(
				(row): boolean => row.id === 'gmail-send',
			)?.mode,
		).toBe('requires approval');
		expect((await first.read(allAccessFilters)).associations).toHaveLength(6);
	});
	it('refuses a stale proposal without another state change', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		const first = await proposal(port);
		const second = await proposal(port);
		await port.acceptProposal(first);
		const before = await port.read(allAccessFilters);
		const result = await port.acceptProposal(second);
		expect(result.kind).toBe('stale');
		expect(await port.read(allAccessFilters)).toEqual(before);
	});
	it('does not replay a denied proposal', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		const draft = await proposal(port);
		await port.denyProposal(draft);
		expect((await port.acceptProposal(draft)).kind).toBe('rejected');
		expect((await port.read(allAccessFilters)).audit).toEqual([]);
	});
	it('never accepts auto or an empty note', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		const draft = await proposal(port);
		expect((await port.acceptProposal({ ...draft, mode: 'auto' })).kind).toBe('rejected');
		expect((await port.acceptProposal({ ...draft, reason: ' ' })).kind).toBe('rejected');
		expect((await port.read(allAccessFilters)).audit).toEqual([]);
	});
	it('keeps agent filtering separate from profile edit scope', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		const read = await port.read({ ...allAccessFilters, agent: 'Travel assistant' });
		expect(read.visibleAssociations).toHaveLength(1);
		expect(read.visibleAssociations[0]?.agents).toEqual(['Calendar assistant', 'Travel assistant']);
	});
	it('uses exact approval words and variants', (): void => {
		expect(approvalModes).toEqual(['approved', 'auto', 'requires approval', 'blocked']);
		expect(modeBadgeVariant('approved')).toBe('default');
		expect(modeBadgeVariant('auto')).toBe('secondary');
		expect(modeBadgeVariant('requires approval')).toBe('outline');
		expect(modeBadgeVariant('blocked')).toBe('destructive');
	});
	it('does not silently pick a tool for an ambiguous edit', async (): Promise<void> => {
		const read = await createToolAccessPanelFixture().read(allAccessFilters);
		expect(routePanelRequest('Block email', read.associations).kind).toBe('clarify');
		expect(routePanelRequest('Show scan', read.associations).kind).toBe('scan');
		expect(routePanelRequest('Run a shell', read.associations).kind).toBe('unsupported');
	});
});
