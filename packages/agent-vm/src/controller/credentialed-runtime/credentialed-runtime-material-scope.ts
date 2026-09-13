export interface CredentialedRuntimeOAuthAuthorization {
	readonly accountId: string;
	readonly applicationId: string;
	readonly authorizationId: string;
	readonly generation: number;
	readonly overrideRevision: number;
}
export type CredentialedRuntimeInvalidationScope =
	| { readonly kind: 'agent' }
	| {
			readonly kind: 'oauth-authorization';
			readonly accountId: string;
			readonly applicationId: string;
			readonly authorizationId: string;
			readonly throughGeneration: number;
			readonly throughOverrideRevision?: number;
	  };

/** Called under the existing runtime-key lock, both before and after any active-command wait. */
export function runtimeMaterialMatchesInvalidation(props: {
	readonly scope: CredentialedRuntimeInvalidationScope;
	readonly authorization: CredentialedRuntimeOAuthAuthorization | undefined;
	readonly isOAuthRuntime: boolean;
}): boolean {
	if (props.scope.kind === 'agent') return true;
	if (!props.isOAuthRuntime) return false;
	const actual = props.authorization;
	if (actual === undefined) return true;
	const expected = props.scope;
	return (
		actual.accountId === expected.accountId &&
		actual.applicationId === expected.applicationId &&
		actual.authorizationId === expected.authorizationId &&
		actual.generation <= expected.throughGeneration &&
		(expected.throughOverrideRevision === undefined ||
			actual.overrideRevision <= expected.throughOverrideRevision)
	);
}
