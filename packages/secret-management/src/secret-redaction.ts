const quotedOnePasswordReferencePattern = /(["'`])(?:(?!\1)[\s\S])*?op:\/\/(?:(?!\1)[\s\S])*?\1/giu;
const unquotedOnePasswordReferencePattern = /op:\/\/[^\r\n]*/giu;

export function redactOnePasswordReferences(text: string): string {
	return text
		.replaceAll(quotedOnePasswordReferencePattern, (quotedReference) => {
			const quote = quotedReference.slice(0, 1);
			return `${quote}<1password-ref>${quote}`;
		})
		.replaceAll(unquotedOnePasswordReferencePattern, '<1password-ref>');
}
