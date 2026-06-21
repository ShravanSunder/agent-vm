import { z } from 'zod';

export type JsonPrimitive = boolean | null | number | string;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export const JsonStringMaxLength = 64 * 1024;
export const JsonArrayMaxItems = 1_000;
export const JsonObjectMaxEntries = 1_000;
export const JsonObjectKeyMaxLength = 256;

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		z.string().max(JsonStringMaxLength),
		z.number().finite(),
		z.boolean(),
		z.null(),
		z.array(JsonValueSchema).max(JsonArrayMaxItems),
		JsonObjectSchema,
	]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z
	.record(z.string().min(1).max(JsonObjectKeyMaxLength), JsonValueSchema)
	.refine((value) => Object.keys(value).length <= JsonObjectMaxEntries, {
		message: 'JSON object exceeds the maximum number of entries.',
	});
