import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: [
		'src/index.ts',
		'src/adapter-boundary/index.ts',
		'src/approval-surface/index.ts',
		'src/artifact-surface/index.ts',
		'src/capability-description-surface/index.ts',
		'src/portal-call-surface/index.ts',
		'src/portal-event-surface/index.ts',
		'src/testing/index.ts',
	],
	format: 'esm',
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
