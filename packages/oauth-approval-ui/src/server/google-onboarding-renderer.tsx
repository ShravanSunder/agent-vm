import { renderToString } from 'hono/jsx/dom/server';
import { z } from 'zod';

const propsSchema = z.object({
	mode: z.enum(['sign-in', 'invitation', 'setup', 'callback']),
	publishableKey: z
		.string()
		.max(2048)
		.regex(/^pk_(test|live)_[A-Za-z0-9+/=_-]+$/u),
	stylesheet: z.string().regex(/^oauth\.[a-f0-9]{16}\.css$/u),
	javascript: z.string().regex(/^onboarding\.[a-f0-9]{16}\.js$/u),
	issue: z.literal('incomplete').optional(),
});
export type GoogleOnboardingPageProps = z.infer<typeof propsSchema>;

export function renderGoogleOnboardingPage(input: GoogleOnboardingPageProps): string {
	const props = propsSchema.parse(input);
	const heading =
		props.mode === 'setup'
			? 'Finish setting up your account'
			: props.mode === 'callback'
				? 'Finishing sign-in'
				: 'Welcome to your agents';
	return (
		'<!doctype html>' +
		renderToString(
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>{heading}</title>
					<link rel="stylesheet" href={`/oauth/assets/${props.stylesheet}`} />
					<script type="module" src={`/oauth/assets/${props.javascript}`} />
				</head>
				<body>
					<main
						class="page-shell onboarding-shell"
						data-google-onboarding
						data-mode={props.mode}
						data-issue={props.issue}
						data-publishable-key={props.publishableKey}
					>
						<header class="page-header">
							<p class="eyebrow">Your agents · Your choice</p>
							<h1>{heading}</h1>
							<p>Sign in to choose what your agents can access.</p>
						</header>
						<section class="onboarding-action" aria-label="Google sign-in">
							{props.mode === 'callback' ? null : (
								<>
									<button type="button" class="google-button" data-google-continue disabled>
										<span aria-hidden="true" class="google-mark">
											G
										</span>
										{props.mode === 'setup'
											? 'Connect Google to finish setup'
											: 'Continue with Google'}
									</button>
									<p class="onboarding-hint">Use the Google email that received your invitation.</p>
								</>
							)}
							<p role="status" aria-live="polite" data-login-status>
								{props.issue === 'incomplete'
									? 'Sign-in needs additional verification. Ask your household administrator to check the login settings; no agent access has been granted.'
									: 'Loading secure sign-in…'}
							</p>
							<noscript>
								<p>
									JavaScript is needed to sign in with Google. Enable it and reload this page. After
									sign-in, permission forms work without JavaScript.
								</p>
							</noscript>
						</section>
						<footer class="onboarding-footer">
							<p>
								Signing in does not give agents access to your Gmail or Drive. You choose that
								separately.
							</p>
							<p>Invitation only.</p>
							<a href="/oauth/auth/start">Start again</a>
						</footer>
					</main>
				</body>
			</html>,
		)
	);
}
