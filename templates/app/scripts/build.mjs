// Compile TypeScript to dist/ and copy what the compiled app reads at runtime:
// views, public assets and extension manifests. Extension manifests point at
// index.js, which tsx maps to index.ts in dev and tsc emits for production.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const outDir = 'dist';

rmSync(outDir, { recursive: true, force: true });

const tsc = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
	stdio: 'inherit',
});
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

for (const dir of ['views', 'public']) {
	if (existsSync(dir)) cpSync(dir, join(outDir, dir), { recursive: true });
}

for (const entry of readdirSync('extensions', { withFileTypes: true })) {
	const manifest = join('extensions', entry.name, 'package.json');
	if (entry.isDirectory() && existsSync(manifest)) {
		cpSync(manifest, join(outDir, manifest));
	}
}

console.log(`Built to ${outDir}/ — run: node ${outDir}/src/server.js`);
