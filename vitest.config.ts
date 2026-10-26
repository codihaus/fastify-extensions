import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// templates/ holds the generated app's own tests; they run inside a generated project.
		exclude: [...configDefaults.exclude, 'templates/**', 'tmp/**'],
	},
});
