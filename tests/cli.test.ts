import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main, scaffold, ScaffoldError } from '../src/cli/index.js';

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname;
const OWN_VERSION = (JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'fx-cli-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const readJson = async (file: string) => JSON.parse(await readFile(join(dir, file), 'utf8')) as Record<string, any>;

describe('scaffold', () => {
	it('generates the MVC app with Liquid views into a new folder', async () => {
		const target = join(dir, 'My Shop');
		const result = await scaffold({ packageRoot: PACKAGE_ROOT, targetDir: target });

		expect(result.name).toBe('my-shop');
		expect(result.manifestKey).toBe('my-shop-extension');
		expect(result.packageJsonCreated).toBe(true);
		for (const file of [
			'.gitignore',
			'src/server.ts',
			'src/app.ts',
			'src/routes.ts',
			'src/controllers/product.controller.ts',
			'src/services/product.service.ts',
			'src/models/product.model.ts',
			'src/middlewares/index.ts',
			'extensions/audit/package.json',
			'extensions/reports/index.ts',
			'views/layouts/base.liquid',
			'views/home/index.liquid',
			'public/css/app.css',
			'test/app.test.ts',
			'scripts/build.mjs',
		]) {
			expect(existsSync(join(target, file)), file).toBe(true);
		}
		expect(existsSync(join(target, '_gitignore'))).toBe(false);
		expect(existsSync(join(target, 'views/home/index.pug'))).toBe(false);

		// Every placeholder is replaced.
		for (const file of result.files) {
			expect(await readFile(join(target, file), 'utf8'), file).not.toMatch(/__(APP_NAME|MANIFEST_KEY|VIEW_ENGINE)__/);
		}
		const manifest = JSON.parse(await readFile(join(target, 'extensions/audit/package.json'), 'utf8'));
		expect(manifest['my-shop-extension']).toEqual({ type: 'hook' });
		expect(manifest.main).toBe('index.js');
		expect(await readFile(join(target, 'src/app.ts'), 'utf8')).toContain("engine: 'liquid'");

		const pkg = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
		expect(pkg).toMatchObject({ name: 'my-shop', type: 'module', private: true });
		expect(pkg.dependencies['@codihaus/fastify-extensions']).toBe(`^${OWN_VERSION}`);
		expect(pkg.dependencies.fastify).toBeDefined();
		expect(pkg.devDependencies.tsx).toBeDefined();
		expect(pkg.scripts).toMatchObject({ dev: 'tsx watch src/server.ts', build: 'node scripts/build.mjs' });
	});

	it('merges into the package.json of a folder where the package was just installed', async () => {
		await writeFile(
			join(dir, 'package.json'),
			JSON.stringify({
				name: 'shop-api',
				version: '1.2.3',
				type: 'commonjs',
				scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .', dev: 'node index.js' },
				dependencies: { '@codihaus/fastify-extensions': 'file:../pkg.tgz', zod: '^3.0.0' },
			}),
		);

		const result = await scaffold({ packageRoot: PACKAGE_ROOT, targetDir: dir, view: 'pug' });

		expect(result.packageJsonCreated).toBe(false);
		expect(result.manifestKey).toBe('shop-api-extension');
		expect(result.notes).toEqual([
			'package.json "type" changed from "commonjs" to "module"',
			'script "dev" replaced (was: node index.js)',
		]);

		const pkg = await readJson('package.json');
		expect(pkg.version).toBe('1.2.3');
		expect(pkg.type).toBe('module');
		expect(pkg.scripts.lint).toBe('eslint .');
		expect(pkg.scripts.test).toContain('tsx --test');
		expect(pkg.dependencies['@codihaus/fastify-extensions']).toBe('file:../pkg.tgz');
		expect(pkg.dependencies.zod).toBe('^3.0.0');
		expect(pkg.dependencies.pug).toBeDefined();
		expect(existsSync(join(dir, 'views/home/index.pug'))).toBe(true);
		expect(existsSync(join(dir, 'views/home/index.liquid'))).toBe(false);
	});

	it('refuses to overwrite existing files unless forced', async () => {
		await scaffold({ packageRoot: PACKAGE_ROOT, targetDir: dir });
		await writeFile(join(dir, 'src/app.ts'), '// edited');

		await expect(scaffold({ packageRoot: PACKAGE_ROOT, targetDir: dir })).rejects.toThrow(/already exist[\s\S]*src\/app\.ts[\s\S]*--force/);
		expect(await readFile(join(dir, 'src/app.ts'), 'utf8')).toBe('// edited');

		await scaffold({ packageRoot: PACKAGE_ROOT, targetDir: dir, force: true });
		expect(await readFile(join(dir, 'src/app.ts'), 'utf8')).toContain('appOptions');
	});

	it('rejects an unknown view engine', async () => {
		await expect(scaffold({ packageRoot: PACKAGE_ROOT, targetDir: dir, view: 'ejs' as never })).rejects.toBeInstanceOf(ScaffoldError);
		expect(existsSync(join(dir, 'src'))).toBe(false);
	});
});

describe('main', () => {
	const run = async (argv: string[], install = vi.fn(async () => 0)) => {
		const lines: string[] = [];
		const code = await main(argv, { packageRoot: PACKAGE_ROOT, cwd: dir, log: (line) => lines.push(line), install });
		return { code, output: lines.join('\n'), install };
	};

	it('prints the version and the help', async () => {
		expect(await run(['--version'])).toMatchObject({ code: 0, output: OWN_VERSION });
		expect((await run([])).output).toContain('init [dir]');
	});

	it('generates the app and installs dependencies', async () => {
		const { code, output, install } = await run(['init', 'app', '--view', 'twig']);
		expect(code).toBe(0);
		expect(install).toHaveBeenCalledWith(join(dir, 'app'), expect.any(String));
		expect(output).toContain('Created app (twig views');
		expect(output).toContain('cd app');
		expect(existsSync(join(dir, 'app/views/home/index.twig'))).toBe(true);
	});

	it('skips installing with --no-install', async () => {
		const { code, install, output } = await run(['init', '--no-install']);
		expect(code).toBe(0);
		expect(install).not.toHaveBeenCalled();
		expect(output).toContain('npm install');
	});

	it('returns the installer exit code on failure', async () => {
		const { code, output } = await run(['init'], vi.fn(async () => 7));
		expect(code).toBe(7);
		expect(output).toContain('install failed (exit 7)');
	});

	it('fails on an unknown command, option or engine', async () => {
		expect((await run(['create'])).code).toBe(1);
		expect((await run(['init', '--bogus'])).code).toBe(1);
		const engine = await run(['init', '--view', 'ejs']);
		expect(engine.code).toBe(1);
		expect(engine.output).toContain('Unknown view engine "ejs"');
	});
});
