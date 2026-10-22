import { z } from 'zod';

export function advertisedVersions(response: string): readonly string[] {
	const payloads = response.trim().startsWith('{')
		? [response]
		: response
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trim());
	const schema = z
		.object({
			result: z
				.object({ supportedVersions: z.array(z.string()).optional() })
				.passthrough()
				.optional(),
			error: z
				.object({
					message: z.string(),
					data: z
						.object({ supported: z.array(z.string()).optional() })
						.passthrough()
						.optional(),
				})
				.passthrough()
				.optional(),
		})
		.passthrough();
	for (const payload of payloads) {
		let value: unknown;
		try {
			value = JSON.parse(payload);
		} catch {
			continue;
		}
		const parsed = schema.safeParse(value);
		if (!parsed.success) continue;
		const supported = parsed.data.result?.supportedVersions ?? parsed.data.error?.data?.supported;
		if (supported !== undefined) return supported;
		const clause = parsed.data.error?.message.match(
			/\bsupported(?: protocol)? versions?\s*:\s*([^\n]+)/iu,
		)?.[1];
		if (clause !== undefined) return clause.match(/202\d-\d{2}-\d{2}/gu) ?? [];
	}
	return [];
}
