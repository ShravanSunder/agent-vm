import { loadClerkOnboarding } from './clerk-onboarding-runtime.js';
import { createGoogleOnboardingFlow } from './google-onboarding-flow.js';

async function startOnboarding(): Promise<void> {
	const root = document.querySelector<HTMLElement>('[data-google-onboarding]');
	const button = root?.querySelector<HTMLButtonElement>('[data-google-continue]');
	const status = root?.querySelector<HTMLElement>('[data-login-status]');
	if (root === null || root === undefined || status === null || status === undefined) return;
	const url = new URL(window.location.href);
	const tickets = url.searchParams.getAll('__clerk_ticket');
	const ticket =
		root.dataset.mode === 'invitation' && tickets.length === 1 && (tickets[0]?.length ?? 0) <= 8192
			? tickets[0]
			: undefined;
	// Remove the invitation before SDK loading, errors, or a user screenshot can expose it.
	if (root.dataset.mode === 'invitation') window.history.replaceState(null, '', url.pathname);
	try {
		if (root.dataset.mode === 'invitation' && !ticket) throw new Error('Missing invitation');
		const provider = await loadClerkOnboarding(root.dataset.publishableKey ?? '', window.location);
		if (root.dataset.mode === 'callback') {
			await provider.completeCallback();
			return;
		}
		if (button === null || button === undefined) return;
		if (
			ticket === undefined &&
			provider.runtime.hasSession() &&
			provider.hasGoogleIdentity() &&
			root.dataset.mode !== 'setup'
		) {
			window.location.replace('/oauth/auth/return');
			return;
		}
		if (ticket !== undefined && provider.runtime.hasSession())
			button.textContent = 'Switch account and continue with Google';
		const flow = createGoogleOnboardingFlow({
			runtime: provider.runtime,
			...(ticket === undefined ? {} : { invitationTicket: ticket }),
			onState: (state) => {
				button.disabled = state === 'pending';
				status.textContent =
					state === 'pending'
						? 'Opening Google…'
						: 'Google sign-in did not finish. Try again with the Google email that received your invitation. If the invitation has expired, ask for a new one.';
			},
		});
		button.disabled = false;
		button.addEventListener('click', () => {
			void flow.continueWithGoogle();
		});
		if (root.dataset.issue !== 'incomplete') status.textContent = '';
	} catch {
		status.textContent = 'Sign-in is unavailable. Reopen your invitation or try again in a moment.';
		if (button !== null && button !== undefined) button.disabled = true;
	}
}

void startOnboarding();
