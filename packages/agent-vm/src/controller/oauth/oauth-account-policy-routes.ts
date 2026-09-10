import { googleOAuthApplicationIdSchema, type OAuthConfig } from '@agent-vm/config-contracts';
import {
	renderOAuthAccountPolicyPage,
	renderOAuthOwnerIndex,
	oauthAccountPolicyPageSchema,
} from '@agent-vm/oauth-approval-ui';
import type {
	OAuthBrowserNavigationStore,
	OAuthLoginContinuationStore,
	OAuthLoginContinuationTarget,
} from '@agent-vm/oauth-broker';
import {
	oauthAccountIdSchema,
	oauthApplicationIdSchema,
	googleAccountPolicySnapshotSchema,
	googlePolicyOverrideCellSchema,
} from '@agent-vm/oauth-broker-contracts';
import type { GoogleOAuthBrokerService } from '@agent-vm/oauth-broker/google';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

import { beginClerkLogin } from './clerk-login-routes.js';
import type {
	GooglePermissionPolicyService,
	GoogleAccountPolicyView,
} from './google-permission-policy-service.js';
import {
	oauthNavigationCookieName,
	oauthNavigationBindingCookieName,
	type OAuthBrowserSessionRoutes,
} from './oauth-browser-session-routes.js';

const policyContextCookie = 'agent_vm_oauth_policy';
const policyBindingCookie = 'agent_vm_oauth_policy_binding';
type ReadyPolicyView = Extract<GoogleAccountPolicyView, { kind: 'ready' }>;
function accountPath(agentId: string, accountId: string): string {
	return `/oauth/agents/${encodeURIComponent(agentId)}/accounts/${encodeURIComponent(accountId)}`;
}
function formString(form: FormData, name: string): string {
	const value = form.get(name);
	if (form.getAll(name).length !== 1 || typeof value !== 'string')
		throw new Error('Invalid policy form field.');
	return value;
}
function parsePolicyCells(form: FormData): ReadyPolicyView['snapshot']['services'] {
	const services: Record<string, Record<string, unknown>> = {};
	for (const key of form.keys()) {
		if (['csrfToken', 'expectedConfigRevision', 'expectedOverrideRevision'].includes(key)) continue;
		const match = /^(read|write)\.([a-z0-9][a-z0-9._-]{0,127})$/u.exec(key);
		if (match === null || match[1] === undefined || match[2] === undefined)
			throw new Error('Unknown policy form field.');
		const value = formString(form, key);
		const cells = services[match[2]] ?? {};
		cells[match[1]] = googlePolicyOverrideCellSchema.parse(
			value === 'inherit' ? { kind: 'inherit' } : { kind: 'explicit', disposition: value },
		);
		services[match[2]] = cells;
	}
	return googleAccountPolicySnapshotSchema.shape.services.parse(services);
}
/** Owner pages share the outer OAuth website's network gate, CSP and body limits. */
export function createOAuthAccountPolicyRoutes(props: {
	readonly config: OAuthConfig;
	readonly broker: GoogleOAuthBrokerService;
	readonly policy: GooglePermissionPolicyService;
	readonly browser: OAuthBrowserSessionRoutes;
	readonly navigation: OAuthBrowserNavigationStore;
	readonly continuations: OAuthLoginContinuationStore;
	readonly stylesheet: string;
}): Hono {
	const app = new Hono();
	const navigation = (context: Context): ReturnType<OAuthBrowserNavigationStore['read']> =>
		props.navigation.read({
			contextId: getCookie(context, oauthNavigationCookieName) ?? '',
			browserBindingSecret: getCookie(context, oauthNavigationBindingCookieName) ?? '',
		});
	const identity = async (
		context: Context,
	): Promise<
		Extract<
			Awaited<ReturnType<OAuthBrowserSessionRoutes['readIdentity']>>,
			{ kind: 'verified' }
		>['identity']
	> => {
		const current = await props.browser.readIdentity(context.req.raw, { kind: 'navigation' });
		if (current.kind !== 'verified') throw new Error('Browser identity is unavailable.');
		return current.identity;
	};
	const requireNavigationForm = (
		context: Context,
		form: FormData,
	): NonNullable<ReturnType<typeof navigation>> => {
		const current = navigation(context);
		if (
			context.req.header('origin') !== props.config.browser.publicBaseUrl ||
			current === undefined ||
			formString(form, 'csrfToken') !== current.csrfToken
		)
			throw new Error('Invalid navigation form.');
		return current;
	};
	const model = (
		view: ReadyPolicyView,
		navigationCsrf: string,
		form?: { action: string; csrfToken: string },
		after?: ReadyPolicyView['snapshot']['services'],
	): ReturnType<typeof oauthAccountPolicyPageSchema.parse> =>
		oauthAccountPolicyPageSchema.parse({
			agentId: view.snapshot.agentId,
			accountAlias: view.accountAlias,
			applicationLabel: view.applicationLabel,
			ownerLabel: view.ownerLabel,
			activities: view.activities,
			services: view.snapshot.services,
			defaults: view.defaults,
			maximums: view.maximums,
			state: view.snapshot.state,
			canEdit: view.canEdit,
			configRevision: view.configRevision,
			overrideRevision: view.snapshot.overrideRevision,
			...(form === undefined ? {} : { formAction: form.action, csrfToken: form.csrfToken }),
			...(after === undefined ? {} : { after }),
			history: view.history.slice(-100).map(({ kind, timestampMs, oldRevision, newRevision }) => ({
				kind,
				timestampMs,
				oldRevision,
				newRevision,
			})),
			navigationCsrf,
			connectionActions:
				after === undefined
					? ['reauthorize', 'disconnect'].map((action) => ({
							action: `${accountPath(view.snapshot.agentId, view.snapshot.accountId)}/${view.snapshot.applicationId}/${action}`,
							label:
								action === 'reauthorize'
									? 'Change Google access / reconnect'
									: 'Disconnect this account from this agent',
						}))
					: [],
		});
	app.get('/oauth/agents', async (context) => {
		const current = navigation(context);
		if (current?.target.kind !== 'agents')
			return beginClerkLogin({
				context,
				target: { kind: 'agents' },
				continuations: props.continuations,
			});
		const owner = await identity(context);
		const agents = props.policy.listOwnerAccounts(owner).map((agent) => ({
			agentId: agent.agentId,
			accounts: agent.accounts.flatMap((account) =>
				account.applicationIds.map((applicationId) => ({
					accountAlias: `${account.accountAlias} · ${props.config.providers.google.applications[googleOAuthApplicationIdSchema.parse(applicationId)].label}`,
					href: `${accountPath(agent.agentId, account.accountId)}?application=${encodeURIComponent(applicationId)}`,
				})),
			),
			applications: Object.keys(props.config.agents[agent.agentId]?.applications ?? {}).map(
				(id) => ({
					applicationId: id,
					label:
						props.config.providers.google.applications[googleOAuthApplicationIdSchema.parse(id)]
							.label,
				}),
			),
		}));
		return context.html(
			renderOAuthOwnerIndex({
				stylesheet: props.stylesheet,
				model: { agents, csrfToken: current.csrfToken },
			}),
		);
	});
	app.get('/oauth/agents/:agentId/accounts/:accountId', async (context) => {
		const agentId = context.req.param('agentId');
		const accountId = oauthAccountIdSchema.parse(context.req.param('accountId'));
		const requestedApplication = context.req.query('application');
		const target = {
			kind: 'account',
			agentId,
			accountId,
			...(requestedApplication === undefined
				? {}
				: {
						applicationId: oauthApplicationIdSchema.parse(
							googleOAuthApplicationIdSchema.parse(requestedApplication),
						),
					}),
		} satisfies OAuthLoginContinuationTarget;
		const current = navigation(context);
		if (
			current?.target.kind !== 'account' ||
			current.target.accountId !== accountId ||
			current.target.agentId !== agentId
		)
			return beginClerkLogin({ context, target, continuations: props.continuations });
		const owner = await identity(context);
		const applicationId = googleOAuthApplicationIdSchema
			.and(oauthApplicationIdSchema)
			.parse(
				context.req.query('application') ??
					Object.keys(props.config.agents[agentId]?.applications ?? {})[0],
			);
		const view = props.policy.readAccountPolicyView({
			identity: owner,
			agentId,
			accountId,
			applicationId,
		});
		if (view.kind !== 'ready')
			return context.text('This account is unavailable.', view.kind === 'denied' ? 403 : 503);
		let form: { action: string; csrfToken: string } | undefined;
		if (view.canEdit && view.snapshot.state === 'active') {
			const opened = await props.policy.openPolicyEditor({
				identity: owner,
				agentId,
				accountId,
				applicationId,
			});
			if (opened.kind !== 'opened')
				return context.text('The policy editor is unavailable. Reload this account.', 409);
			for (const [name, value] of [
				[policyContextCookie, opened.contextId],
				[policyBindingCookie, opened.browserBindingSecret],
			] as const)
				setCookie(context, name, value, {
					httpOnly: true,
					secure: true,
					sameSite: 'Lax',
					path: '/oauth/policies',
					maxAge: 600,
				});
			form = { action: `/oauth/policies/${opened.contextId}/preview`, csrfToken: opened.csrfToken };
		}
		return context.html(
			renderOAuthAccountPolicyPage({
				stylesheet: props.stylesheet,
				model: model(view, current.csrfToken, form),
			}),
		);
	});
	app.post('/oauth/agents/:agentId/connect', async (context) => {
		const form = await context.req.formData();
		const current = requireNavigationForm(context, form);
		if (current.target.kind !== 'agents') return context.text('Reload the agents page.', 409);
		const applicationId = oauthApplicationIdSchema.parse(
			googleOAuthApplicationIdSchema.parse(formString(form, 'applicationId')),
		);
		const result = props.broker.beginWebsiteAuthorization({
			agentId: context.req.param('agentId'),
			identity: await identity(context),
			request: { actionId: 'oauth_authorization.begin', applicationId },
		});
		if (result.kind !== 'authorization-begun')
			return context.text('Could not begin authorization.', 403);
		return context.redirect(new URL(result.authorizationUrl).pathname, 303);
	});
	app.post('/oauth/agents/:agentId/accounts/:accountId/:applicationId/:action', async (context) => {
		const form = await context.req.formData();
		const current = requireNavigationForm(context, form);
		const accountId = oauthAccountIdSchema.parse(context.req.param('accountId'));
		const agentId = context.req.param('agentId');
		if (
			current.target.kind !== 'account' ||
			current.target.accountId !== accountId ||
			current.target.agentId !== agentId
		)
			return context.text('Reload this account first.', 409);
		const action = context.req.param('action');
		if (action !== 'reauthorize' && action !== 'disconnect') return context.notFound();
		const applicationId = oauthApplicationIdSchema.parse(
			googleOAuthApplicationIdSchema.parse(context.req.param('applicationId')),
		);
		const result = props.broker.beginWebsiteAuthorization({
			agentId,
			identity: await identity(context),
			request: {
				actionId:
					action === 'reauthorize'
						? 'oauth_authorization.reauthorize'
						: 'oauth_authorization.disconnect',
				accountId,
				applicationId,
			},
		});
		if (result.kind !== 'authorization-begun')
			return context.text('Could not begin authorization.', 403);
		return context.redirect(new URL(result.authorizationUrl).pathname, 303);
	});
	app.post('/oauth/policies/:contextId/:action', async (context) => {
		if (context.req.header('origin') !== props.config.browser.publicBaseUrl)
			return context.text('Invalid browser origin.', 403);
		const contextId = context.req.param('contextId');
		if (getCookie(context, policyContextCookie) !== contextId)
			return context.text('Policy context mismatch.', 403);
		const current = navigation(context);
		if (current === undefined) return context.text('Browser context expired. Sign in again.', 403);
		const form = await context.req.formData();
		const common = {
			contextId,
			browserBindingSecret: getCookie(context, policyBindingCookie) ?? '',
			csrfToken: formString(form, 'csrfToken'),
			identity: await identity(context),
			origin: props.config.browser.publicBaseUrl,
		};
		if (context.req.param('action') === 'preview') {
			const result = await props.policy.previewPolicyChange({
				...common,
				expectedConfigRevision: formString(form, 'expectedConfigRevision'),
				expectedOverrideRevision: Number(formString(form, 'expectedOverrideRevision')),
				services: parsePolicyCells(form),
			});
			if (result.kind !== 'preview')
				return context.text(
					`Policy preview rejected (${result.kind}). Reload the account and review its current limits.`,
					409,
				);
			return context.html(
				renderOAuthAccountPolicyPage({
					stylesheet: props.stylesheet,
					model: model(
						result.view,
						current.csrfToken,
						{ action: `/oauth/policies/${contextId}/confirm`, csrfToken: result.csrfToken },
						result.after,
					),
				}),
			);
		}
		if (context.req.param('action') !== 'confirm') return context.notFound();
		if ([...form.keys()].some((key) => key !== 'csrfToken'))
			return context.text('Invalid confirmation fields.', 400);
		const result = await props.policy.confirmPolicyChange(common);
		for (const name of [policyContextCookie, policyBindingCookie])
			deleteCookie(context, name, { path: '/oauth/policies', secure: true });
		if (result.kind === 'applied') return context.redirect('/oauth/agents', 303);
		return context.text(
			result.kind === 'pending' || result.kind === 'containment-failed'
				? 'Policy saved. Access remains paused until runtime containment is confirmed. Return to your accounts to check its status.'
				: 'Policy was not applied. Reload your account before trying again.',
			result.kind === 'pending' || result.kind === 'containment-failed' ? 202 : 409,
		);
	});
	app.onError((_error, context) =>
		context.text(
			'The account request could not be verified. Reload the page or sign in again.',
			403,
		),
	);
	return app;
}
