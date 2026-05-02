import fs from 'node:fs/promises';

import { parse, type ParseError, type ParseOptions, printParseErrorCode } from 'jsonc-parser';

const parseJsoncToUnknown: (text: string, errors: ParseError[], options: ParseOptions) => unknown =
	parse;

function formatLineColumn(text: string, offset: number): string {
	const prefix = text.slice(0, offset);
	const line = prefix.split('\n').length;
	const lastLineBreakIndex = prefix.lastIndexOf('\n');
	const column = offset - lastLineBreakIndex;
	return `line ${line}, column ${column}`;
}

function formatParseError(filePath: string, text: string, error: ParseError): string {
	return [
		`Invalid JSONC in ${filePath}: ${formatLineColumn(text, error.offset)}:`,
		printParseErrorCode(error.error),
	].join(' ');
}

export async function loadJsonConfigFile(filePath: string): Promise<unknown> {
	const rawConfig = await fs.readFile(filePath, 'utf8');
	const parseErrors: ParseError[] = [];
	const parsedConfig = parseJsoncToUnknown(rawConfig, parseErrors, {
		allowTrailingComma: true,
		disallowComments: false,
	});

	if (parseErrors.length > 0) {
		const firstParseError = parseErrors[0];
		if (firstParseError) {
			throw new Error(formatParseError(filePath, rawConfig, firstParseError));
		}
	}

	return parsedConfig;
}
