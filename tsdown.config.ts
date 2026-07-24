import { defineConfig } from 'tsdown';

const env = process.env.NODE_ENV;

export default defineConfig({
	sourcemap: env === 'production',
	dts: true,
	format: ['cjs', 'esm'],
	minify: env === 'production',
	watch: env === 'development',
	unbundle: true,
	target: 'es2022',
	// Keep ESM output as .js/.d.ts (package is type:module) — the exports map and
	// the REQUIREMENTS §2 contract reference dist/index.js, not .mjs.
	fixedExtension: false,
	entry: ['src/index.ts', 'src/types.ts'],
});
