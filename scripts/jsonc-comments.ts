export function stripJsonComments(jsoncText: string): string {
	let strippedText = '';
	let inString = false;
	let escaped = false;
	let inLineComment = false;
	let inBlockComment = false;

	for (let index = 0; index < jsoncText.length; index += 1) {
		const character = jsoncText[index];
		const nextCharacter = jsoncText[index + 1];

		if (inLineComment) {
			if (character === '\n' || character === '\r') {
				inLineComment = false;
				strippedText += character;
			}
			continue;
		}

		if (inBlockComment) {
			if (character === '*' && nextCharacter === '/') {
				inBlockComment = false;
				index += 1;
				continue;
			}
			if (character === '\n' || character === '\r') {
				strippedText += character;
			}
			continue;
		}

		if (inString) {
			strippedText += character;
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === '\\') {
				escaped = true;
				continue;
			}
			if (character === '"') {
				inString = false;
			}
			continue;
		}

		if (character === '"') {
			inString = true;
			strippedText += character;
			continue;
		}

		if (character === '/' && nextCharacter === '/') {
			inLineComment = true;
			index += 1;
			continue;
		}

		if (character === '/' && nextCharacter === '*') {
			inBlockComment = true;
			index += 1;
			continue;
		}

		strippedText += character;
	}

	return strippedText;
}
