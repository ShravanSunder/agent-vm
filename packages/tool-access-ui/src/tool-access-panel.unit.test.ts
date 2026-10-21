import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createToolAccessPanelFixture } from '@tool-access-ui/panel-fixture';
import {
	allAccessFilters,
	type AcceptResult,
	type PanelSnapshot,
	type ToolAccessPanelPort,
} from '@tool-access-ui/panel-view-types';
import { ToolAccessPanel } from '@tool-access-ui/tool-access-panel';
// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach((): void => {
	vi.stubGlobal(
		'matchMedia',
		(query: string): MediaQueryList => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: (): void => {},
			removeListener: (): void => {},
			addEventListener: (): void => {},
			removeEventListener: (): void => {},
			dispatchEvent: (): boolean => true,
		}),
	);
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		},
	);
	vi.stubGlobal(
		'fetch',
		vi.fn((): never => {
			throw new Error('Panel must not contact a model or provider.');
		}),
	);
});
afterEach((): void => {
	cleanup();
	vi.unstubAllGlobals();
});
async function perform(action: () => void): Promise<void> {
	await act(async (): Promise<void> => {
		action();
	});
}
async function mountPanel(port: ToolAccessPanelPort): Promise<void> {
	await perform((): void => {
		render(createElement(ToolAccessPanel, { port }));
	});
}
async function request(text: string): Promise<void> {
	await perform((): void => {
		fireEvent.change(screen.getByLabelText('Request'), { target: { value: text } });
	});
	await perform((): void => {
		fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
	});
}
async function click(name: string): Promise<void> {
	await perform((): void => {
		fireEvent.click(screen.getByRole('button', { name }));
	});
}
async function selectMode(mode: string): Promise<void> {
	await perform((): void => {
		fireEvent.click(screen.getByLabelText('Proposed mode'));
	});
	await perform((): void => {
		const option = screen.getByRole('option', { name: mode });
		fireEvent.pointerDown(option, { pointerType: 'mouse' });
		fireEvent.click(option);
	});
}
function accessTable(): HTMLElement {
	return screen.getByRole('table', { name: 'Access associations' });
}
function modeFor(snapshot: PanelSnapshot, id = 'gmail-send'): string | undefined {
	return snapshot.associations.find((row): boolean => row.id === id)?.mode;
}

