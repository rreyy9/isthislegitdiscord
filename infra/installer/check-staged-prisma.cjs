/**
 * Does the pruned server tree still run the Prisma CLI?
 *
 * build-server-installer.ps1 deletes whole packages out of the staged
 * node_modules that only `prisma studio` and `prisma dev` are believed to
 * reach for. Getting that list wrong is invisible here and fatal there: the
 * install fails at `prisma migrate deploy` with MODULE_NOT_FOUND, on a
 * customer's box, after the server has already been stopped.
 *
 * That is not hypothetical. 0.2.6 shipped with @prisma/studio-core pruned, and
 * prisma/build/cli.js requires it at the top level -- so every CLI command
 * failed, including migrate deploy.
 *
 * ## Why testing it by hand said it was fine
 *
 * The staged tree lives inside this repo, at <repo>\release\staging\...\server.
 * When Node cannot find a package in that tree's node_modules it walks UP the
 * directory chain and finds the repo's own root node_modules, which has
 * everything. So the pruned tree resolves the pruned packages anyway, and
 * `prisma migrate status` run from the staging folder passes. Installed at
 * C:\isthislegit there is nothing above it to fall back to, and the same
 * command throws.
 *
 * So this does not merely run the CLI. It runs it with a resolver hook that
 * rejects anything resolving outside the staged tree, which makes the staging
 * folder behave exactly like the install directory. That hook is the whole
 * point of the file -- without it the check passes on a tree that is broken.
 *
 * ## What counts as passing
 *
 * `migrate status` against a database that is not there. It is read-only, so
 * it cannot touch anything if the URL ever did point somewhere real, and it
 * loads the same module graph as `migrate deploy` -- both live in cli.js.
 * Reaching P1001 "can't reach database server" means every require resolved
 * and the schema engine started, which is all this is asking.
 *
 * Usage:  node check-staged-prisma.cjs <staged server dir>
 */

'use strict';

const path = require('path');

/* ------------------------------------------------------------------ guard */

// Loaded into the CLI's own process with --require. Same file, so there is one
// thing to read and one thing to keep in step.
if (process.env.PRISMA_CHECK_ROOT) {
  const Module = require('module');
  const root = process.env.PRISMA_CHECK_ROOT.toLowerCase();
  const resolve = Module._resolveFilename;

  Module._resolveFilename = function (request, ...rest) {
    const resolved = resolve.call(this, request, ...rest);
    if (
      typeof resolved === 'string' &&
      resolved.toLowerCase().includes('node_modules') &&
      !resolved.toLowerCase().startsWith(root)
    ) {
      // Printed as well as thrown: the throw becomes a stack trace naming the
      // requiring file, and this names the package to put back.
      console.error(`PRISMA_CHECK_LEAK ${request} -> ${resolved}`);
      const err = new Error(`Cannot find module '${request}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return resolved;
  };
  return;
}

/* ----------------------------------------------------------------- driver */

const serverDir = process.argv[2];
if (!serverDir) {
  console.error('usage: node check-staged-prisma.cjs <staged server dir>');
  process.exit(2);
}

const root = path.resolve(serverDir);
const cli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');

const { spawnSync } = require('child_process');
const run = spawnSync(
  process.execPath,
  ['--require', __filename, cli, 'migrate', 'status'],
  {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PRISMA_CHECK_ROOT: root.toLowerCase(),
      // A port nothing listens on, and credentials for nothing. The command is
      // read-only regardless; this makes it unreachable as well.
      DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:59999/nothing',
    },
  },
);

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;

const leaks = [
  ...new Set(
    output
      .split(/\r?\n/)
      .filter((l) => l.startsWith('PRISMA_CHECK_LEAK '))
      .map((l) => l.slice('PRISMA_CHECK_LEAK '.length).split(' -> ')[0]),
  ),
];

if (leaks.length > 0) {
  console.error('');
  console.error('The staged tree is missing packages the Prisma CLI loads:');
  for (const l of leaks) console.error(`    ${l}`);
  console.error('');
  console.error('Every one of these resolved to the repo root instead, which is');
  console.error('why it works here and fails once installed. Take the package');
  console.error('they belong to out of $cliOnly in build-server-installer.ps1.');
  process.exit(1);
}

// P1001 is the database refusing to be there, which is the expected end of a
// run where everything loaded. Anything else means the CLI fell over earlier,
// for a reason worth reading rather than guessing at.
if (!output.includes('P1001')) {
  console.error('');
  console.error('The Prisma CLI did not get as far as trying to connect.');
  console.error(`exit code: ${run.status}`);
  console.error(output.trim());
  process.exit(1);
}

console.log('  the pruned tree runs the Prisma CLI (reached P1001, as expected)');
