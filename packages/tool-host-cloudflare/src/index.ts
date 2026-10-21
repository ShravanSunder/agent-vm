import { DurableObject } from 'cloudflare:workers';

/** Scaffold only; authorization storage is implemented in the S6 object slice. */
export class OrganizationAuthorization extends DurableObject {}

export default {
	fetch(): Response {
		return new Response('Tool Portal is not configured.', { status: 503 });
	},
};
