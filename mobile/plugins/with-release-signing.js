const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Sign release builds with a real keystore instead of the debug one.
 *
 * This exists because of a default that is reasonable for Expo and wrong for
 * us. `expo prebuild` generates an `android/app/build.gradle` whose *release*
 * build type is configured with `signingConfig signingConfigs.debug` -- so a
 * release APK built straight out of the box is signed with the debug keystore.
 * It installs, it runs, and it looks entirely correct.
 *
 * What makes that a trap rather than a nuisance: the debug keystore is
 * generated per machine and is regenerated whenever it goes missing. Android
 * identifies an app by its package name *and* its signing key, so the second
 * APK, built after a laptop rebuild or on anybody else's machine, is refused
 * by every phone that has the first one with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
 * The only way out of that is uninstalling -- which wipes the app's data,
 * including the stored session token, for everybody.
 *
 * So: a keystore that is ours, backed up, and used for every build forever.
 *
 * The credentials are read from Gradle properties, which belong in
 * `~/.gradle/gradle.properties` and never in this repository. `build-apk.mjs`
 * refuses to build a publishable APK without them.
 *
 * When they are absent the release build falls back to the Expo default, which
 * is deliberate: `expo run:android` on a machine that has never seen the
 * keystore should still produce something that runs. It just must not be
 * handed to anyone, and the build script is what enforces that.
 */

/** The marker that makes this idempotent across repeated prebuilds. */
const MARKER = '// isthislegit: release signing';

/**
 * Appended rather than spliced into the existing blocks.
 *
 * Gradle lets an `android { }` block be reopened, and a later assignment wins
 * -- so adding one at the end of the file overrides the template's choice
 * without having to find and rewrite it. The alternative was a string
 * replacement against `signingConfig signingConfigs.debug`, which appears
 * twice in that file and whose surrounding comment changes between Expo
 * versions. This survives a template rewrite; that would not.
 */
const BLOCK = `
${MARKER} -- see plugins/with-release-signing.js
//
// Absent properties fall back to the template's debug signing, so a checkout
// with no keystore still builds something that runs. scripts/build-apk.mjs
// refuses to publish such a build.
if (project.hasProperty('ISTHISLEGIT_STORE_FILE')) {
    android {
        signingConfigs {
            release {
                storeFile file(ISTHISLEGIT_STORE_FILE)
                storePassword ISTHISLEGIT_STORE_PASSWORD
                keyAlias ISTHISLEGIT_KEY_ALIAS
                keyPassword ISTHISLEGIT_KEY_PASSWORD
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.release
            }
        }
    }
}
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== 'groovy') {
      throw new Error(
        'with-release-signing expected a Groovy build.gradle; the Kotlin DSL ' +
          'needs a different block. Nothing was changed, so the build would ' +
          'have been debug-signed — fix this rather than shipping it.',
      );
    }
    // Prebuild is run repeatedly and does not always start from a clean tree.
    if (!mod.modResults.contents.includes(MARKER)) {
      mod.modResults.contents += BLOCK;
    }
    return mod;
  });
};
