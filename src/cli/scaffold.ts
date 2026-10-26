import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/** View engines the app template ships views for. */
export const VIEW_ENGINES = ['liquid', 'pug', 'twig'] as const;
export type ScaffoldViewEngine = (typeof VIEW_ENGINES)[number];

export interface ScaffoldOptions {
	/** Root of the installed @codihaus/fastify-extensions package (holds `templates/`). */
	packageRoot: string;
	/** Directory to generate the app in. Created when missing. */
	targetDir: string;
	/** npm package name. Default: existing package.json name, else the folder name. */
	name?: string;
	/** View engine. Default `liquid`. */
	view?: ScaffoldViewEngine;
	/** Overwrite files that already exist. */
	force?: boolean;
}

export interface ScaffoldResult {
	name: string;
	manifestKey: string;
	view: ScaffoldViewEngine;
	/** Generated files, relative to the target directory. */
	files: string[];
	/** True when package.json did not exist before. */
	packageJsonCreated: boolean;
	/** Existing package.json changes worth reporting (replaced scripts, module type). */
	notes: string[];
}

/** A user-facing failure: the CLI prints the message without a stack. */
export class ScaffoldError extends Error {}

type PackageJson = Record<string, unknown> & {
	name?: string;
	type?: string;
	scripts?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	engines?: Record<string, string>;
};

const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

const SCRIPTS: Record<string, string> = {
	dev: 'tsx watch src/server.ts',
	build: 'node scripts/build.mjs',
	start: 'node dist/src/server.js',
	test: 'tsx --test "test/**/*.test.ts"',
	typecheck: 'tsc --noEmit',
};

const DEV_DEPENDENCIES: Record<string, string> = {
	'@types/node': '^22.10.0',
	tsx: '^4.19.0',
	typescript: '^5.8.0',
};

const ENGINE_PACKAGES: Record<ScaffoldViewEngine, Record<string, string>> = {
	liquid: {},
	pug: { pug: '^3.0.0' },
	twig: { twig: '^3.0.0' },
};

/**
 * Generate an MVC app (TypeScript, kit boot, views, extensions) in `targetDir`.
 * An existing package.json is merged, so the CLI also works in a folder where the
 * package was just installed. Other existing files are never overwritten without `force`.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
	const view = options.view ?? 'liquid';
	if (!VIEW_ENGINES.includes(view)) {
		throw new ScaffoldError(`Unknown view engine "${view}" — use one of ${VIEW_ENGINES.join(', ')}.`);
	}

	const targetDir = resolve(options.targetDir);
	const templatesDir = join(options.packageRoot, 'templates');
	const ownPackage = JSON.parse(await readFile(join(options.packageRoot, 'package.json'), 'utf8')) as PackageJson;

	// Planned files: target path (relative) -> template source path.
	const plan = new Map<string, string>();
	for (const source of await listFiles(join(templatesDir, 'app'))) {
		plan.set(outputPath(relative(join(templatesDir, 'app'), source)), source);
	}
	for (const source of await listFiles(join(templatesDir, 'views', view))) {
		plan.set(join('views', relative(join(templatesDir, 'views', view), source)), source);
	}

	const conflicts = [...plan.keys()].filter((file) => existsSync(join(targetDir, file)));
	if (conflicts.length > 0 && !options.force) {
		const shown = conflicts.slice(0, 10).map((file) => `  ${file}`).join('\n');
		const more = conflicts.length > 10 ? `\n  ... and ${conflicts.length - 10} more` : '';
		throw new ScaffoldError(`These files already exist in ${targetDir}:\n${shown}${more}\nUse --force to overwrite them.`);
	}

	const packageJsonPath = join(targetDir, 'package.json');
	const packageJsonCreated = !existsSync(packageJsonPath);
	const pkg: PackageJson = packageJsonCreated ? {} : (JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageJson);

	const name = toPackageName(options.name ?? pkg.name ?? basename(targetDir));
	const manifestKey = `${name.replace(/^@[^/]+\//, '')}-extension`;
	const tokens: Record<string, string> = {
		__APP_NAME__: name,
		__MANIFEST_KEY__: manifestKey,
		__VIEW_ENGINE__: view,
	};

	for (const [file, source] of plan) {
		const destination = join(targetDir, file);
		await mkdir(dirname(destination), { recursive: true });
		const content = await readFile(source, 'utf8');
		await writeFile(destination, content.replace(/__(APP_NAME|MANIFEST_KEY|VIEW_ENGINE)__/g, (token) => tokens[token] ?? token));
	}

	const notes = mergePackageJson(pkg, {
		name,
		dependencies: {
			[ownPackage.name ?? '@codihaus/fastify-extensions']: `^${String(ownPackage['version'])}`,
			'@fastify/static': '^10.0.0',
			fastify: '^5.2.0',
			...ENGINE_PACKAGES[view],
		},
	});
	await mkdir(targetDir, { recursive: true });
	await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

	return {
		name,
		manifestKey,
		view,
		files: [...plan.keys(), ...(packageJsonCreated ? ['package.json'] : [])].sort(),
		packageJsonCreated,
		notes,
	};
}

function mergePackageJson(pkg: PackageJson, input: { name: string; dependencies: Record<string, string> }): string[] {
	const notes: string[] = [];

	pkg.name ??= input.name;
	pkg['version'] ??= '0.1.0';
	pkg['private'] ??= true;
	if (pkg.type !== 'module') {
		if (pkg.type !== undefined) notes.push(`package.json "type" changed from "${pkg.type}" to "module"`);
		pkg.type = 'module';
	}

	pkg.scripts ??= {};
	for (const [key, command] of Object.entries(SCRIPTS)) {
		const existing = pkg.scripts[key];
		if (existing !== undefined && existing !== command && !(key === 'test' && existing === NPM_DEFAULT_TEST)) {
			notes.push(`script "${key}" replaced (was: ${existing})`);
		}
		pkg.scripts[key] = command;
	}

	// Keep versions the user already chose (e.g. the package they just installed).
	pkg.dependencies = { ...input.dependencies, ...pkg.dependencies };
	pkg.devDependencies = { ...DEV_DEPENDENCIES, ...pkg.devDependencies };
	pkg.engines = { node: '>=22', ...pkg.engines };

	return notes;
}

/** npm strips dotfiles like `.gitignore` from tarballs, so templates store them as `_name`. */
function outputPath(templatePath: string): string {
	const parts = templatePath.split(sep);
	const file = parts.pop() ?? '';
	return join(...parts, file.startsWith('_') ? `.${file.slice(1)}` : file);
}

function toPackageName(raw: string): string {
	const name = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9@/._-]+/g, '-')
		.replace(/^[._-]+|-+$/g, '');
	return name || 'app';
}

async function listFiles(dir: string): Promise<string[]> {
	if (!existsSync(dir)) throw new ScaffoldError(`Template folder not found: ${dir}`);
	const files: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(path)));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}
