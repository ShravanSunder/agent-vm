import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: {
		e2e: 'src/openclaw-plugin-registration.e2e.ts',
		index: 'src/index.ts',
	},
	external: ['/opt/openclaw-sdk/diagnostic-runtime.js', '/opt/openclaw-sdk/sandbox.js'],
	format: 'esm',
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
