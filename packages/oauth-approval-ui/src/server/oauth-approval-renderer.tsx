import { readFile } from 'node:fs/promises';

import { renderToString } from 'hono/jsx/dom/server';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { z } from 'zod';

import {
	oauthApprovalAssetManifestSchema,
	oauthApprovalPageModelSchema,
	type OAuthApprovalAssetManifest,
	type OAuthApprovalPageModel,
	type OAuthApplicationChoiceModel,
	type OAuthPermissionFieldError,
} from '../contracts.js';
import {
	permissionSelectionSummary,
	resolvePermissionSelectionMode,
} from '../permission-selection-summary.js';

const renderPropsSchema = z
	.object({
		assetBasePath: z.string().startsWith('/').max(512),
		cancelAction: z.string().startsWith('/').max(1_024).optional(),
		continueUrl: z
			.url()
			.refine((value) => new URL(value).protocol === 'https:', {
				message: 'OAuth continuation URLs must use HTTPS.',
			})
			.optional(),
		csrfToken: z.string().min(32).max(512).optional(),
		formAction: z.string().startsWith('/').max(1_024).optional(),
		javascriptAssetName: z.string().regex(/^oauth\.[a-f0-9]{16}\.js$/u),
		stylesheetAssetName: z.string().regex(/^oauth\.[a-f0-9]{16}\.css$/u),
	})
	.strict();

export interface OAuthApprovalRenderProps {
	readonly assetBasePath: string;
	readonly cancelAction?: string | undefined;
	readonly continueUrl?: string | undefined;
	readonly csrfToken?: string | undefined;
	readonly formAction?: string | undefined;
	readonly javascriptAssetName: string;
	readonly model: OAuthApprovalPageModel;
	readonly stylesheetAssetName: string;
}

export interface OAuthApprovalAssetBundle {
	readonly files: Readonly<Record<string, Uint8Array>>;
	readonly manifest: OAuthApprovalAssetManifest;
}

export async function loadOAuthApprovalAssetBundle(): Promise<OAuthApprovalAssetBundle> {
	const assetsDirectoryUrl = new URL('./assets/', import.meta.url);
	const parsedManifest: unknown = JSON.parse(
		await readFile(new URL('manifest.json', assetsDirectoryUrl), 'utf8'),
	);
	const manifest = oauthApprovalAssetManifestSchema.parse(parsedManifest);
	const [css, javascript, onboarding] = await Promise.all([
		readFile(new URL(manifest.css, assetsDirectoryUrl)),
		readFile(new URL(manifest.javascript, assetsDirectoryUrl)),
		readFile(new URL(manifest.onboarding, assetsDirectoryUrl)),
	]);
	return {
		files: {
			[manifest.css]: new Uint8Array(css),
			[manifest.javascript]: new Uint8Array(javascript),
			[manifest.onboarding]: new Uint8Array(onboarding),
		},
		manifest,
	};
}

function pageTitle(model: OAuthApprovalPageModel): string {
	switch (model.kind) {
		case 'permission-selection':
			return 'Choose Google access';
		case 'account-confirmation':
			return 'Confirm Google account';
		case 'disconnect-confirmation':
			return 'Disconnect account authorization';
		case 'disconnected':
			return 'Account authorization disconnected';
		case 'pending':
			return 'Change saved; access is paused';
		case 'application-progress':
			return 'Connecting Google applications';
		case 'partial-completion':
			return 'Some applications need attention';
		case 'completed':
			return 'Google account connected';
		case 'expired':
			return 'Authorization expired';
		case 'cancelled':
			return 'Authorization cancelled';
		case 'failed':
			return 'Authorization failed';
	}
}

