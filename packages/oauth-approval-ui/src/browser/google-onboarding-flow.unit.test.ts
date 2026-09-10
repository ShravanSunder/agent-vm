import { describe, expect, it, vi } from 'vitest';

import {
	createGoogleOnboardingFlow,
	type GoogleOnboardingRuntime,
} from './google-onboarding-flow.js';

function fixture(hasSession = false): {
	readonly runtime: GoogleOnboardingRuntime;
	readonly events: string[];
} {
	const events: string[] = [];
	let active = hasSession;
	return {
		events,
		runtime: {
			hasIncompleteSignup: vi.fn(() => false),
			hasSession: () => active,
			acceptInvitation: vi.fn(async () => {
				events.push('ticket');
				return { kind: 'complete' as const, sessionId: 'ticket-session' };
			}),
			activateSession: async () => {
				active = true;
				events.push('activate');
			},
			prepareGoogle: vi.fn(async () => {
				events.push('pin-person');
			}),
			signOut: async () => {
				active = false;
				events.push('sign-out');
			},
			signInWithGoogle: vi.fn(async () => {
				events.push('google');
			}),
			continueInvitationWithGoogle: vi.fn(async () => {
				events.push('continue-google');
			}),
		},
	};
}

describe('Google-first onboarding flow', () => {
	it('resumes an incomplete signup after a cancelled provider roundtrip', async () => {
		const { runtime, events } = fixture();
		vi.mocked(runtime.hasIncompleteSignup).mockReturnValue(true);
		await createGoogleOnboardingFlow({ runtime, onState: () => {} }).continueWithGoogle();
		expect(events).toEqual(['continue-google']);
	});
	it('accepts a ticket but never completes onboarding with its email-only session', async () => {
		const { runtime, events } = fixture();
		await createGoogleOnboardingFlow({
			runtime,
			invitationTicket: 'ticket',
			onState: () => {},
		}).continueWithGoogle();
		expect(events).toEqual(['ticket', 'activate', 'pin-person', 'sign-out', 'google']);
	});
	it('continues the same incomplete invitation with Google', async () => {
		const { runtime, events } = fixture();
		vi.mocked(runtime.acceptInvitation).mockResolvedValue({ kind: 'incomplete' });
		await createGoogleOnboardingFlow({
			runtime,
			invitationTicket: 'ticket',
			onState: () => {},
		}).continueWithGoogle();
		expect(events).toEqual(['continue-google']);
	});
	it('pins an existing email-only person before replacing their session', async () => {
		const { runtime, events } = fixture(true);
		await createGoogleOnboardingFlow({ runtime, onState: () => {} }).continueWithGoogle();
		expect(events).toEqual(['pin-person', 'sign-out', 'google']);
	});
	it('does not sign out or start Google when expected-person binding fails', async () => {
		const { runtime, events } = fixture(true);
		vi.mocked(runtime.prepareGoogle).mockRejectedValue(new Error('expired'));
		const onState = vi.fn();
		await createGoogleOnboardingFlow({ runtime, onState }).continueWithGoogle();
		expect(events).toEqual([]);
		expect(onState).toHaveBeenLastCalledWith('failed');
	});
	it('rejects expired/used invitations without starting Google', async () => {
		const { runtime, events } = fixture();
		vi.mocked(runtime.acceptInvitation).mockRejectedValue(new Error('expired'));
		await createGoogleOnboardingFlow({
			runtime,
			invitationTicket: 'ticket',
			onState: () => {},
		}).continueWithGoogle();
		expect(events).toEqual([]);
	});
	it('prevents duplicate starts and permits retry after provider failure', async () => {
		const { runtime } = fixture();
		vi.mocked(runtime.signInWithGoogle).mockRejectedValueOnce(new Error('cancelled'));
		const flow = createGoogleOnboardingFlow({ runtime, onState: () => {} });
		await flow.continueWithGoogle();
		await Promise.all([flow.continueWithGoogle(), flow.continueWithGoogle()]);
		expect(runtime.signInWithGoogle).toHaveBeenCalledTimes(2);
	});
});
