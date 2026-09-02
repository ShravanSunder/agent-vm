import { timingSafeEqual, X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { isIP } from 'node:net';
import { createSecureContext } from 'node:tls';

import {
	oauthApprovalPageModelSchema,
	renderOAuthApprovalPage,
	type OAuthApprovalAssetManifest,
	type OAuthApprovalPageModel,
	type OAuthPermissionFieldError,
} from '@agent-vm/oauth-approval-ui';
import {
	oauthPermissionChoiceSchema,
	oauthPermissionSelectionsSchema,
	oauthTransactionIdSchema,
	type OAuthPermissionChoice,
	type OAuthPermissionSelections,
} from '@agent-vm/oauth-broker-contracts';
import type {
	GoogleOAuthBrokerService,
	GoogleOAuthConfirmationPageData,
	GoogleOAuthPermissionPageData,
} from '@agent-vm/oauth-broker/google';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

import { closeNodeServer, waitForNodeServerListening } from '../http/node-server-lifecycle.js';

const transactionIdCookieName = 'agent_vm_oauth_transaction';
const transactionBindingCookieName = 'agent_vm_oauth_transaction_binding';
const completionIdCookieName = 'agent_vm_oauth_completion';
const completionBindingCookieName = 'agent_vm_oauth_completion_binding';
const oauthCookiePath = '/oauth';
const oauthCookieMaxAgeSeconds = 10 * 60;

export interface TailnetPeerIdentity {
	readonly loginName: string;
}

export interface TailnetIdentityResolver {
	resolvePeerIdentity(props: {
		readonly remoteAddress: string;
		readonly remotePort: number;
	}): Promise<TailnetPeerIdentity>;
}

export interface OAuthApprovalAssets {
	readonly files: Readonly<Record<string, Uint8Array>>;
	readonly manifest: OAuthApprovalAssetManifest;
}

export interface OAuthHttpsBindings {
	readonly incoming: {
		readonly socket: {
			readonly remoteAddress?: string | undefined;
			readonly remotePort?: number | undefined;
		};
	};
}

function setOpaqueCookie(props: {
	readonly context: Parameters<typeof setCookie>[0];
	readonly expiresAtMs: number;
	readonly name: string;
	readonly nowMs: number;
	readonly value: string;
}): void {
	const remainingLifetimeSeconds = Math.max(
		0,
		Math.min(oauthCookieMaxAgeSeconds, Math.floor((props.expiresAtMs - props.nowMs) / 1_000)),
	);
	setCookie(props.context, props.name, props.value, {
		httpOnly: true,
		maxAge: remainingLifetimeSeconds,
		path: oauthCookiePath,
		sameSite: 'Lax',
		secure: true,
	});
}

function clearCeremonyCookies(context: Parameters<typeof deleteCookie>[0]): void {
	for (const cookieName of [
		transactionIdCookieName,
		transactionBindingCookieName,
		completionIdCookieName,
		completionBindingCookieName,
	]) {
		deleteCookie(context, cookieName, { path: oauthCookiePath, secure: true });
	}
}

function requireFormString(form: FormData, fieldName: string): string {
	const value = form.get(fieldName);
	if (typeof value !== 'string') throw new Error(`OAuth form field "${fieldName}" is invalid.`);
	return value;
}

function requireMatchingOpaqueSecret(actual: string, expected: string, label: string): void {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	if (
		actualBytes.byteLength !== expectedBytes.byteLength ||
		!timingSafeEqual(actualBytes, expectedBytes)
	) {
		throw new Error(`${label} does not match.`);
	}
}

function securityHeaders(context: { header(name: string, value: string): void }): void {
	context.header(
		'Content-Security-Policy',
		[
			"default-src 'none'",
			"base-uri 'none'",
			"object-src 'none'",
			"style-src 'self'",
			"script-src 'self'",
			"connect-src 'self'",
			"img-src 'self'",
			"form-action 'self'",
			"frame-ancestors 'none'",
		].join('; '),
	);
	context.header('Referrer-Policy', 'same-origin');
	context.header('X-Content-Type-Options', 'nosniff');
	context.header('Cache-Control', 'no-store');
}

function permissionPageModel(page: GoogleOAuthPermissionPageData): OAuthApprovalPageModel {
	return oauthApprovalPageModelSchema.parse({
		accountProfileLabel: page.accountProfileLabel,
		applications: page.applications,
		kind: 'permission-selection' as const,
	});
}

type PermissionSelectionPageModel = Extract<
	OAuthApprovalPageModel,
	{ readonly kind: 'permission-selection' }
>;

type PermissionFormResult =
	| { readonly kind: 'invalid'; readonly model: PermissionSelectionPageModel }
	| { readonly kind: 'valid'; readonly selections: OAuthPermissionSelections };

function parsePermissionForm(
	page: GoogleOAuthPermissionPageData,
	form: FormData,
): PermissionFormResult {
	const fieldErrors: OAuthPermissionFieldError[] = [];
	const selections: Record<string, Record<string, OAuthPermissionChoice>> = {};
	const model = permissionPageModel(page);
	if (model.kind !== 'permission-selection') {
		throw new Error('OAuth permission page model changed its kind.');
	}
	const applications = model.applications.map((application) => ({
		...application,
		services: application.services.map((service) => {
			const rawChoice = form.get(`permission.${application.applicationId}.${service.serviceId}`);
			const parsedChoice = oauthPermissionChoiceSchema.safeParse(rawChoice);
			if (!parsedChoice.success || !service.allowedChoices.includes(parsedChoice.data)) {
				fieldErrors.push({
					applicationId: application.applicationId,
					message: `Select an allowed permission for ${service.label}.`,
					serviceId: service.serviceId,
				});
				return service;
			}
			const applicationSelections = selections[application.applicationId] ?? {};
			applicationSelections[service.serviceId] = parsedChoice.data;
			selections[application.applicationId] = applicationSelections;
			return { ...service, selectedChoice: parsedChoice.data };
		}),
	}));
	return fieldErrors.length > 0
		? { kind: 'invalid', model: { ...model, applications, errors: fieldErrors } }
		: { kind: 'valid', selections: oauthPermissionSelectionsSchema.parse(selections) };
}

function confirmationPageModel(page: GoogleOAuthConfirmationPageData): OAuthApprovalPageModel {
	return oauthApprovalPageModelSchema.parse({
		accountLabel: page.accountLabel,
		applicationLabel: page.applicationLabel,
		grantedPermissionLabels: page.grantedPermissionLabels,
		kind: 'account-confirmation' as const,
	});
}

function renderPage(props: {
	readonly assets: OAuthApprovalAssets;
	readonly cancelAction?: string | undefined;
	readonly continueUrl?: string | undefined;
	readonly csrfToken?: string | undefined;
	readonly formAction?: string | undefined;
	readonly model: Parameters<typeof renderOAuthApprovalPage>[0]['model'];
}): string {
	return renderOAuthApprovalPage({
		assetBasePath: '/oauth/assets',
		cancelAction: props.cancelAction,
		continueUrl: props.continueUrl,
		csrfToken: props.csrfToken,
		formAction: props.formAction,
		javascriptAssetName: props.assets.manifest.javascript,
		model: props.model,
		stylesheetAssetName: props.assets.manifest.css,
	});
}

function isTailscaleAddress(address: string): boolean {
	if (isIP(address) !== 4) return false;
	const octets = address.split('.').map(Number);
	return octets[0] === 100 && (octets[1] ?? -1) >= 64 && (octets[1] ?? 256) <= 127;
}

export function createOAuthHttpsApp(props: {
	readonly assets: OAuthApprovalAssets;
	readonly brokerService: GoogleOAuthBrokerService;
	readonly now?: () => number;
	readonly publicBaseUrl: string;
	readonly tailnetIdentityResolver: TailnetIdentityResolver;
}): Hono<{ Bindings: OAuthHttpsBindings }> {
	const app = new Hono<{ Bindings: OAuthHttpsBindings }>();
	const expectedOrigin = new URL(props.publicBaseUrl).origin;
	const now = props.now ?? Date.now;

	app.use('*', async (context, next) => {
		securityHeaders(context);
		await next();
	});

	const resolveTailnetLogin = async (context: {
		readonly env: OAuthHttpsBindings;
	}): Promise<string> => {
		const remoteAddress = context.env.incoming.socket.remoteAddress;
		const remotePort = context.env.incoming.socket.remotePort;
		if (remoteAddress === undefined || remotePort === undefined) {
			throw new Error('OAuth request omitted its socket peer identity.');
		}
		return (await props.tailnetIdentityResolver.resolvePeerIdentity({ remoteAddress, remotePort }))
			.loginName;
	};

	const requireSameOrigin = (origin: string | undefined): void => {
		if (origin !== expectedOrigin) throw new Error('OAuth form Origin is invalid.');
	};

	app.get('/oauth/assets/:assetName', (context) => {
		const assetName = context.req.param('assetName');
		const bytes = props.assets.files[assetName];
		if (bytes === undefined) return context.notFound();
		context.header('Cache-Control', 'public, max-age=31536000, immutable');
		context.header(
			'Content-Type',
			assetName.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
		);
		return context.body(Uint8Array.from(bytes).buffer);
	});

	app.get('/oauth/transactions/:transactionId', async (context) => {
		try {
			const transactionId = oauthTransactionIdSchema.parse(context.req.param('transactionId'));
			const tailnetLogin = await resolveTailnetLogin(context);
			const page = props.brokerService.getPermissionPage({ tailnetLogin, transactionId });
			setOpaqueCookie({
				context,
				expiresAtMs: page.expiresAtMs,
				name: transactionIdCookieName,
				nowMs: now(),
				value: page.transactionId,
			});
			setOpaqueCookie({
				context,
				expiresAtMs: page.expiresAtMs,
				name: transactionBindingCookieName,
				nowMs: now(),
				value: page.browserBindingSecret,
			});
			return context.html(
				renderPage({
					assets: props.assets,
					cancelAction: `/oauth/transactions/${page.transactionId}/cancel`,
					csrfToken: page.csrfToken,
					formAction: `/oauth/transactions/${page.transactionId}/permissions`,
					model: permissionPageModel(page),
				}),
			);
		} catch {
			return context.html(
				renderPage({
					assets: props.assets,
					model: { kind: 'failed', message: 'This authorization link is unavailable.' },
				}),
				403,
			);
		}
	});

	app.post('/oauth/transactions/:transactionId/permissions', async (context) => {
		try {
			requireSameOrigin(context.req.header('origin'));
			const transactionId = oauthTransactionIdSchema.parse(context.req.param('transactionId'));
			if (getCookie(context, transactionIdCookieName) !== transactionId) {
				throw new Error('OAuth transaction cookie does not match the route.');
			}
			const browserBindingSecret = getCookie(context, transactionBindingCookieName);
			if (browserBindingSecret === undefined) throw new Error('OAuth browser binding is missing.');
			const tailnetLogin = await resolveTailnetLogin(context);
			const page = props.brokerService.getPermissionPage({ tailnetLogin, transactionId });
			const form = await context.req.formData();
			requireMatchingOpaqueSecret(
				browserBindingSecret,
				page.browserBindingSecret,
				'OAuth browser binding',
			);
			const submittedCsrfToken = requireFormString(form, 'csrfToken');
			requireMatchingOpaqueSecret(submittedCsrfToken, page.csrfToken, 'OAuth CSRF token');
			const permissionForm = parsePermissionForm(page, form);
			if (permissionForm.kind === 'invalid') {
				return context.html(
					renderPage({
						assets: props.assets,
						cancelAction: `/oauth/transactions/${page.transactionId}/cancel`,
						csrfToken: page.csrfToken,
						formAction: `/oauth/transactions/${page.transactionId}/permissions`,
						model: permissionForm.model,
					}),
					400,
				);
			}
			const result = props.brokerService.submitPermissions({
				browserBindingSecret,
				csrfToken: submittedCsrfToken,
				selections: permissionForm.selections,
				tailnetLogin,
				transactionId,
			});
			if (result.kind === 'redirect') {
				return context.html(
					renderPage({
						assets: props.assets,
						cancelAction: `/oauth/transactions/${result.transactionId}/cancel`,
						continueUrl: result.authorizationUrl,
						csrfToken: page.csrfToken,
						model: {
							applications: [
								{
									applicationId: result.applicationId,
									label: result.applicationLabel,
									status: 'authorizing',
								},
							],
							kind: 'application-progress',
						},
					}),
				);
			}
			clearCeremonyCookies(context);
			return context.html(
				renderPage({
					assets: props.assets,
					model: { accountLabel: page.accountProfileLabel, kind: 'completed' },
				}),
			);
		} catch {
			return context.html(
				renderPage({
					assets: props.assets,
					model: { kind: 'failed', message: 'The permission submission was rejected.' },
				}),
				403,
			);
		}
	});

	app.post('/oauth/transactions/:transactionId/cancel', async (context) => {
		try {
			requireSameOrigin(context.req.header('origin'));
			const transactionId = oauthTransactionIdSchema.parse(context.req.param('transactionId'));
			if (getCookie(context, transactionIdCookieName) !== transactionId) {
				throw new Error('OAuth transaction cookie does not match the route.');
			}
			const browserBindingSecret = getCookie(context, transactionBindingCookieName);
			if (browserBindingSecret === undefined) throw new Error('OAuth browser binding is missing.');
			const form = await context.req.formData();
			const cancelled = props.brokerService.cancelBrowserTransaction({
				browserBindingSecret,
				csrfToken: requireFormString(form, 'csrfToken'),
				tailnetLogin: await resolveTailnetLogin(context),
				transactionId,
			});
			if (!cancelled) throw new Error('OAuth transaction cancellation was rejected.');
			clearCeremonyCookies(context);
			return context.html(
				renderPage({
					assets: props.assets,
					model: { kind: 'cancelled', message: 'Authorization was cancelled.' },
				}),
			);
		} catch {
			return context.html(
				renderPage({
					assets: props.assets,
					model: { kind: 'failed', message: 'Authorization cancellation was rejected.' },
				}),
				403,
			);
		}
	});

	app.post('/oauth/completions/:retryId/retry', async (context) => {
		try {
			requireSameOrigin(context.req.header('origin'));
			const transactionId = oauthTransactionIdSchema.parse(context.req.param('retryId'));
			if (getCookie(context, transactionIdCookieName) !== transactionId) {
				throw new Error('OAuth retry cookie does not match the route.');
			}
			const browserBindingSecret = getCookie(context, transactionBindingCookieName);
			if (browserBindingSecret === undefined) throw new Error('OAuth retry binding is missing.');
			const form = await context.req.formData();
			const retry = props.brokerService.retryApplication({
				browserBindingSecret,
				csrfToken: requireFormString(form, 'csrfToken'),
				tailnetLogin: await resolveTailnetLogin(context),
				transactionId,
			});
			return context.html(
				renderPage({
					assets: props.assets,
					cancelAction: `/oauth/transactions/${retry.transactionId}/cancel`,
					continueUrl: retry.authorizationUrl,
					csrfToken: requireFormString(form, 'csrfToken'),
					model: {
						applications: [
							{
								applicationId: retry.applicationId,
								label: retry.applicationLabel,
								status: 'authorizing',
							},
						],
						kind: 'application-progress',
					},
				}),
			);
		} catch {
			return context.html(
				renderPage({
					assets: props.assets,
					model: { kind: 'failed', message: 'Google authorization retry was rejected.' },
				}),
				403,
			);
		}
	});

	app.get('/oauth/google/callback', async (context) => {
		try {
			const transactionId = oauthTransactionIdSchema.parse(
				getCookie(context, transactionIdCookieName),
			);
			const browserBindingSecret = getCookie(context, transactionBindingCookieName);
			if (browserBindingSecret === undefined) throw new Error('OAuth browser binding is missing.');
			const result = await props.brokerService.handleGoogleCallback({
				authorizationCode: context.req.query('code') ?? '',
				browserBindingSecret,
				oauthState: context.req.query('state') ?? '',
				redirectUri: new URL('/oauth/google/callback', props.publicBaseUrl).toString(),
				tailnetLogin: await resolveTailnetLogin(context),
				transactionId,
			});
			if (result.kind === 'failed') {
				const expired = result.reason === 'expired';
				return context.html(
					renderPage({
						assets: props.assets,
						model: expired
							? { kind: 'expired', message: 'This authorization link expired. Start again.' }
							: { kind: 'failed', message: 'Google authorization could not be verified.' },
					}),
					expired ? 410 : 403,
				);
			}
			deleteCookie(context, transactionIdCookieName, { path: oauthCookiePath, secure: true });
			deleteCookie(context, transactionBindingCookieName, { path: oauthCookiePath, secure: true });
			if (result.kind === 'partial-completion') {
				setOpaqueCookie({
					context,
					expiresAtMs: result.retry.expiresAtMs,
					name: transactionIdCookieName,
					nowMs: now(),
					value: result.retry.transactionId,
				});
				setOpaqueCookie({
					context,
					expiresAtMs: result.retry.expiresAtMs,
					name: transactionBindingCookieName,
					nowMs: now(),
					value: result.retry.browserBindingSecret,
				});
				return context.html(
					renderPage({
						assets: props.assets,
						cancelAction: `/oauth/transactions/${result.retry.transactionId}/cancel`,
						csrfToken: result.retryCsrfToken,
						formAction: `/oauth/completions/${result.retry.transactionId}/retry`,
						model: {
							completed: result.completed,
							kind: 'partial-completion',
							retryable: result.retryable,
						},
					}),
				);
			}
			setOpaqueCookie({
				context,
				expiresAtMs: result.confirmation.expiresAtMs,
				name: completionIdCookieName,
				nowMs: now(),
				value: result.confirmation.completionSessionId,
			});
			setOpaqueCookie({
				context,
				expiresAtMs: result.confirmation.expiresAtMs,
				name: completionBindingCookieName,
				nowMs: now(),
				value: result.confirmation.browserBindingSecret,
			});
			return context.html(
				renderPage({
					assets: props.assets,
					cancelAction: `/oauth/completions/${result.confirmation.completionSessionId}/cancel`,
					csrfToken: result.confirmation.csrfToken,
					formAction: `/oauth/completions/${result.confirmation.completionSessionId}/confirm`,
					model: confirmationPageModel(result.confirmation),
				}),
			);
		} catch {
			return context.html(
				renderPage({
					assets: props.assets,
					model: { kind: 'failed', message: 'Google authorization could not be verified.' },
				}),
				403,
			);
		}
	});

	app.post('/oauth/completions/:completionId/cancel', async (context) => {
		try {
			requireSameOrigin(context.req.header('origin'));
			const completionId = context.req.param('completionId');
			if (getCookie(context, completionIdCookieName) !== completionId) {
				throw new Error('OAuth completion cookie does not match the route.');
			}
			const browserBindingSecret = getCookie(context, completionBindingCookieName);
			if (browserBindingSecret === undefined) {
				throw new Error('OAuth completion binding is missing.');
			}
			const form = await context.req.formData();
			const cancelled = props.brokerService.cancelBrowserCompletion({
				browserBindingSecret,
				completionSessionId: completionId,
				csrfToken: requireFormString(form, 'csrfToken'),
				tailnetLogin: await resolveTailnetLogin(context),
			});
			if (!cancelled) throw new Error('OAuth completion cancellation was rejected.');
			clearCeremonyCookies(context);
			return context.html(
				renderPage({
					assets: props.assets,
					model: { kind: 'cancelled', message: 'Authorization was cancelled.' },
				}),
			);
		} catch {
			return context.html(
				renderPage({
					assets: props.assets,
					model: { kind: 'failed', message: 'Authorization cancellation was rejected.' },
				}),
				403,
			);
		}
	});

	app.post('/oauth/completions/:completionId/confirm', async (context) => {
		try {
			requireSameOrigin(context.req.header('origin'));
			const completionId = context.req.param('completionId');
			if (getCookie(context, completionIdCookieName) !== completionId) {
				throw new Error('OAuth completion cookie does not match the route.');
			}
			const browserBindingSecret = getCookie(context, completionBindingCookieName);
			if (browserBindingSecret === undefined)
				throw new Error('OAuth completion binding is missing.');
			const form = await context.req.formData();
			const result = await props.brokerService.confirmAccount({
				browserBindingSecret,
				completionSessionId: completionId,
				csrfToken: requireFormString(form, 'csrfToken'),
				tailnetLogin: await resolveTailnetLogin(context),
			});
			clearCeremonyCookies(context);
			if (result.kind === 'redirect') {
				setOpaqueCookie({
					context,
					expiresAtMs: result.expiresAtMs,
					name: transactionIdCookieName,
					nowMs: now(),
					value: result.transactionId,
				});
				setOpaqueCookie({
					context,
					expiresAtMs: result.expiresAtMs,
					name: transactionBindingCookieName,
					nowMs: now(),
					value: result.browserBindingSecret,
				});
				return context.html(
					renderPage({
						assets: props.assets,
						cancelAction: `/oauth/transactions/${result.transactionId}/cancel`,
						continueUrl: result.authorizationUrl,
						csrfToken: result.csrfToken,
						model: { applications: result.applications, kind: 'application-progress' },
					}),
				);
			}
			if (result.kind === 'subject-mismatch') throw new Error('Google subject mismatch.');
			if (result.kind === 'authorization-denied') {
				throw new Error('OAuth grant replacement was not authorized.');
			}
			return context.html(
				renderPage({
					assets: props.assets,
					model: { accountLabel: result.accountLabel, kind: 'completed' },
				}),
			);
		} catch {
			return context.html(
				renderPage({
					assets: props.assets,
					model: { kind: 'failed', message: 'Account confirmation was rejected.' },
				}),
				403,
			);
		}
	});

	return app;
}

export async function startOAuthHttpsServer(props: {
	readonly app: Hono<{ Bindings: OAuthHttpsBindings }>;
	readonly bindAddress: string;
	readonly certificatePath: string;
	readonly port: number;
	readonly privateKeyPath: string;
	readonly publicHostname: string;
	readonly now?: (() => number) | undefined;
}): Promise<{ close(): Promise<void> }> {
	if (!isTailscaleAddress(props.bindAddress)) {
		throw new Error('OAuth HTTPS listener must bind an exact Tailscale address.');
	}
	const [certificate, privateKey] = await Promise.all([
		readFile(props.certificatePath, 'utf8'),
		readFile(props.privateKeyPath, 'utf8'),
	]);
	const x509 = new X509Certificate(certificate);
	if (x509.checkHost(props.publicHostname) === undefined) {
		throw new Error('OAuth TLS certificate does not cover the configured public hostname.');
	}
	const currentTimeMs = (props.now ?? Date.now)();
	if (currentTimeMs < Date.parse(x509.validFrom) || currentTimeMs > Date.parse(x509.validTo)) {
		throw new Error('OAuth TLS certificate is not valid at the current time.');
	}
	createSecureContext({ cert: certificate, key: privateKey });
	return await startOAuthTlsListener({
		app: props.app,
		bindAddress: props.bindAddress,
		certificate,
		port: props.port,
		privateKey,
	});
}

/** Low-level listener lifecycle seam. Callers must validate bind and TLS policy first. */
export async function startOAuthTlsListener(props: {
	readonly app: Hono<{ Bindings: OAuthHttpsBindings }>;
	readonly bindAddress: string;
	readonly certificate: string;
	readonly port: number;
	readonly privateKey: string;
}): Promise<{ close(): Promise<void> }> {
	const server = serve({
		createServer,
		fetch: props.app.fetch,
		hostname: props.bindAddress,
		overrideGlobalObjects: false,
		port: props.port,
		serverOptions: { cert: props.certificate, key: props.privateKey },
	});
	await waitForNodeServerListening(server);
	return {
		close: async (): Promise<void> => await closeNodeServer(server),
	};
}
