import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: ['src/index.ts', 'src/standalone-entrypoint/index.ts', 'src/testing/index.ts'],
	format: 'esm',
	hash: false,
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
