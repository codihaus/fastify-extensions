import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
// Also carries the `reply.view()` / `app.view()` type augmentation into the kit's d.ts.
import type { FastifyViewOptions } from '@fastify/view';
import type { Liquid } from 'liquidjs';

/** Template engines the kit wires through `@fastify/view`. */
export type ViewEngineName = 'liquid' | 'pug' | 'twig';

/**
 * Server-side template rendering. Enabled by default with Liquid; set `view: false` to
 * skip it. Routes and extension endpoints render with `reply.view('page', data)`.
 */
export interface AppKitViewOptions {
	/**
	 * Default `liquid` (bundled). `pug` and `twig` need their package installed in the host:
	 * `npm install pug` / `npm install twig`.
	 */
	engine?: ViewEngineName;
	/** Template directory. Default `<cwd>/views`. Relative paths resolve against the cwd. */
	root?: string;
	/**
	 * Template file extension without the dot. Default `liquid` / `pug` / `twig`.
	 * `reply.view('home')` renders `home.<extension>`.
	 */
	extension?: string;
	/**
	 * Cache compiled templates. Default `process.env.NODE_ENV === 'production'`
	 * (the `@fastify/view` default).
	 */
	production?: boolean;
	/** Data merged into every render (site name, asset base URL, ...). */
	defaultContext?: Record<string, unknown>;
	/**
	 * Engine options. Liquid: `liquidjs` constructor options (filters go in `setup`).
	 * Pug / Twig: render options passed through `@fastify/view`.
	 *
	 * Output is HTML-escaped by default on all three engines (Liquid `outputEscape:
	 * 'escape'`, Twig `autoescape: true`, Pug `#{}`). Mark trusted HTML with `| raw`
	 * (Liquid, Twig) or `!{}` (Pug).
	 *
	 * Twig: `@fastify/view` merges these options into the render data. Never pass a
	 * `settings` key in view data, and keep `autoescape: true` if you set `options.settings`.
	 */
	options?: Record<string, unknown>;
	/** Liquid only: receives the `Liquid` instance to register filters and tags. */
	setup?: (engine: Liquid) => void;
	/** Reply decorator name. Default `view` (`reply.view`, `app.view`). */
	propertyName?: string;
	/** Extra `@fastify/view` options (`charset`, `maxCache`, ...). Applied last. */
	plugin?: Partial<FastifyViewOptions>;
}

const PACKAGE_BY_ENGINE: Record<ViewEngineName, string> = {
	liquid: 'liquidjs',
	pug: 'pug',
	twig: 'twig',
};

/**
 * Register `@fastify/view` on the root instance with the selected engine. The plugin
 * uses `fastify-plugin`, so `reply.view` reaches every child scope, extension
 * endpoints included. Engine packages load lazily: an app with `view: false` never
 * imports them.
 */
export async function registerView(app: FastifyInstance, options: AppKitViewOptions): Promise<void> {
	const engineName = options.engine ?? 'liquid';
	if (!(engineName in PACKAGE_BY_ENGINE)) {
		throw new Error(`Unsupported view engine "${engineName}" — use one of ${Object.keys(PACKAGE_BY_ENGINE).join(', ')}.`);
	}

	const root = resolve(options.root ?? 'views');
	const extension = (options.extension ?? engineName).replace(/^\./, '');
	const production = options.production ?? process.env['NODE_ENV'] === 'production';
	const engineModule = await importEngine(engineName);

	let engine: unknown = engineModule;
	let renderOptions = options.options ?? {};
	if (engineName === 'liquid') {
		// @fastify/view renders Liquid through an instance; partials and layouts
		// (`{% render %}`, `{% layout %}`) resolve against the same root.
		const { Liquid } = engineModule as { Liquid: new (options: Record<string, unknown>) => unknown };
		engine = new Liquid({
			root,
			extname: `.${extension}`,
			cache: production,
			// HTML-escape every output by default; `{{ html | raw }}` opts out.
			outputEscape: 'escape',
			...options.options,
		});
		options.setup?.(engine as Liquid);
		renderOptions = {};
	} else if (engineName === 'twig' && renderOptions['settings'] === undefined) {
		// twig.js does not escape by default; @fastify/view passes these settings to renderFile.
		renderOptions = { ...renderOptions, settings: { 'twig options': { autoescape: true } } };
	}

	const { default: fastifyView } = await import('@fastify/view');
	await app.register(fastifyView, {
		engine: { [engineName]: engine },
		root,
		viewExt: extension,
		includeViewExtension: true,
		production,
		defaultContext: options.defaultContext,
		options: renderOptions,
		propertyName: options.propertyName,
		...options.plugin,
	});
}

async function importEngine(engineName: ViewEngineName): Promise<unknown> {
	const packageName = PACKAGE_BY_ENGINE[engineName];
	try {
		const imported = (await import(packageName)) as { default?: unknown };
		return engineName === 'liquid' ? imported : (imported.default ?? imported);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' || (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
			throw new Error(`View engine "${engineName}" needs the "${packageName}" package — run: npm install ${packageName}`);
		}
		throw error;
	}
}
