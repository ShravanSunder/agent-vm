import { z } from 'zod';

import { writeControllerDiagnostic } from '../controller-diagnostic-logging.js';

const oauthGoogleCallbackDiagnosticReasonSchema = z.enum([
	'authorization-denied',
	'browser-binding-mismatch',
	'callback-failed',
	'callback-rejected',
	'configuration-change-required',
	'consumed',
	'consumed-or-missing',
	'duplicate-authorization',
	'expired',
	'identity-mismatch',
	'invalid-redirect',
	'invalid-state',
	'provider-response-invalid',
	'scope-mismatch',
	'stale-authorization',
	'subject-mismatch',
	'unavailable',
	'wrong-state',
]);
export type OAuthGoogleCallbackDiagnosticReason = z.infer<
	typeof oauthGoogleCallbackDiagnosticReasonSchema
>;

export function classifyOAuthGoogleCallbackFailureReason(
	reason: string,
): OAuthGoogleCallbackDiagnosticReason {
	const parsed = oauthGoogleCallbackDiagnosticReasonSchema.safeParse(reason);
	return parsed.success ? parsed.data : 'callback-failed';
}

export function writeOAuthGoogleCallbackFailureDiagnostic(
	reason: OAuthGoogleCallbackDiagnosticReason,
): void {
	writeControllerDiagnostic('runtime', {
		event: 'controller-operation-failed',
		failureClass: 'rejected',
		level: 'warning',
		telemetry: {
			operation: 'oauth-google-callback',
			reason,
		},
	});
}
