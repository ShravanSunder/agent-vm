import { z } from 'zod';

export const ToolPortalAbortSignalSchema = z.custom<AbortSignal>(
	(value) =>
		typeof value === 'object' &&
		value !== null &&
		'aborted' in value &&
		typeof value.aborted === 'boolean' &&
		'addEventListener' in value &&
		typeof value.addEventListener === 'function',
);
