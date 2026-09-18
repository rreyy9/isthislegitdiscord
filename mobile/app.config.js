const pkg = require('./package.json');

/**
 * The static config in app.json, plus the two fields that must never be edited
 * by hand.
 *
 * The version is read from package.json rather than written in app.json, so
 * that `npm version` is the one way to move it -- the same command the rest of
 * the workspace uses, and the one the "Set Android version" task runs. This
 * app sits outside the root `workspaces` glob on purpose, so the workspace-wide
 * `npm version` deliberately does not reach it; without this it would have had
 * a version number of its own that nothing updated and everything trusted.
 *
 * `versionCode` is Android's own monotonic integer, and it is the only number
 * the package manager compares when deciding whether an install is an upgrade.
 * A build whose `version` moved and whose `versionCode` did not is refused by
 * every phone it reaches, and the message it shows says nothing about why --
 * which makes it the most expensive kind of mistake here: invisible until ten
 * people have already been handed the file.
 *
 * So it is derived rather than stored. There is one version number in this
 * project, it lives in app.json, and this turns it into the integer Android
 * wants. Nothing to forget.
 *
 * The scheme is `major * 10000 + minor * 100 + patch`, which keeps the integer
 * readable as the version it came from -- 0.1.0 is 100, 0.4.1 is 401, 1.0.0 is
 * 10000. It allows 99 minors and 99 patches before it would collide, which at
 * this project's release rate is not a deadline anybody alive needs to plan
 * for. A prerelease suffix is ignored: `0.2.0-beta.1` and `0.2.0` produce the
 * same code, so a beta must not be handed out and then followed by the release
 * without a patch bump. Say so out loud rather than pretending otherwise.
 */

/** 0.4.1 -> 401. Throws rather than guessing, because a wrong code is silent. */
function versionCodeFor(version, source = 'package.json') {
  const core = String(version).split('-')[0].split('+')[0];
  const parts = core.split('.').map((p) => Number(p));

  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(
      `${source} version "${version}" is not major.minor.patch, so no ` +
        'Android versionCode can be derived from it.',
    );
  }
  const [major, minor, patch] = parts;
  if (minor > 99 || patch > 99) {
    throw new Error(
      `Version ${version} overflows the versionCode scheme (minor and patch ` +
        'must each stay under 100). Bump the major instead, or change the ' +
        'scheme here and in scripts/build-apk.mjs together.',
    );
  }
  return major * 10000 + minor * 100 + patch;
}

module.exports = ({ config }) => ({
  ...config,
  version: pkg.version,
  android: {
    ...config.android,
    versionCode: versionCodeFor(pkg.version),
  },
});

/*
 * Nothing else re-implements this. `scripts/build-apk.mjs` needs the same
 * number for the manifest it uploads, and it gets it by asking `expo config`
 * for the resolved config rather than by calling this function -- so what it
 * publishes is by construction the number the build actually used, instead of
 * a second derivation that could drift from this one.
 */
