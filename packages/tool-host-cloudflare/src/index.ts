export { OrganizationAuthorization } from '#worker-host/organization-authorization';

export default {
	fetch(): Response {
		return new Response('Tool Portal is not configured.', { status: 503 });
	},
};