function PermissionChoice(props: {
	readonly application: OAuthApplicationChoiceModel;
	readonly errors: readonly OAuthPermissionFieldError[];
}): JSX.Element {
	const application = props.application;
	const recommended = new Set(application.recommendedGroupIds);
	const selectionMode = resolvePermissionSelectionMode(application);
	// An untouched Off application offers the safe Custom baseline even without
	// JavaScript. An explicit submitted mode preserves its edits, including empty.
	const selected = new Set(
		application.selectionMode === undefined && selectionMode === 'off'
			? application.recommendedGroupIds
			: application.selectedGroupIds,
	);
	const serviceIds = [...new Set(application.groups.map((group) => group.serviceId))];
	return (
		<section
			class="application-section"
			data-permission-application
			aria-labelledby={`application-${application.applicationId}`}
		>
			<div class="application-heading">
				<h2 id={`application-${application.applicationId}`}>{application.label}</h2>
				<p>{application.description}</p>
				<fieldset class="permission-fieldset">
					<legend>Access selection</legend>
					{(['off', 'recommended', 'custom'] as const).map((mode) => (
						<label class="permission-option" key={mode}>
							<input
								class="peer"
								type="radio"
								name={`mode.${application.applicationId}`}
								value={mode}
								checked={selectionMode === mode}
								required
							/>
							<span>
								{mode === 'off' ? 'Off' : mode === 'recommended' ? 'Recommended' : 'Custom'}
							</span>
						</label>
					))}
				</fieldset>
				<p>
					Recommended:{' '}
					{application.groups
						.filter((group) => recommended.has(group.groupId))
						.map((group) => group.label)
						.join(', ') || 'No access'}
					.
				</p>
				<p>Custom starts with the selections below. Choose Custom to use your edits.</p>
				{application.suggestedGroupIds === undefined ? null : (
					<p class="suggestion-note">
						Agent suggestions are advisory. You decide. Suggested:{' '}
						{application.groups
							.filter((group) => application.suggestedGroupIds?.includes(group.groupId))
							.map((group) => group.label)
							.join(', ') || 'No offered groups'}
						.
					</p>
				)}
			</div>
			{serviceIds.map((serviceId) => {
				const fieldError = props.errors.find(
					(error) =>
						error.applicationId === application.applicationId && error.serviceId === serviceId,
				);
				const fieldErrorId = `permission-error-${application.applicationId}-${serviceId}`;
				return (
					<fieldset
						key={serviceId}
						class="permission-fieldset"
						aria-describedby={fieldError === undefined ? undefined : fieldErrorId}
					>
						<legend>{serviceId}</legend>
						{application.groups
							.filter((group) => group.serviceId === serviceId)
							.map((group) => (
								<label class="permission-option" key={group.groupId}>
									<input
										class="peer"
										type="checkbox"
										name={`groups.${application.applicationId}`}
										value={group.groupId}
										data-recommended={recommended.has(group.groupId) ? 'true' : 'false'}
										checked={selected.has(group.groupId)}
										disabled={!group.offered}
									/>
									<span>
										{group.label}
										{group.offered ? '' : ' — Blocked by current limit'}
									</span>
									<small>{group.warning}</small>
								</label>
							))}
						{fieldError === undefined ? null : (
							<p class="field-error" id={fieldErrorId}>
								{fieldError.message}
							</p>
						)}
					</fieldset>
				);
			})}
		</section>
	);
}

function PermissionSelectionPage(props: {
	readonly cancelAction?: string | undefined;
	readonly csrfToken: string;
	readonly formAction: string;
	readonly model: Extract<OAuthApprovalPageModel, { readonly kind: 'permission-selection' }>;
}): JSX.Element {
	return (
		<>
			<header class="page-header">
				<p class="eyebrow">Google authorization</p>
				<h1>Choose Google access for {props.model.agentId}</h1>
				<p>
					Account owner: {props.model.ownerLabel}
					{props.model.accountAlias === undefined ? '' : ` · ${props.model.accountAlias}`}
				</p>
				<p>
					These choices control Google consent. They do not change your per-call Deny, Ask or Allow
					policy.
				</p>
			</header>
			{props.model.errors === undefined || props.model.errors.length === 0 ? null : (
				<div
					autofocus
					class="error-summary"
					id="permission-error-summary"
					role="alert"
					tabindex={-1}
				>
					<h2>Review these problems</h2>
					<ul>
						{props.model.errors.map((error) => (
							<li key={`${error.applicationId}:${error.serviceId}`}>
								<a href={`#permission-error-${error.applicationId}-${error.serviceId}`}>
									{error.message}
								</a>
							</li>
						))}
					</ul>
				</div>
			)}
			<form action={props.formAction} data-permission-selector method="post">
				{props.model.applications.map((application) => (
					<PermissionChoice
						application={application}
						errors={props.model.errors ?? []}
						key={application.applicationId}
					/>
				))}
				<input name="csrfToken" type="hidden" value={props.csrfToken} />
				<div aria-live="polite" class="permission-summary" data-permission-summary>
					{permissionSelectionSummary(
						props.model.applications.map((application) => {
							const mode = resolvePermissionSelectionMode(application);
							return mode === 'off'
								? 0
								: mode === 'recommended'
									? application.recommendedGroupIds.length
									: application.groups.filter(
											(group) =>
												group.offered && application.selectedGroupIds.includes(group.groupId),
										).length;
						}),
					)}
				</div>
				<div class="form-actions">
					<button class="primary-button" type="submit">
						Continue to Google
					</button>
					{props.cancelAction === undefined ? null : (
						<button
							class="secondary-button"
							formAction={props.cancelAction}
							formMethod="post"
							type="submit"
						>
							Cancel
						</button>
					)}
				</div>
			</form>
		</>
	);
}

