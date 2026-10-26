#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { main } from '../dist/cli/index.js';

process.exitCode = await main(process.argv.slice(2), {
	packageRoot: fileURLToPath(new URL('..', import.meta.url)),
});
