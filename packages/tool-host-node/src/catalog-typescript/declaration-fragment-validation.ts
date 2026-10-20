import ts from 'typescript';

export type DeclarationFragmentValidationResult =
	| { readonly ok: true }
	| { readonly message: string; readonly ok: false };

export function validateDeclarationOnlyTypeFragment(
	declarationSource: string,
): DeclarationFragmentValidationResult {
	const sourceFile = ts.createSourceFile(
		'generated-input.d.ts',
		declarationSource,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);
	if (sourceFile.statements.length === 0) {
		return { message: 'The generated declaration fragment was empty.', ok: false };
	}
	for (const statement of sourceFile.statements) {
		if (!ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
			return {
				message: `Generated declaration contains forbidden ${ts.SyntaxKind[statement.kind]}.`,
				ok: false,
			};
		}
	}
	return { ok: true };
}