function AccountConfirmationPage(props: {
	readonly cancelAction?: string | undefined;
	readonly csrfToken: string;
	readonly formAction: string;
	readonly model: Extract<OAuthApprovalPageModel, { readonly kind: 'account-confirmation' }>;
}): JSX.Element {
	const previousPermissionLabels = props.model.previousPermissionLabels;
	const previousPermissions = new Set(previousPermissionLabels ?? []);
	const grantedPermissions = new Set(props.model.grantedPermissionLabels);
	const addedPermissions = props.model.grantedPermissionLabels.filter(
		(label) => !previousPermissions.has(label),
	);
	const removedPermissions = (previousPermissionLabels ?? []).filter(
		(label) => !grantedPermissions.has(label),
	);
	return (
		<>
			<header class="page-header">
				<p class="eyebrow">Confirm account</p>
				<h1>{props.model.accountLabel}</h1>
				<p>Google returned this account for {props.model.applicationLabel}.</p>
			</header>
			{previousPermissionLabels === undefined ? (
				<section class="confirmation-panel">
					<h2>Granted access</h2>
					<ul>
						{props.model.grantedPermissionLabels.map((label, labelIndex) => (
							<li key={`${String(labelIndex)}:${label}`}>{label}</li>
						))}
					</ul>
				</section>
			) : (
				<section class="confirmation-panel">
					<h2>Permission changes</h2>
					<h3>Before</h3>
					<ul>
						{previousPermissionLabels.length === 0 ? (
							<li>No access</li>
						) : (
							previousPermissionLabels.map((label, labelIndex) => (
								<li key={`before:${String(labelIndex)}:${label}`}>{label}</li>
							))
						)}
					</ul>
					<h3>After</h3>
					<ul>
						{props.model.grantedPermissionLabels.length === 0 ? (
							<li>No access</li>
						) : (
							props.model.grantedPermissionLabels.map((label, labelIndex) => (
								<li key={`after:${String(labelIndex)}:${label}`}>{label}</li>
							))
						)}
					</ul>
					<h3>Added</h3>
					<p>{addedPermissions.join(', ') || 'None'}</p>
					<h3>Removed</h3>
					<p>{removedPermissions.join(', ') || 'None'}</p>
				</section>
			)}
			<form action={props.formAction} method="post">
				<input name="csrfToken" type="hidden" value={props.csrfToken} />
				<div class="account-alias-field">
					<label for="accountAlias">Name this account for the agent</label>
					<input
						id="accountAlias"
						name="accountAlias"
						type="text"
						required
						maxlength={320}
						value={props.model.accountLabel}
					/>
				</div>
				<div class="form-actions">
					<button class="primary-button" type="submit">
						Confirm this account
					</button>
					{props.cancelAction === undefined ? null : (
						<button
							class="secondary-button"
							formAction={props.cancelAction}
							formMethod="post"
							type="submit"
						>
							Cancel
						</button>
					)}
				</div>
			</form>
		</>
	);
}

function StatusPage(props: {
	readonly cancelAction?: string | undefined;
	readonly continueUrl?: string | undefined;
	readonly csrfToken?: string | undefined;
	readonly formAction?: string | undefined;
	readonly model: Exclude<
		OAuthApprovalPageModel,
		{ kind: 'permission-selection' | 'account-confirmation' | 'disconnect-confirmation' }
	>;
}): JSX.Element {
	const model = props.model;
	if (model.kind === 'application-progress') {
		return (
			<>
				<header class="page-header">
					<p class="eyebrow">Application progress</p>
					<h1>Connecting Google applications</h1>
				</header>
				<ol class="progress-list">
					{model.applications.map((application) => (
						<li key={application.applicationId}>
							<span>{application.label}</span>
							<strong>{application.status}</strong>
						</li>
					))}
				</ol>
				<a class="primary-button" href={props.continueUrl}>
					Continue to Google
				</a>
				{props.cancelAction === undefined || props.csrfToken === undefined ? null : (
					<form action={props.cancelAction} method="post">
						<input name="csrfToken" type="hidden" value={props.csrfToken} />
						<button class="secondary-button" type="submit">
							Cancel remaining applications
						</button>
					</form>
				)}
			</>
		);
	}
	if (model.kind === 'partial-completion') {
		return (
			<>
				<header class="page-header">
					<p class="eyebrow">Partial completion</p>
					<h1>Some applications need attention</h1>
				</header>
				<section class="confirmation-panel">
					<h2>Connected</h2>
					<ul>
						{model.completed.map((label, labelIndex) => (
							<li key={`${String(labelIndex)}:${label}`}>{label}</li>
						))}
					</ul>
				</section>
				<form action={props.formAction} method="post">
					<input name="csrfToken" type="hidden" value={props.csrfToken} />
					<button class="primary-button" type="submit">
						Retry Google authorization
					</button>
					{props.cancelAction === undefined ? null : (
						<button
							class="secondary-button"
							formAction={props.cancelAction}
							formMethod="post"
							type="submit"
						>
							Cancel remaining applications
						</button>
					)}
				</form>
				<section class="confirmation-panel">
					<h2>Retryable</h2>
					<ul>
						{model.retryable.map((label, labelIndex) => (
							<li key={`${String(labelIndex)}:${label}`}>{label}</li>
						))}
					</ul>
				</section>
			</>
		);
	}
	if (model.kind === 'completed') {
		return (
			<header class="page-header">
				<p class="eyebrow">Complete</p>
				<h1>{model.accountLabel} is connected</h1>
				<p>You can return to Hermes.</p>
			</header>
		);
	}
	return (
		<header class="page-header">
			<p class="eyebrow">{model.kind}</p>
			<h1>{pageTitle(model)}</h1>
			<p role="alert">{model.message}</p>
		</header>
	);
}

