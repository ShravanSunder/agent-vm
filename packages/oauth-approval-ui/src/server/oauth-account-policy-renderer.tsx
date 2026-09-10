import {
	googleAccountPolicySnapshotSchema,
	googleServicePolicyDefaultsSchema,
	googleServiceEffectsSchema,
	type GooglePolicyOverrideCell,
	oauthAccountActivityAvailabilitySchema,
} from '@agent-vm/oauth-broker-contracts';
import { renderToString } from 'hono/jsx/dom/server';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { z } from 'zod';

const labelSchema = z.string().min(1).max(320);
const localPathSchema = z
	.string()
	.regex(/^\/oauth\/[A-Za-z0-9/_?=.%:-]+$/u)
	.max(2048);
const csrfSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const oauthAccountPolicyPageSchema = z
	.object({
		agentId: labelSchema,
		accountAlias: labelSchema,
		applicationLabel: labelSchema,
		ownerLabel: labelSchema,
		activities: z
			.array(
				z
					.object({
						operationId: z.string().min(1).max(128),
						availability: oauthAccountActivityAvailabilitySchema,
					})
					.strict(),
			)
			.max(512)
			.readonly(),
		services: googleAccountPolicySnapshotSchema.shape.services,
		after: googleAccountPolicySnapshotSchema.shape.services.optional(),
		defaults: googleServicePolicyDefaultsSchema,
		maximums: googleServiceEffectsSchema,
		state: z.enum(['active', 'applying']),
		canEdit: z.boolean(),
		configRevision: z.string().min(1).max(256),
		overrideRevision: z.number().int().positive(),
		formAction: localPathSchema.optional(),
		csrfToken: csrfSchema.optional(),
		history: z
			.array(
				z
					.object({
						kind: labelSchema,
						timestampMs: z.number().int().nonnegative(),
						oldRevision: z.number().int().positive(),
						newRevision: z.number().int().positive(),
					})
					.strict(),
			)
			.max(100)
			.readonly(),
		connectionActions: z
			.array(z.object({ label: labelSchema, action: localPathSchema }).strict())
			.max(3)
			.readonly(),
		navigationCsrf: csrfSchema,
	})
	.strict();
export type OAuthAccountPolicyPage = z.infer<typeof oauthAccountPolicyPageSchema>;
const stylesheetSchema = z.string().regex(/^oauth\.[a-f0-9]{16}\.css$/u);

