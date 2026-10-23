import type { SignInConfiguration } from '#auth/sign-in-core/models/deployment-configuration';

/** Only fixed management authorization may resume after the owner's provider sign-in. */
export function ownerAuthorizationResume(
	value: string | null,
	configuration: SignInConfiguration,
): string | null {
	if (value === null) return null;
	const authorization = new URL(value);
	const callback = new URL(authorization.searchParams.get('redirect_uri') ?? 'invalid:');
	const configuredCallback = new URL(configuration.ownerCliRedirectUri);
	if (
		authorization.origin !== new URL(configuration.issuer).origin ||
		authorization.pathname !== '/api/auth/oauth2/authorize' ||
		authorization.username !== '' ||
		authorization.password !== '' ||
		authorization.searchParams.get('client_id') !== configuration.ownerCliClientId ||
		authorization.searchParams.get('response_type') !== 'code' ||
		authorization.searchParams.get('scope') !== 'tool-portal:management' ||
		authorization.searchParams.get('resource') !== configuration.managementAudience ||
		authorization.searchParams.getAll('resource').length !== 1 ||
		authorization.searchParams.get('code_challenge_method') !== 'S256' ||
		!authorization.searchParams.has('code_challenge') ||
		callback.protocol !== 'http:' ||
		!['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) ||
		callback.hostname !== configuredCallback.hostname ||
		callback.pathname !== configuredCallback.pathname ||
		callback.search !== configuredCallback.search ||
		callback.username !== '' ||
		callback.password !== '' ||
		callback.hash !== ''
	)
		throw new Error('Invalid owner CLI authorization resume');
	return authorization.toString();
}

function scriptValue(value: string | null): string {
	return JSON.stringify(value).replaceAll('<', '\\u003c');
}

/** Minimal provider choice and one bootstrap action; the broader account/admin UI is outside S1. */
export function minimalOwnerPage(props: {
	readonly ready: boolean;
	readonly configuration: SignInConfiguration;
	readonly resume: string | null;
}): Response {
	const callback = new URL('/owner-ready', props.configuration.issuer);
	if (props.resume !== null) callback.searchParams.set('authorize', props.resume);
	const controls = props.ready
		? '<button type="submit">Continue to management CLI</button>'
		: '<button type="submit" value="google">Sign in with Google</button> <button type="submit" value="github">Sign in with GitHub</button>';
	const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Owner sign-in</title><main><h1>Owner sign-in</h1><p>${props.ready ? 'Continue with your current owner session.' : 'Use the provider account configured as this deployment’s owner.'}</p><form>${controls}</form><p role="status" id="status"></p></main><script>
const form=document.querySelector('form');const status=document.getElementById('status');
form.addEventListener('submit',async(event)=>{event.preventDefault();try{
const ready=${JSON.stringify(props.ready)};const body=ready?{}:{provider:event.submitter.value,callbackURL:${scriptValue(callback.toString())}};
const response=await fetch(ready?'/api/auth/owner/bootstrap':'/api/auth/sign-in/social',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const result=await response.json();if(!response.ok)throw new Error('Owner sign-in was refused');
if(!ready){if(typeof result.url!=='string')throw new Error('Provider sign-in unavailable');location.assign(result.url);}
else if(result.kind==='complete'){const resume=${scriptValue(props.resume)};if(resume)location.assign(resume);else status.textContent='Owner CLI initialized.';}
else throw new Error('Owner bootstrap is incomplete');
}catch(error){status.textContent=error.message;}});
</script></html>`;
	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
		},
	});
}
