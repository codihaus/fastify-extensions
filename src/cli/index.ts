import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { scaffold, ScaffoldError, VIEW_ENGINES, type ScaffoldViewEngine } from './scaffold.js';

export { scaffold, ScaffoldError, VIEW_ENGINES, type ScaffoldOptions, type ScaffoldResult, type ScaffoldViewEngine } from './scaffold.js';

export interface CliEnvironment {
	/** Root of the installed package. The bin script passes it, so this module needs no `import.meta`. */
	packageRoot: string;
	cwd?: string;
	log?: (line: string) => void;
	/** Dependency installer. Default: run `<package manager> install` in the app folder. */
	install?: (dir: string, packageManager: string) => Promise<number>;
}

const HELP = `Usage: fastify-extensions <command> [options]

Commands:
  init [dir]            Generate an MVC app (TypeScript, views, extensions) in dir (default: .)

Options for init:
  --name <name>         Package name (default: existing package.json name or folder name)
  --view <engine>       View engine: ${VIEW_ENGINES.join(' | ')} (default: liquid)
  --no-install          Skip installing dependencies
  --force               Overwrite existing files

  -h, --help            Show this help
  -v, --version         Show the package version
`;

/** Run the CLI. Returns the process exit code. */
export async function main(argv: string[], env: CliEnvironment): Promise<number> {
	const log = env.log ?? ((line: string) => console.log(line));

	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				name: { type: 'string' },
				view: { type: 'string' },
				'no-install': { type: 'boolean' },
				force: { type: 'boolean' },
				help: { type: 'boolean', short: 'h' },
				version: { type: 'boolean', short: 'v' },
			},
		});
	} catch (error) {
		log(`${(error as Error).message}\n\n${HELP}`);
		return 1;
	}

	const { values, positionals } = parsed;
	const [command, dir, ...rest] = positionals;

	if (values.version) {
		const pkg = JSON.parse(await readFile(join(env.packageRoot, 'package.json'), 'utf8')) as { version: string };
		log(pkg.version);
		return 0;
	}
	if (values.help || command === undefined || command === 'help') {
		log(HELP);
		return 0;
	}
	if (command !== 'init') {
		log(`Unknown command "${command}".\n\n${HELP}`);
		return 1;
	}
	if (rest.length > 0) {
		log(`Unexpected arguments: ${rest.join(' ')}\n\n${HELP}`);
		return 1;
	}

	const cwd = env.cwd ?? process.cwd();
	const targetDir = resolve(cwd, dir ?? '.');

	let result;
	try {
		result = await scaffold({
			packageRoot: env.packageRoot,
			targetDir,
			name: values.name,
			view: values.view as ScaffoldViewEngine | undefined,
			force: values.force,
		});
	} catch (error) {
		if (error instanceof ScaffoldError) {
			log(error.message);
			return 1;
		}
		throw error;
	}

	log(`Created ${result.name} (${result.view} views, manifest key "${result.manifestKey}") in ${targetDir}`);
	for (const note of result.notes) log(`  note: ${note}`);

	const packageManager = detectPackageManager();
	const skipInstall = values['no-install'] === true;
	if (!skipInstall) {
		log(`\nInstalling dependencies with ${packageManager}...`);
		const code = await (env.install ?? runInstall)(targetDir, packageManager);
		if (code !== 0) {
			log(`\n${packageManager} install failed (exit ${code}). Run it again inside the app folder.`);
			return code;
		}
	}

	const cd = relative(cwd, targetDir);
	const run = packageManager === 'npm' ? 'npm run' : packageManager;
	log(
		[
			'',
			'Next steps:',
			...(cd ? [`  cd ${cd}`] : []),
			...(skipInstall ? [`  ${packageManager} install`] : []),
			`  ${run} dev          start with reload on http://127.0.0.1:3000`,
			`  ${run} test         run the smoke tests`,
			`  ${run} build        compile to dist/, then: ${run} start`,
		].join('\n'),
	);
	return 0;
}

function detectPackageManager(): string {
	const agent = process.env['npm_config_user_agent'] ?? '';
	for (const name of ['pnpm', 'yarn', 'bun']) {
		if (agent.startsWith(`${name}/`)) return name;
	}
	return 'npm';
}

function runInstall(dir: string, packageManager: string): Promise<number> {
	return new Promise((resolveCode) => {
		const child = spawn(packageManager, ['install'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
		child.on('error', () => resolveCode(1));
		child.on('exit', (code) => resolveCode(code ?? 1));
	});
}