function document(props: {
	readonly title: string;
	readonly stylesheet: string;
	readonly content: JSX.Element;
}): string {
	const stylesheet = stylesheetSchema.parse(props.stylesheet);
	return (
		'<!doctype html>' +
		renderToString(
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>{props.title}</title>
					<link rel="stylesheet" href={`/oauth/assets/${stylesheet}`} />
				</head>
				<body>
					<main class="page-shell">{props.content}</main>
				</body>
			</html>,
		)
	);
}
function choiceLabel(cell: GooglePolicyOverrideCell, fallback: string): string {
	return cell.kind === 'inherit'
		? `Using default: ${fallback}`
		: `Your override: ${cell.disposition}`;
}
export function renderOAuthAccountPolicyPage(props: {
	readonly model: OAuthAccountPolicyPage;
	readonly stylesheet: string;
}): string {
	const model = oauthAccountPolicyPageSchema.parse(props.model);
	const isPreview = model.after !== undefined;
	const editable = model.canEdit && model.state === 'active' && !isPreview;
	const form = (
		<form action={model.formAction} method="post">
			{model.csrfToken === undefined ? null : (
				<input type="hidden" name="csrfToken" value={model.csrfToken} />
			)}
			{isPreview ? null : (
				<>
					<input type="hidden" name="expectedConfigRevision" value={model.configRevision} />
					<input type="hidden" name="expectedOverrideRevision" value={model.overrideRevision} />
				</>
			)}
			{Object.entries(model.services).map(([serviceId, cells]) => (
				<fieldset class="permission-fieldset" key={serviceId}>
					<legend>{serviceId}</legend>
					{(['read', 'write'] as const).map((effect) => {
						const cell = cells[effect];
						const fallback =
							Object.entries(model.defaults).find(([id]) => id === serviceId)?.[1][effect] ??
							'deny';
						const maximumAllows =
							Object.entries(model.maximums)
								.find(([id]) => id === serviceId)?.[1]
								.includes(effect) ?? false;
						const effective =
							model.state !== 'active' || !maximumAllows
								? 'deny'
								: cell.kind === 'explicit'
									? cell.disposition
									: fallback;
						const selected = cell.kind === 'inherit' ? 'inherit' : cell.disposition;
						const proposedSelection = !maximumAllows && selected !== 'inherit' ? 'deny' : selected;
						const nextCell = Object.entries(model.after ?? {}).find(
							([id]) => id === serviceId,
						)?.[1][effect];
						return (
							<div class="confirmation-panel" key={effect}>
								<h3>{effect === 'read' ? 'Read' : 'Write'}</h3>
								<p>
									{choiceLabel(cell, fallback)} · Effective: {effective}
								</p>
								{!maximumAllows ? (
									<p>
										Blocked by current limit. Saved choices remain retained until you confirm a
										change.
									</p>
								) : null}
								{cell.kind === 'inherit' ? (
									<p>Operator changes to this default take effect automatically.</p>
								) : null}
								{nextCell === undefined ? null : (
									<p>After confirmation: {choiceLabel(nextCell, fallback)}</p>
								)}
								{editable ? (
									<select aria-label={`${serviceId} ${effect}`} name={`${effect}.${serviceId}`}>
										<option value="inherit" selected={proposedSelection === 'inherit'}>
											Use default ({fallback})
										</option>
										<option value="deny" selected={proposedSelection === 'deny'}>
											Deny
										</option>
										<option
											value="ask"
											selected={proposedSelection === 'ask'}
											disabled={!maximumAllows}
										>
											Ask every time
										</option>
										<option
											value="allow"
											selected={proposedSelection === 'allow'}
											disabled={!maximumAllows}
										>
											Allow without asking
										</option>
									</select>
								) : null}
							</div>
						);
					})}
				</fieldset>
			))}
			{!model.canEdit ||
			model.state !== 'active' ||
			model.formAction === undefined ||
			model.csrfToken === undefined ? null : (
				<button class="primary-button" type="submit">
					{isPreview ? 'Confirm this account policy' : 'Preview changes'}
				</button>
			)}
		</form>
	);
	return document({
		title: isPreview ? 'Confirm account policy' : 'Account policy',
		stylesheet: props.stylesheet,
		content: (
			<>
				<header class="page-header">
					<a href="/oauth/agents">Your agents and accounts</a>
					<h1>
						{model.agentId} · {model.accountAlias}
					</h1>
					<p>
						{model.applicationLabel} · Account owner: {model.ownerLabel}
					</p>
					<p>
						Google consent sets available access. These controls decide whether this agent must ask
						before using it. Setting Allow does not grant Google access.
					</p>
					{model.state === 'applying' ? (
						<p role="status">
							Your change is saved. Access remains paused while old runtime credentials are
							contained.
						</p>
					) : null}
					{!model.canEdit ? (
						<p>
							You can manage your connection, but are not configured to edit this agent’s account
							policy.
						</p>
					) : null}
				</header>
				{form}
				<details class="confirmation-panel">
					<summary>Current command availability</summary>
					<ul>
						{model.activities.map((activity) => (
							<li key={activity.operationId}>
								{activity.operationId}: {activity.availability.kind}
								{activity.availability.kind === 'ready'
									? ` (${activity.availability.disposition})`
									: ''}
							</li>
						))}
					</ul>
					<p>These are current decisions, not approval for a future call.</p>
				</details>
				<section class="confirmation-panel">
					<h2>Connection</h2>
					{model.connectionActions.map((action) => (
						<form key={action.action} action={action.action} method="post">
							<input type="hidden" name="csrfToken" value={model.navigationCsrf} />
							<button class="secondary-button" type="submit">
								{action.label}
							</button>
						</form>
					))}
				</section>
				{model.canEdit ? (
					<section class="confirmation-panel">
						<h2>Recent policy history</h2>
						<p>Showing up to 100 recent changes.</p>
						<ol>
							{model.history.map((event, index) => (
								<li key={index}>
									{new Date(event.timestampMs).toISOString()} · {event.kind} · revision{' '}
									{event.oldRevision} → {event.newRevision}
								</li>
							))}
						</ol>
					</section>
				) : null}
			</>
		),
	});
}

const ownerIndexSchema = z
	.object({
		agents: z
			.array(
				z
					.object({
						agentId: labelSchema,
						accounts: z
							.array(z.object({ accountAlias: labelSchema, href: localPathSchema }).strict())
							.readonly(),
						applications: z
							.array(z.object({ applicationId: labelSchema, label: labelSchema }).strict())
							.readonly(),
					})
					.strict(),
			)
			.readonly(),
		csrfToken: csrfSchema,
	})
	.strict();
export function renderOAuthOwnerIndex(props: {
	readonly model: z.infer<typeof ownerIndexSchema>;
	readonly stylesheet: string;
}): string {
	const model = ownerIndexSchema.parse(props.model);
	return document({
		title: 'Your agents and accounts',
		stylesheet: props.stylesheet,
		content: (
			<>
				<header class="page-header">
					<h1>Your agents and accounts</h1>
					<p>Only your accounts are shown. Each agent has its own authorization and policy.</p>
				</header>
				{model.agents.map((agent) => (
					<section class="application-section" key={agent.agentId}>
						<h2>{agent.agentId}</h2>
						<ul>
							{agent.accounts.map((account) => (
								<li key={account.href}>
									<a href={account.href}>{account.accountAlias}</a>
								</li>
							))}
						</ul>
						<form
							action={`/oauth/agents/${encodeURIComponent(agent.agentId)}/connect`}
							method="post"
						>
							<input type="hidden" name="csrfToken" value={model.csrfToken} />
							<label>
								Connect an account for{' '}
								<select name="applicationId">
									{agent.applications.map((application) => (
										<option key={application.applicationId} value={application.applicationId}>
											{application.label}
										</option>
									))}
								</select>
							</label>
							<button class="primary-button" type="submit">
								Connect Google account
							</button>
						</form>
					</section>
				))}
				<form action="/oauth/auth/change-person" method="post">
					<input type="hidden" name="csrfToken" value={model.csrfToken} />
					<button class="secondary-button" type="submit">
						Change signed-in person
					</button>
				</form>
			</>
		),
	});
}
