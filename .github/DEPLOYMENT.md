# npm deployment

The `Publish to npm` workflow runs after every push to `prod` and can also be started
manually from GitHub Actions.

Before the first production merge:

1. Create a GitHub Environment named `npm`.
2. Add an environment secret named `NPM_TOKEN`.
3. Use an npm automation token that can publish the `@codihaus/fastify-extensions`
   package.

The workflow runs typechecking, tests, the production build, and `npm pack --dry-run`
before publishing. It skips publishing when the version in `package.json` already exists
on npm.

Every new deployment must update the version in `package.json` and `package-lock.json`
before merging `dev` into `prod`.
