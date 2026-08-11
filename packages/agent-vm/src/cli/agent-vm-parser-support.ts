import { map, multiple, optional, withDefault, type Parser } from '@optique/core';
import { ZodDefault, ZodOptional, type z } from 'zod';

interface ProjectZodScalarPresenceProps<TSchema extends z.ZodType, TParserState> {
	readonly parser: Parser<'sync', z.infer<TSchema>, TParserState>;
	readonly schema: TSchema;
}

function assertSchemaDoesNotMixAbsenceWrappers(schema: z.ZodType): void {
	if (schema instanceof ZodOptional && schema.unwrap() instanceof ZodDefault) {
		throw new TypeError('CLI value schemas must not mix ZodOptional and ZodDefault.');
	}
	if (schema instanceof ZodDefault && schema.unwrap() instanceof ZodOptional) {
		throw new TypeError('CLI value schemas must not mix ZodOptional and ZodDefault.');
	}
}

export function projectZodScalarPresence<TSchema extends z.ZodType, TParserState>(
	props: ProjectZodScalarPresenceProps<TSchema, TParserState>,
): Parser<'sync', z.infer<TSchema>>;
export function projectZodScalarPresence(
	props: ProjectZodScalarPresenceProps<z.ZodType, unknown>,
): Parser {
	assertSchemaDoesNotMixAbsenceWrappers(props.schema);
	if (props.schema instanceof ZodOptional) {
		return optional(props.parser);
	}
	if (props.schema instanceof ZodDefault) {
		return withDefault(props.parser, props.schema.parse(undefined));
	}
	return props.parser;
}

interface ProjectZodRepeatedOptionProps<
	TElementSchema extends z.ZodType,
	TArraySchema extends z.ZodDefault<z.ZodArray<TElementSchema>>,
	TParserState,
> {
	readonly parser: Parser<'sync', z.infer<TElementSchema>, TParserState>;
	readonly schema: TArraySchema;
}

export function projectZodRepeatedOption<
	TElementSchema extends z.ZodType,
	TArraySchema extends z.ZodDefault<z.ZodArray<TElementSchema>>,
	TParserState,
>(
	props: ProjectZodRepeatedOptionProps<TElementSchema, TArraySchema, TParserState>,
): Parser<'sync', z.infer<TArraySchema>>;
export function projectZodRepeatedOption(
	props: ProjectZodRepeatedOptionProps<z.ZodType, z.ZodDefault<z.ZodArray<z.ZodType>>, unknown>,
): Parser {
	const collectedValuesParser = optional(multiple(props.parser, { min: 1 }));
	return map(collectedValuesParser, (values) => props.schema.parse(values));
}
