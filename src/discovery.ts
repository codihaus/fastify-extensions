import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import type {
	ExtensionConfig,
	ExtensionEntry,
	ExtensionLoggerLike,
	ExtensionManifest,
} from './types.js';

const requireFromHere = createRequire(import.meta.url);

/** Result of {@link validateManifest}. */
export type ManifestValidation =
	| { ok: true; manifest: ExtensionManifest }
	| { ok: false; errors: string[] };

/**
 * Structurally validate a raw manifest value (the contents of `pkg[manifestKey]`).
 * Hand-rolled to keep the package zero-dependency. Unknown extra fields are allowed
 * and preserved on the returned manifest.
 */
export function validateManifest(value: unknown): ManifestValidation {
	const errors: string[] = [];

	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return { ok: false, errors: ['manifest must be an object'] };
	}

	const raw = value as Record<string, unknown>;

	if (raw['id'] !== undefined && typeof raw['id'] !== 'string') {
		errors.push('manifest.id must be a string when present');
	}

	if (raw['type'] !== undefined && raw['type'] !== 'hook' && raw['type'] !== 'endpoint') {
		errors.push('manifest.type must be "hook" or "endpoint" when present');
	}

	if (raw['path'] !== undefined && typeof raw['path'] !== 'string') {
		errors.push('manifest.path must be a string when present');
	}

	if (raw['bundle'] !== undefined && raw['bundle'] !== null && typeof raw['bundle'] !== 'string') {
		errors.push('manifest.bundle must be a string or null when present');
	}

	if (raw['entries'] !== undefined) {
		if (!Array.isArray(raw['entries'])) {
			errors.push('manifest.entries must be an array when present');
		} else {
			raw['entries'].forEach((entry, index) => {
				if (entry === null || typeof entry !== 'object') {
					errors.push(`manifest.entries[${index}] must be an object`);
					return;
				}
				const entryRecord = entry as Record<string, unknown>;
				if (entryRecord['type'] !== 'hook' && entryRecord['type'] !== 'endpoint') {
					errors.push(`manifest.entries[${index}].type must be "hook" or "endpoint"`);
				}
				if (typeof entryRecord['name'] !== 'string') {
					errors.push(`manifest.entries[${index}].name must be a string`);
				}
			});
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return { ok: true, manifest: raw as ExtensionManifest };
}

/** Build a resolved {@link ExtensionConfig} from a validated manifest. */
function buildExtensionConfig(
	manifest: ExtensionManifest,
	folder: string,
	source: 'local' | 'module',
	resolvedPath: string,
): ExtensionConfig {
	const entries: ExtensionEntry[] = Array.isArray(manifest.entries)
		? manifest.entries.map((entry) => ({ type: entry.type, name: entry.name }))
		: [];

	return {
		id: manifest.id ?? folder,
		folder,
		source,
		bundle: manifest.bundle ?? null,
		path: manifest.path ?? null,
		entries,
		resolvedPath,
	};
}

/** Parse and validate the manifest embedded in a package.json record. */
function extractManifest(
	pkg: Record<string, unknown>,
	manifestKey: string,
	folder: string,
	logger: ExtensionLoggerLike,
): ExtensionManifest | null {
	const rawManifest = pkg[manifestKey];
	if (rawManifest === undefined) {
		return null;
	}

	const validation = validateManifest(rawManifest);
	if (!validation.ok) {
		logger.warn({ folder, errors: validation.errors }, 'Invalid extension manifest, skipping');
		return null;
	}

	return validation.manifest;
}

/**
 * Scan a local directory: each subdirectory whose package.json carries `manifestKey`
 * becomes a candidate extension. An unreadable directory yields an empty list.
 */
export async function scanLocalExtensions(
	extensionsPath: string,
	manifestKey: string,
	logger: ExtensionLoggerLike,
): Promise<ExtensionConfig[]> {
	const rootPath = resolve(extensionsPath);
	const configs: ExtensionConfig[] = [];

	let entries: string[];
	try {
		// Sorted so hook registration order is deterministic across platforms —
		// readdir order is filesystem-dependent and filters/inits are order-sensitive.
		entries = (await readdir(rootPath)).sort();
	} catch {
		logger.debug({ path: rootPath }, 'Extensions directory not found or not readable');
		return [];
	}

	for (const folder of entries) {
		const extensionRoot = join(rootPath, folder);
		const packageJsonPath = join(extensionRoot, 'package.json');

		let packageContent: string;
		try {
			packageContent = await readFile(packageJsonPath, 'utf-8');
		} catch {
			continue;
		}

		let pkg: Record<string, unknown>;
		try {
			pkg = JSON.parse(packageContent) as Record<string, unknown>;
		} catch {
			logger.warn({ folder }, 'Invalid package.json in extension, skipping');
			continue;
		}

		const manifest = extractManifest(pkg, manifestKey, folder, logger);
		if (!manifest) {
			continue;
		}

		configs.push(buildExtensionConfig(manifest, folder, 'local', extensionRoot));
	}

	return configs;
}

/**
 * Scan the host package.json `dependencies` (never `devDependencies`) for installed
 * packages whose package.json carries `manifestKey`. Unresolvable dependencies are
 * silently skipped.
 */
export async function scanModuleExtensions(
	moduleRoot: string,
	manifestKey: string,
	logger: ExtensionLoggerLike,
): Promise<ExtensionConfig[]> {
	const hostPackagePath = join(moduleRoot, 'package.json');
	const configs: ExtensionConfig[] = [];

	let hostPackage: { dependencies?: Record<string, string> };
	try {
		const content = await readFile(hostPackagePath, 'utf-8');
		hostPackage = JSON.parse(content) as { dependencies?: Record<string, string> };
	} catch {
		logger.debug({ moduleRoot }, 'Could not read host package.json for module extension discovery');
		return [];
	}

	const dependencyNames = Object.keys(hostPackage.dependencies ?? {});

	for (const name of dependencyNames) {
		try {
			const modulePackageJsonPath = requireFromHere.resolve(`${name}/package.json`, { paths: [moduleRoot] });
			const modulePath = dirname(modulePackageJsonPath);
			const manifestContent = await readFile(modulePackageJsonPath, 'utf-8');
			const pkg = JSON.parse(manifestContent) as Record<string, unknown>;

			const manifest = extractManifest(pkg, manifestKey, name, logger);
			if (!manifest) {
				continue;
			}

			configs.push(buildExtensionConfig(manifest, name, 'module', modulePath));
		} catch {
			// Not resolvable or not an extension — skip.
		}
	}

	if (configs.length > 0) {
		logger.info({ count: configs.length }, 'Discovered module extensions from host package.json');
	}

	return configs;
}
