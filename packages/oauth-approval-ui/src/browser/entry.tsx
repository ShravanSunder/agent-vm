import { permissionSelectionSummary } from '../permission-selection-summary.js';

for (const form of document.querySelectorAll<HTMLFormElement>('form[data-permission-selector]')) {
	const summaryRoot = form.querySelector<HTMLElement>('[data-permission-summary]');
	if (summaryRoot === null) continue;
	const renderSummary = (): void => {
		const groupCounts = [
			...form.querySelectorAll<HTMLElement>('[data-permission-application]'),
		].map((application) => {
			const mode = application.querySelector<HTMLInputElement>(
				'input[type="radio"]:checked',
			)?.value;
			if (mode !== 'recommended' && mode !== 'custom') return 0;
			return [...application.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(
				(input) =>
					!input.disabled &&
					(mode === 'recommended' ? input.dataset.recommended === 'true' : input.checked),
			).length;
		});
		summaryRoot.textContent = permissionSelectionSummary(groupCounts);
	};
	form.addEventListener('change', renderSummary);
	renderSummary();
}
