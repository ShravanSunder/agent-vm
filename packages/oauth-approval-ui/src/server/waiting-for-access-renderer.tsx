import { renderToString } from 'hono/jsx/dom/server';
import { z } from 'zod';

const waitingForAccessPropsSchema = z.object({
	emailAddress: z.string().email(),
	stylesheet: z.string().regex(/^oauth\.[a-f0-9]{16}\.css$/u),
});

export function renderWaitingForAccessPage(
	input: z.infer<typeof waitingForAccessPropsSchema>,
): string {
	const props = waitingForAccessPropsSchema.parse(input);
	return (
		'<!doctype html>' +
		renderToString(
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>Waiting for access</title>
					<link rel="stylesheet" href={`/oauth/assets/${props.stylesheet}`} />
				</head>
				<body>
					<main class="page-shell onboarding-shell">
						<header class="page-header">
							<p class="eyebrow">Signed in as {props.emailAddress}</p>
							<h1>Waiting for access</h1>
							<p>
								You’re signed in. Your household administrator still needs to set up your access.
							</p>
						</header>
						<section class="onboarding-action" aria-label="Access status">
							<p>
								No agents or accounts are available to you yet. Contact the person who invited you.
							</p>
							<a class="google-button" href="/oauth/auth/start">
								Check access again
							</a>
						</section>
						<footer class="onboarding-footer">
							<p>
								Signing in does not give agents access to your Gmail or Drive. You choose that
								separately.
							</p>
						</footer>
					</main>
				</body>
			</html>,
		)
	);
}
