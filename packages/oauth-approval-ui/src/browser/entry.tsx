/** @jsxImportSource hono/jsx/dom */
import { createRoot } from 'hono/jsx/dom/client';
import type { JSX } from 'hono/jsx/dom/jsx-runtime';

function PermissionSummary(props: { readonly form: HTMLFormElement }): JSX.Element {
	const selected = [
		...props.form.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked'),
	];
	const granted = selected.filter((input) => input.value !== 'none');
	return (
		<p>
			{granted.length === 0
				? 'No Google services selected.'
				: `${String(granted.length)} service ${granted.length === 1 ? 'permission' : 'permissions'} selected.`}
		</p>
	);
}

for (const form of document.querySelectorAll<HTMLFormElement>('form[data-permission-selector]')) {
	const summaryRoot = form.querySelector<HTMLElement>('[data-permission-summary]');
	if (summaryRoot === null) continue;
	const root = createRoot(summaryRoot);
	const renderSummary = (): void => root.render(<PermissionSummary form={form} />);
	form.addEventListener('change', renderSummary);
	renderSummary();
}