// Oracles: adopted design.md request/proposal/status/account sections. Real panel + registry
// components and fixture port stay in process; no host/auth/provider/durable-store claim.
describe('ToolAccessPanel', (): void => {
	it('shows broad email and exact tool views without changing rows or audit', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		const before = await port.read(allAccessFilters);
		await mountPanel(port);
		await request('Show email access');
		expect(within(accessTable()).getAllByRole('row')).toHaveLength(3);
		expect(within(accessTable()).getByText('Read email')).toBeTruthy();
		expect(within(accessTable()).getByText('Send email')).toBeTruthy();
		await request('Show Read email');
		expect(within(accessTable()).getAllByRole('row')).toHaveLength(2);
		expect(within(accessTable()).queryByText('Send email')).toBeNull();
		expect(await port.read(allAccessFilters)).toEqual(before);
		expect(fetch).not.toHaveBeenCalled();
	});
	it('keeps Show read-only when an exact tool name contains an edit verb', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		const before = await port.read(allAccessFilters);
		await mountPanel(port);
		await request('Show Change team calendar');
		expect(screen.queryByText('Review proposed change')).toBeNull();
		expect(within(accessTable()).getAllByRole('row')).toHaveLength(2);
		expect(within(accessTable()).getByText('Change team calendar')).toBeTruthy();
		expect(await port.read(allAccessFilters)).toEqual(before);
	});
	it.each(['rejected', 'thrown'])(
		'shows a recoverable Alert for %s proposal preparation without changing access',
		async (failure: string): Promise<void> => {
			const fixture = createToolAccessPanelFixture();
			const before = await fixture.read(allAccessFilters);
			let attempts = 0;
			const port: ToolAccessPanelPort = {
				...fixture,
				async proposeChange(intent) {
					attempts += 1;
					if (attempts === 1) {
						if (failure === 'thrown') throw new Error('Proposal service unavailable.');
						return { kind: 'rejected', message: 'Proposal service unavailable.' };
					}
					return await fixture.proposeChange(intent);
				},
			};
			await mountPanel(port);
			await request('Show Read email');
			await request('Block Send email');
			expect(within(accessTable()).getAllByRole('row')).toHaveLength(2);
			expect(screen.getByRole('alert').classList.contains('text-destructive')).toBe(true);
			expect(screen.getByRole('alert').textContent).toContain('Proposal service unavailable.');
			expect(screen.getByLabelText('Request').getAttribute('value')).toBe('Block Send email');
			expect(await fixture.read(allAccessFilters)).toEqual(before);
			await click('Retry request');
			expect(screen.getByText('Review proposed change')).toBeTruthy();
			expect(screen.getByLabelText('Change note').getAttribute('value')).toBe('Block Send email');
			expect(screen.queryByRole('alert')).toBeNull();
			expect(attempts).toBe(2);
			expect(await fixture.read(allAccessFilters)).toEqual(before);
		},
	);

	it('keeps ambiguous and unsupported requests effect-free and retains the existing view', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		await mountPanel(port);
		await request('Show Read email');
		await request('Block email');
		expect(screen.getByRole('status').textContent).toContain('Choose one tool');
		expect(screen.queryByText('Review proposed change')).toBeNull();
		await request('Delete every credential');
		expect(screen.getByRole('status').textContent).toContain('current view is retained');
		expect(within(accessTable()).getAllByRole('row')).toHaveLength(2);
		expect((await port.read(allAccessFilters)).audit).toEqual([]);
	});
	it('preserves edited target and note through a second request, navigation and another account Sheet', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		await mountPanel(port);
		await request('Block send email');
		await perform((): void => {
			fireEvent.change(screen.getByLabelText('Change note'), {
				target: { value: 'Keep this edited note' },
			});
		});
		await request('Approve Capture a screen');
		expect(screen.getByDisplayValue('Keep this edited note')).toBeTruthy();
		await click('Accounts');
		const calendarRow = screen.getByText('Operations calendar').closest('tr');
		if (!calendarRow) throw new Error('Account row missing');
		await perform((): void => {
			fireEvent.click(within(calendarRow).getByRole('button', { name: 'Open account' }));
		});
		const sheet = screen.getByRole('dialog');
		expect(within(sheet).getByText('A proposal is already open')).toBeTruthy();
		expect(
			within(sheet).getByRole('button', { name: 'Propose change' }).hasAttribute('disabled'),
		).toBe(true);
		await perform((): void => {
			fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
		});
		await click('Access');
		expect(screen.getByDisplayValue('Keep this edited note')).toBeTruthy();
		expect(screen.getByLabelText('Proposed mode').textContent).toContain('blocked');
		expect(screen.getByLabelText('Proposal editor').textContent).toContain('Send email');
		expect((await port.read(allAccessFilters)).audit).toEqual([]);
	});
	it('denies through the port without changing confirmed rows or audit', async (): Promise<void> => {
		const fixture = createToolAccessPanelFixture();
		let denied = 0;
		const port: ToolAccessPanelPort = {
			...fixture,
			async denyProposal(draft) {
				denied += 1;
				await fixture.denyProposal(draft);
			},
		};
		const before = await fixture.read(allAccessFilters);
		await mountPanel(port);
		await request('Block send email');
		await click('Deny proposal');
		expect(screen.queryByText('Review proposed change')).toBeNull();
		expect(await fixture.read(allAccessFilters)).toEqual(before);
		expect(denied).toBe(1);
	});
	it('dismisses destructive confirmation without submitting, then confirms the edited change and audit', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		await mountPanel(port);
		await request('Block send email');
		await perform((): void => {
			fireEvent.change(screen.getByLabelText('Change note'), {
				target: { value: 'Owner requested block' },
			});
		});
		await click('Accept change');
		const dialog = screen.getByRole('alertdialog');
		expect(within(dialog).getByText('Block Send email?')).toBeTruthy();
		expect(dialog.textContent).toContain('Calendar assistant will lose this action');
		await click('Keep editing');
		expect(modeFor(await port.read(allAccessFilters))).toBe('requires approval');
		expect(screen.getByDisplayValue('Owner requested block')).toBeTruthy();
		await click('Accept change');
		await click('Block tool');
		const state = await port.read(allAccessFilters);
		expect(modeFor(state)).toBe('blocked');
		expect(state.audit).toHaveLength(1);
		expect(state.audit[0]?.details).toContain('Owner requested block');
		expect(screen.queryByText('Review proposed change')).toBeNull();
		await click('Audit log');
		expect(screen.getByRole('table', { name: 'Audit events' }).textContent).toContain(
			'requires approval → blocked',
		);
	});
	it('holds edits and confirmed rows while accept is pending, and applies the edited mode only after confirmation', async (): Promise<void> => {
		const fixture = createToolAccessPanelFixture();
		const { promise: barrier, resolve: release } = Promise.withResolvers<void>();
		const port: ToolAccessPanelPort = {
			...fixture,
			async acceptProposal(draft) {
				await barrier;
				return await fixture.acceptProposal(draft);
			},
		};
		await mountPanel(port);
		await request('Block send email');
		await selectMode('approved');
		await perform((): void => {
			fireEvent.change(screen.getByLabelText('Change note'), {
				target: { value: 'Edited approved note' },
			});
		});
		await click('Accept change');
		expect(screen.getByRole('button', { name: 'Waiting for host…' }).hasAttribute('disabled')).toBe(
			true,
		);
		expect(screen.getByRole('status').textContent).not.toContain('Change confirmed');
		expect(modeFor(await fixture.read(allAccessFilters))).toBe('requires approval');
		expect((await fixture.read(allAccessFilters)).audit).toEqual([]);
		await act(async (): Promise<void> => {
			release();
			await barrier;
		});
		expect(modeFor(await fixture.read(allAccessFilters))).toBe('approved');
		expect((await fixture.read(allAccessFilters)).audit[0]?.details).toContain(
			'Edited approved note',
		);
		expect(screen.queryByText('Review proposed change')).toBeNull();
	});
	it('retains the edited draft on a rejected save with no local mutation or success', async (): Promise<void> => {
		const fixture = createToolAccessPanelFixture();
		const before = await fixture.read(allAccessFilters);
		const port: ToolAccessPanelPort = {
			...fixture,
			async acceptProposal(): Promise<AcceptResult> {
				return { kind: 'rejected', message: 'Configured editor refused the change.' };
			},
		};
		await mountPanel(port);
		await request('Approve Send email');
		await perform((): void => {
			fireEvent.change(screen.getByLabelText('Change note'), {
				target: { value: 'Retain rejected draft' },
			});
		});
		await click('Accept change');
		expect(screen.getByRole('alert').textContent).toContain('Configured editor refused');
		expect(screen.getByDisplayValue('Retain rejected draft')).toBeTruthy();
		expect(await fixture.read(allAccessFilters)).toEqual(before);
		expect(screen.getByRole('status').textContent).not.toContain('Change confirmed');
	});
	it('requires state readback after an unknown acceptance before another decision', async (): Promise<void> => {
		const fixture = createToolAccessPanelFixture();
		let acceptCount = 0;
		const port: ToolAccessPanelPort = {
			...fixture,
			async acceptProposal(): Promise<AcceptResult> {
				acceptCount += 1;
				throw new Error('Response lost.');
			},
		};
		await mountPanel(port);
		await request('Approve Send email');
		await click('Accept change');
		expect(screen.getByText('Outcome not confirmed')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Accept change' }).hasAttribute('disabled')).toBe(
			true,
		);
		expect(screen.getByRole('button', { name: 'Deny proposal' }).hasAttribute('disabled')).toBe(
			true,
		);
		await click('Read current state');
		expect(screen.getByRole('button', { name: 'Accept change' }).hasAttribute('disabled')).toBe(
			false,
		);
		expect(acceptCount).toBe(1);
		expect((await fixture.read(allAccessFilters)).audit).toEqual([]);
	});
	it('refreshes stale current values and keeps edits for renewed review', async (): Promise<void> => {
		const fixture = createToolAccessPanelFixture();
		let first = true;
		const port: ToolAccessPanelPort = {
			...fixture,
			async acceptProposal(draft): Promise<AcceptResult> {
				if (first) {
					first = false;
					const concurrent = await fixture.proposeChange({
						rowId: 'web-search',
						mode: 'blocked',
						reason: 'Concurrent change',
					});
					if (concurrent.kind === 'proposed') await fixture.acceptProposal(concurrent.proposal);
				}
				return await fixture.acceptProposal(draft);
			},
		};
		await mountPanel(port);
		await request('Approve Send email');
		await click('Accept change');
		expect(screen.getByRole('alert').textContent).toContain('Current values changed');
		expect(screen.getByLabelText('Change note').getAttribute('value')).toBe('Approve Send email');
		expect(modeFor(await fixture.read(allAccessFilters))).toBe('requires approval');
		await click('Accept change');
		expect(modeFor(await fixture.read(allAccessFilters))).toBe('approved');
	});
	it('shows all exact D-9 words and keeps auto and approved-until unavailable', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		await mountPanel(port);
		const text = accessTable().textContent;
		expect(text).toContain('approved');
		expect(text).toContain('requires approval');
		expect(text).toContain('blocked');
		await request('Set Send email auto');
		expect(screen.getByText('Auto configuration slot')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Accept change' }).hasAttribute('disabled')).toBe(
			true,
		);
		await selectMode('approved');
		expect(screen.getByLabelText('Approved until · future slot').hasAttribute('disabled')).toBe(
			true,
		);
		expect((await port.read(allAccessFilters)).audit).toEqual([]);
	});
	it('uses organization scope and three tool kinds, and scans without mutating state or making model calls', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		const before = await port.read(allAccessFilters);
		await mountPanel(port);
		expect(accessTable().textContent).toContain('Organization tools');
		expect(accessTable().textContent).toContain('Per-user tools');
		expect(accessTable().textContent).toContain('Computer tools');
		expect(screen.getByText(/Organization scope/)).toBeTruthy();
		await click('Show scan');
		expect(screen.getByRole('table', { name: 'Scan results' }).textContent).toContain('Needs key');
		expect(screen.getByText(/example checks/).textContent).toContain('no provider contacted');
		expect(await port.read(allAccessFilters)).toEqual(before);
		expect(fetch).not.toHaveBeenCalled();
	});
	it('opens the personal account Sheet and proposes the account/agent/application rule', async (): Promise<void> => {
		const port = createToolAccessPanelFixture();
		await mountPanel(port);
		await click('Accounts');
		const row = screen.getByText('Maya Gmail').closest('tr');
		if (!row) throw new Error('Gmail account missing');
		await perform((): void => {
			fireEvent.click(within(row).getByRole('button', { name: 'Open account' }));
		});
		const sheet = screen.getByRole('dialog');
		expect(sheet.textContent).toContain('Personal · Maya');
		expect(sheet.textContent).toContain('Read email · Send email');
		const sendRow = within(sheet).getByText('Send email').closest('tr');
		if (!sendRow) throw new Error('Send rule missing');
		await perform((): void => {
			fireEvent.click(within(sendRow).getByRole('button', { name: 'Propose change' }));
		});
		expect(screen.queryByRole('dialog')).toBeNull();
		expect(screen.getByLabelText('Proposal editor').textContent).toContain(
			'Maya Gmail · Calendar assistant · Gmail',
		);
	});
});
