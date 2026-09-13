export type InvitationAcceptance =
	| { readonly kind: 'complete'; readonly sessionId: string }
	| { readonly kind: 'incomplete' };

/** The external Clerk boundary; tests replace the provider, not the flow. */
export interface GoogleOnboardingRuntime {
	readonly hasSession: () => boolean;
	readonly hasIncompleteSignup: () => boolean;
	readonly acceptInvitation: (ticket: string) => Promise<InvitationAcceptance>;
	readonly activateSession: (sessionId: string) => Promise<void>;
	readonly prepareGoogle: () => Promise<void>;
	readonly signOut: () => Promise<void>;
	readonly signInWithGoogle: () => Promise<void>;
	readonly continueInvitationWithGoogle: () => Promise<void>;
}

export function createGoogleOnboardingFlow(props: {
	readonly runtime: GoogleOnboardingRuntime;
	readonly invitationTicket?: string;
	readonly onState: (state: 'pending' | 'failed') => void;
}): { readonly continueWithGoogle: () => Promise<void> } {
	let pending = false;
	let invitationTicket = props.invitationTicket;
	let incompleteInvitation = false;
	return {
		continueWithGoogle: async () => {
			if (pending) return;
			pending = true;
			props.onState('pending');
			try {
				if (invitationTicket !== undefined) {
					// The button explicitly says it switches the current person for an invitation.
					if (props.runtime.hasSession()) await props.runtime.signOut();
					const accepted = await props.runtime.acceptInvitation(invitationTicket);
					invitationTicket = undefined;
					incompleteInvitation = accepted.kind === 'incomplete';
					if (accepted.kind === 'complete') await props.runtime.activateSession(accepted.sessionId);
				}
				if (
					incompleteInvitation ||
					(!props.runtime.hasSession() && props.runtime.hasIncompleteSignup())
				) {
					await props.runtime.continueInvitationWithGoogle();
					return;
				}
				if (props.runtime.hasSession()) {
					await props.runtime.prepareGoogle();
					await props.runtime.signOut();
				}
				await props.runtime.signInWithGoogle();
			} catch {
				pending = false;
				props.onState('failed');
			}
		},
	};
}
