import { defineConfig } from 'tsdown';

export default defineConfig({
	clean: true,
	dts: true,
	entry: [
		'src/index.ts',
		'src/core/index.ts',
		'src/mcp-proxy/index.ts',
		'src/mcp-provider-backend/index.ts',
		'src/cli/index.ts',
		'src/portal-config/index.ts',
		'src/portal-auth/agent-bearer-token.ts',
		'src/portal-auth/hmac-env.ts',
		'src/portal-auth/hmac-token.ts',
		'src/bin/mcp-portal.ts',
		'src/testing/fake-upstream-mcp-server.ts',
	],
	format: 'esm',
	outExtensions: () => ({
		dts: '.d.ts',
		js: '.js',
	}),
	outDir: 'dist',
	tsconfig: 'tsconfig.build.json',
});
