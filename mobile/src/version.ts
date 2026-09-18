import * as Application from 'expo-application';
import Constants from 'expo-constants';

/**
 * What this build calls itself, and how it says so to the server.
 *
 * Two numbers, and they are not interchangeable:
 *
 * - `version` is the semver from app.json. It is what a person is shown, what
 *   the server records as telemetry, and what `compareVersions` orders.
 * - `versionCode` is Android's own monotonic integer, derived from the semver
 *   in app.config.js. It is the only number the package manager compares when
 *   deciding whether an install is an upgrade, and so it is the only number
 *   worth asking "is there an update?" with.
 *
 * Read from the running package rather than from the bundled config wherever
 * the package can answer, because under Expo Go there is no package of ours at
 * all -- and a development build reporting whatever app.json last said would
 * be telemetry about a file rather than about what is running.
 */

/** The semver. Falls back to the bundled config under Expo Go. */
export const CLIENT_VERSION: string =
  Application.nativeApplicationVersion ??
  (Constants.expoConfig?.version as string | undefined) ??
  '0.0.0';

/**
 * Android's integer, as reported by the installed package.
 *
 * Zero under Expo Go, where there is no installed build of this app to ask.
 * That is the right answer rather than a missing one: zero is below every
 * published build, so the update check offers whatever is on the server, which
 * is exactly what somebody running from a dev server should be told.
 */
export const CLIENT_VERSION_CODE: number = (() => {
  const native = Application.nativeBuildVersion;
  const parsed = native ? Number.parseInt(native, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
})();

/**
 * Which client this is, sent on the socket handshake beside the version.
 *
 * The server keys its "oldest connected build" figure on this. Without it a
 * phone on 0.1.0 would be counted as an ancient desktop client and would make
 * it look like nobody had upgraded the desktop app since it shipped -- which
 * is the one question that telemetry exists to answer.
 */
export const CLIENT_PLATFORM = 'android' as const;

/** The header a REST call carries its version in. Matches the server's. */
export const CLIENT_VERSION_HEADER = 'X-Client-Version';

/**
 * Order two semver strings. -1, 0 or 1 for a < b, a == b, a > b.
 *
 * A third copy of the function in `packages/shared`, and deliberate for the
 * same reason the DTOs are copied -- see the note at the top of `types.ts`.
 * The README already records the desktop client's copy as a decision worth not
 * re-litigating; this is that decision applied again. Change one, change all
 * three. The prerelease rule is the part worth keeping exactly: `1.2.3-beta.1`
 * is *older* than `1.2.3`, not newer.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, ...rest] = v.trim().replace(/^v/i, '').split('+')[0].split('-');
    const nums = (t: string) =>
      t.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
    return { core: nums(core), pre: rest.length ? nums(rest.join('-')) : null };
  };

  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i += 1) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }

  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;

  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const d = (pa.pre[i] ?? 0) - (pb.pre[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
