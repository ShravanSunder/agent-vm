import { describe, expect, it } from 'vitest';

import { resolvePortalApprovalDecision } from './portal-approval-policy.js';

describe('portal approval policy', () => {
	it('requires approval for untrusted namespaces unless explicitly allowed', () => {
		expect(
			resolvePortalApprovalDecision({
				config: {
					allowWithoutApprovalTools: [],
					alwaysAskTools: [],
					annotationPolicy: 'destructive-requires-approval',
					trustedAnnotationNamespaces: [],
					writeTools: [],
				},
				namespace: 'linear',
				toolName: 'read_issue',
				annotations: { readOnlyHint: true, destructiveHint: false },
			}),
		).toMatchObject({ kind: 'approval_required' });

		expect(
			resolvePortalApprovalDecision({
				config: {
					allowWithoutApprovalTools: [{ namespace: 'linear', toolName: 'read_issue' }],
					alwaysAskTools: [],
					annotationPolicy: 'destructive-requires-approval',
					trustedAnnotationNamespaces: [],
					writeTools: [],
				},
				namespace: 'linear',
				toolName: 'read_issue',
				annotations: { readOnlyHint: true, destructiveHint: false },
			}),
		).toEqual({ kind: 'allow' });
	});

	it('trusts read-only annotations only for configured namespaces', () => {
		expect(
			resolvePortalApprovalDecision({
				config: {
					allowWithoutApprovalTools: [],
					alwaysAskTools: [],
					annotationPolicy: 'destructive-requires-approval',
					trustedAnnotationNamespaces: ['linear'],
					writeTools: [],
				},
				namespace: 'linear',
				toolName: 'read_issue',
				annotations: { readOnlyHint: true, destructiveHint: false },
			}),
		).toEqual({ kind: 'allow' });
	});

	it('treats write tools as critical approval requests', () => {
		expect(
			resolvePortalApprovalDecision({
				config: {
					allowWithoutApprovalTools: [],
					alwaysAskTools: [],
					annotationPolicy: 'destructive-requires-approval',
					trustedAnnotationNamespaces: ['linear'],
					writeTools: [{ namespace: 'linear', toolName: 'create_issue' }],
				},
				namespace: 'linear',
				toolName: 'create_issue',
				annotations: { readOnlyHint: true, destructiveHint: false },
			}),
		).toEqual({ kind: 'approval_required', level: 'critical' });
	});

	it('does not let annotationPolicy off bypass untrusted namespaces', () => {
		expect(
			resolvePortalApprovalDecision({
				config: {
					allowWithoutApprovalTools: [],
					alwaysAskTools: [],
					annotationPolicy: 'off',
					trustedAnnotationNamespaces: [],
					writeTools: [],
				},
				namespace: 'linear',
				toolName: 'read_issue',
				annotations: { readOnlyHint: true, destructiveHint: false },
			}),
		).toEqual({ kind: 'approval_required', level: 'standard' });
	});
});
