import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: [
		'src/index.ts',
		'src/controller-dispatch-boundary/index.ts',
		'src/controller-execution-data-boundary/index.ts',
		'src/controller-host-action-boundary/index.ts',
		'src/tool-vm-runner-boundary/index.ts',
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
