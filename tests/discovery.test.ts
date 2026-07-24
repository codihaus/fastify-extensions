import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifest, ExtensionManager } from '../src/index.js';
import type { ExtensionConfig, ExtensionLoggerLike } from '../src/index.js';
import { entryPointToUrl } from '../src/loader.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const localFixtures = join(currentDir, 'fixtures/local');
const moduleRootFixtures = join(currentDir, 'fixtures/module-root');

interface TestContext {
	id: string;
	marks: string[];
	actions: string[];
}

function createFakeLogger(): { logger: ExtensionLoggerLike; calls: Array<{ level: string; obj: unknown; msg: string | undefined }> } {
	const calls: Array<{ level: string; obj: unknown; msg: string | undefined }> = [];
	const logger: ExtensionLoggerLike = {
		debug: (obj, msg) => {
			calls.push({ level: 'debug', obj, msg });
		},
		info: (obj, msg) => {
			calls.push({ level: 'info', obj, msg });
		},
		warn: (obj, msg) => {
			calls.push({ level: 'warn', obj, msg });
		},
		error: (obj, msg) => {
			calls.push({ level: 'error', obj, msg });
		},
		child: () => logger,
	};
	return { logger, calls };
}

function makeCreateContext() {
	const contexts: Record<string, TestContext> = {};
	return (config: ExtensionConfig): TestContext => {
		if (!contexts[config.id]) {
			contexts[config.id] = { id: config.id, marks: [], actions: [] };
		}
		return contexts[config.id];
	};
}

describe('validateManifest', () => {
	it('accepts a minimal empty manifest', () => {
		const result = validateManifest({});

		expect(result.ok).toBe(true);
	});

	it('accepts a full valid manifest', () => {
		const result = validateManifest({
			id: 'my-extension',
			type: 'endpoint',
			path: 'dist/custom.js',
			bundle: null,
			entries: [
				{ type: 'hook', name: 'audit' },
				{ type: 'endpoint', name: 'billing' },
			],
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.manifest.id).toBe('my-extension');
			expect(result.manifest.type).toBe('endpoint');
			expect(result.manifest.entries).toHaveLength(2);
		}
	});

	it('rejects manifest.type "not-a-valid-type"', () => {
		const result = validateManifest({ type: 'not-a-valid-type' });

		expect(result.ok).toBe(false);
	});

	it('rejects manifest.entries that is not an array', () => {
		const result = validateManifest({ entries: 'nope' });

		expect(result.ok).toBe(false);
	});

	it('rejects an entry missing "name"', () => {
		const result = validateManifest({ entries: [{ type: 'hook' }] });

		expect(result.ok).toBe(false);
	});

	it('returns an errors array on failure', () => {
		const result = validateManifest({ type: 'bogus', entries: 'nope' });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(Array.isArray(result.errors)).toBe(true);
			expect(result.errors.length).toBeGreaterThan(0);
			for (const error of result.errors) {
				expect(typeof error).toBe('string');
			}
		}
	});
});

describe('entryPointToUrl', () => {
	it('returns a file:// URL string for an absolute path (Windows-safe import specifier)', () => {
		const absolutePath = join(localFixtures, 'hook-basic', 'index.js');

		const url = entryPointToUrl(absolutePath);

		expect(typeof url).toBe('string');
		expect(url.startsWith('file://')).toBe(true);
	});
});

describe('local discovery', () => {
	it('discovers exactly the 6 valid local fixtures, excluding invalid-manifest and no-manifest', async () => {
		const { logger, calls } = createFakeLogger();
		const manager = new ExtensionManager({
			manifestKey: 'test-extension',
			extensionsPath: localFixtures,
			moduleRoot: false,
			logger,
			createContext: makeCreateContext(),
		});

		const configs = await manager.scanExtensions();
		const ids = configs.map((config) => config.id).sort();

		expect(ids).toEqual(
			['bundle-full', 'custom-entry', 'disabled', 'endpoint-basic', 'hook-basic', 'broken-import'].sort(),
		);
		expect(ids).not.toContain('invalid-manifest');
		expect(ids).not.toContain('no-manifest');

		for (const config of configs) {
			expect(config.source).toBe('local');
		}

		const invalidManifestWarning = calls.find(
			(call) => call.level === 'warn' && (call.obj as { folder?: string })?.folder === 'invalid-manifest',
		);
		expect(invalidManifestWarning).toBeDefined();
	});
});

describe('module discovery', () => {
	it('discovers mod-ext and hook-basic from dependencies, excludes not-ext and dev-ext', async () => {
		const { logger } = createFakeLogger();
		const manager = new ExtensionManager({
			manifestKey: 'test-extension',
			extensionsPath: undefined,
			moduleRoot: moduleRootFixtures,
			logger,
			createContext: makeCreateContext(),
		});

		const configs = await manager.scanExtensions();
		const ids = configs.map((config) => config.id).sort();

		expect(ids).toEqual(['hook-basic', 'mod-ext'].sort());
		expect(ids).not.toContain('not-ext');
		expect(ids).not.toContain('dev-ext');

		for (const config of configs) {
			expect(config.source).toBe('module');
		}
	});
});

describe('local vs module precedence', () => {
	it('local wins over module on an id collision (hook-basic stays "local", module variant deduped)', async () => {
		const { logger } = createFakeLogger();
		const manager = new ExtensionManager({
			manifestKey: 'test-extension',
			extensionsPath: localFixtures,
			moduleRoot: moduleRootFixtures,
			logger,
			createContext: makeCreateContext(),
		});

		const configs = await manager.scanExtensions();
		const hookBasicConfigs = configs.filter((config) => config.id === 'hook-basic');

		expect(hookBasicConfigs).toHaveLength(1);
		expect(hookBasicConfigs[0]?.source).toBe('local');

		const ids = configs.map((config) => config.id).sort();
		expect(ids).toContain('mod-ext');
	});
});

describe('entry resolution precedence path > main > dist/index.js', () => {
	it('loads custom-entry via manifest.path (no main, no dist/index.js)', async () => {
		const { logger } = createFakeLogger();
		const manager = new ExtensionManager({
			manifestKey: 'test-extension',
			extensionsPath: localFixtures,
			moduleRoot: false,
			logger,
			createContext: makeCreateContext(),
		});

		await manager.scanAndLoadHooks();

		let seen: unknown;
		manager.emitter.onFilter('custom.event', (payload) => {
			seen = payload;
			return payload;
		});
		await manager.emitter.emitFilter('custom.event', { initial: true }, {}, {});

		expect(seen).toEqual({ initial: true, custom: true });
	});
});
