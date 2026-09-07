/**
 * Compare two dotted versions. Positive when `a` is newer than `b`.
 *
 * Written out rather than compared as strings, because "0.10.0" < "0.9.0" is
 * true of strings and false of versions -- and the first time that matters is
 * the tenth release, by which point the wrong answer looks like a client that
 * refuses to update.
 *
 * A copy of the one in `packages/shared`, deliberately. This app imports
 * nothing from that package -- it redeclares the DTOs it needs, and adding a
 * workspace dependency here would put a build step between electron-vite and
 * a twelve-line pure function. If one of the two ever changes, change both.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    // Build metadata (1.2.3+abc) is not part of ordering at all.
    const [core, ...rest] = v.trim().replace(/^v/i, '').split('+')[0].split('-');
    const nums = (t: string) =>
      t.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
    return {
      core: nums(core),
      // A prerelease sorts BELOW the release it precedes: 1.2.3-beta.1 is
      // older than 1.2.3, not newer. Treating the suffix as just more numbers
      // gets this backwards, which would offer a beta as an upgrade over the
      // final build and refuse to publish the final build over the beta.
      pre: rest.length ? nums(rest.join('-')) : null,
    };
  };

  const pa = parse(a);
  const pb = parse(b);

  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i += 1) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d;
  }

  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;

  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i += 1) {
    const d = (pa.pre[i] ?? 0) - (pb.pre[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