export function renderOAuthApprovalPage(unparsedProps: OAuthApprovalRenderProps): string {
	const model = oauthApprovalPageModelSchema.parse(unparsedProps.model);
	const renderProps = renderPropsSchema.parse({
		assetBasePath: unparsedProps.assetBasePath,
		...(unparsedProps.cancelAction === undefined
			? {}
			: { cancelAction: unparsedProps.cancelAction }),
		...(unparsedProps.continueUrl === undefined ? {} : { continueUrl: unparsedProps.continueUrl }),
		...(unparsedProps.csrfToken === undefined ? {} : { csrfToken: unparsedProps.csrfToken }),
		...(unparsedProps.formAction === undefined ? {} : { formAction: unparsedProps.formAction }),
		javascriptAssetName: unparsedProps.javascriptAssetName,
		stylesheetAssetName: unparsedProps.stylesheetAssetName,
	});
	const body = (() => {
		if (model.kind === 'disconnect-confirmation') {
			if (renderProps.csrfToken === undefined || renderProps.formAction === undefined)
				throw new Error('Disconnect confirmation requires a CSRF token and form action.');
			return (
				<>
					<header class="page-header">
						<h1>
							Disconnect {model.accountAlias} from {model.agentId}?
						</h1>
						<p>
							{model.applicationLabel}: this stops local access for this agent. Other agents stay
							connected. Google consent is not revoked.
						</p>
					</header>
					<form action={renderProps.formAction} method="post">
						<input name="csrfToken" type="hidden" value={renderProps.csrfToken} />
						<button class="primary-button" type="submit">
							Disconnect this authorization
						</button>
						{renderProps.cancelAction === undefined ? null : (
							<button
								class="secondary-button"
								formAction={renderProps.cancelAction}
								formMethod="post"
								type="submit"
							>
								Cancel
							</button>
						)}
					</form>
				</>
			);
		}
		if (model.kind === 'permission-selection') {
			if (renderProps.csrfToken === undefined || renderProps.formAction === undefined) {
				throw new Error('Permission selection requires a CSRF token and form action.');
			}
			return (
				<PermissionSelectionPage
					cancelAction={renderProps.cancelAction}
					csrfToken={renderProps.csrfToken}
					formAction={renderProps.formAction}
					model={model}
				/>
			);
		}
		if (model.kind === 'account-confirmation') {
			if (renderProps.csrfToken === undefined || renderProps.formAction === undefined) {
				throw new Error('Account confirmation requires a CSRF token and form action.');
			}
			return (
				<AccountConfirmationPage
					cancelAction={renderProps.cancelAction}
					csrfToken={renderProps.csrfToken}
					formAction={renderProps.formAction}
					model={model}
				/>
			);
		}
		if (model.kind === 'application-progress' && renderProps.continueUrl === undefined) {
			throw new Error('application-progress requires a continuation URL.');
		}
		if (
			model.kind === 'partial-completion' &&
			(renderProps.csrfToken === undefined || renderProps.formAction === undefined)
		) {
			throw new Error('partial-completion requires a CSRF token and retry action.');
		}
		return (
			<StatusPage
				cancelAction={renderProps.cancelAction}
				continueUrl={renderProps.continueUrl}
				csrfToken={renderProps.csrfToken}
				formAction={renderProps.formAction}
				model={model}
			/>
		);
	})();
	const assetBasePath = renderProps.assetBasePath.replace(/\/$/u, '');
	return (
		'<!doctype html>' +
		renderToString(
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta content="width=device-width, initial-scale=1" name="viewport" />
					<title>{pageTitle(model)}</title>
					<link href={`${assetBasePath}/${renderProps.stylesheetAssetName}`} rel="stylesheet" />
					<script defer src={`${assetBasePath}/${renderProps.javascriptAssetName}`} type="module" />
				</head>
				<body>
					<main class="page-shell">{body}</main>
				</body>
			</html>,
		)
	);
}
