import type { OpenClawPluginApi as OpenClawSdkPluginApi } from 'openclaw/plugin-sdk';

import type {
	OpenClawBeforeToolCallResult,
	OpenClawPortalPluginApi,
	OpenClawPluginService,
	OpenClawRuntimeLifecycleRegistrar,
	OpenClawRuntimeLifecycleRegistration,
} from './openclaw-plugin-api.js';

type SdkRuntimeLifecycleRegistration = Parameters<
	OpenClawSdkPluginApi['registerRuntimeLifecycle']
>[0];

type SdkServiceRegistration = Parameters<OpenClawSdkPluginApi['registerService']>[0];

type OpenClawPortalLifecycleApiSurface = Pick<
	OpenClawPortalPluginApi,
	'lifecycle' | 'registerRuntimeLifecycle' | 'registerService'
>;

interface RequiredOpenClawPortalTopLevelLifecycleApiSurface {
	readonly registerRuntimeLifecycle: OpenClawRuntimeLifecycleRegistrar;
	readonly registerService: (service: OpenClawPluginService) => void;
}

interface RequiredOpenClawPortalNestedLifecycleApiSurface {
	readonly lifecycle: {
		readonly registerRuntimeLifecycle: OpenClawRuntimeLifecycleRegistrar;
	};
	readonly registerService: (service: OpenClawPluginService) => void;
}

type AssertAssignable<TActual, TExpected> = TActual extends TExpected ? true : never;
type AssertSupportedLifecycleSurface<TActual> =
	TActual extends RequiredOpenClawPortalTopLevelLifecycleApiSurface
		? true
		: TActual extends RequiredOpenClawPortalNestedLifecycleApiSurface
			? true
			: never;

export const openClawRuntimeLifecycleRegistrationMatchesSdk = true satisfies AssertAssignable<
	OpenClawRuntimeLifecycleRegistration,
	SdkRuntimeLifecycleRegistration
>;

export const openClawRuntimeLifecycleRegistrarMatchesSdk = true satisfies AssertAssignable<
	OpenClawSdkPluginApi['registerRuntimeLifecycle'],
	OpenClawRuntimeLifecycleRegistrar
>;

export const openClawPluginServiceMatchesSdk = true satisfies AssertAssignable<
	OpenClawPluginService,
	SdkServiceRegistration
>;

export function openClawBeforeToolCallResultMatchesSdk(
	api: Pick<OpenClawSdkPluginApi, 'on'>,
): void {
	api.on(
		'before_tool_call',
		async (): Promise<OpenClawBeforeToolCallResult> => ({
			params: {},
		}),
	);
}

export const openClawSdkApiProvidesRequiredPortalLifecycleSurface =
	true satisfies AssertSupportedLifecycleSurface<OpenClawSdkPluginApi>;

export const openClawSdkApiProvidesPortalLifecycleSurface = true satisfies AssertAssignable<
	OpenClawSdkPluginApi,
	OpenClawPortalLifecycleApiSurface
>;
