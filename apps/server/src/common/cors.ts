/**
 * Which origins the browser-facing surfaces (HTTP API and Socket.IO) will
 * answer with credentials.
 *
 * This used to be `origin: true`, which reflects whatever origin asked and so
 * allows all of them. What made that survivable is that the desktop client
 * authenticates with a bearer token rather than a cookie -- see the `bearer()`
 * note in auth.factory.ts -- so a hostile page could not ride an existing
 * session the way it could if the credential were a cookie. It is still an
 * open door to every unauthenticated route, and to anything that later starts
 * trusting a cookie, so it is now a list.
 *
 * Two cases are deliberately allowed and are the reason this is not a plain
 * string array in `enableCors`:
 *
 * - **No `Origin` header at all.** Browsers always send one on a cross-origin
 *   request; something with no origin is a native client, the console, curl,
 *   or a same-origin navigation. Refusing those breaks the console and every
 *   health probe while stopping no attack.
 * - **The literal string `null`.** A packaged desktop client renders from
 *   `file://`, and Chromium serialises that origin as `null`. Refusing it
 *   breaks every installed client, which is the entire user base. It is the
 *   weakest entry in the list -- a sandboxed iframe on a hostile page also
 *   gets `null` -- and it is tolerable only because of the bearer-token point
 *   above. If session cookies ever become the credential, this entry has to go
 *   and the client has to move to a custom scheme.
 */

/** Origins allowed when `CORS_ORIGINS` is unset: the clients this repo ships. */
export const DEFAULT_ALLOWED_ORIGINS = [
  // Packaged Electron renderer (file://).
  'null',
  // `electron-vite dev` renderer.
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

/**
 * Split a `CORS_ORIGINS` value. Comma or whitespace separated, so a value can
 * be written on one line in `.env` or across several in a shell.
 *
 * Trailing slashes are dropped because an origin has no path, and a browser
 * sends `https://example.com`, never `https://example.com/` -- a config typo
 * that would otherwise fail as a silent mismatch, which is the failure mode
 * this whole module is trying not to have.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULT_ALLOWED_ORIGINS];
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : [...DEFAULT_ALLOWED_ORIGINS];
}

/**
 * The predicate both `enableCors` and the Socket.IO gateway ask.
 *
 * Matching is exact and case-insensitive on the scheme and host, which is what
 * an origin comparison is. No wildcards and no prefix matching: `*.example.com`
 * style rules are how an allowlist quietly starts matching
 * `example.com.attacker.net`.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined || origin === '') return true;
  const candidate = origin.trim().replace(/\/+$/, '').toLowerCase();
  return allowed.some((a) => a.toLowerCase() === candidate);
}

/** The allowlist for this process, read once. */
export function allowedOrigins(): string[] {
  return parseAllowedOrigins(process.env.CORS_ORIGINS);
}
