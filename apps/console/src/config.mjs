import fs from 'node:fs';
import path from 'node:path';

/**
 * Reading and writing the three files a deployment is configured by:
 *
 *   apps/server/.env        what the chat server and the client are told
 *   infra/livekit/*.yaml    which address LiveKit advertises for media
 *   infra/caddy/Caddyfile   the public hostnames, and which service each maps to
 *
 * They have to agree with each other, and when they do not the failure is
 * almost always silent: everyone joins the voice channel, the UI shows them
 * sitting in it, and no audio ever arrives. That is why this module exposes a
 * deployment *mode* rather than a set of independent fields -- picking LAN or
 * internet rewrites all three consistently, instead of leaving someone to
 * remember that LIVEKIT_URL and use_external_ip are two halves of one decision.
 *
 * Secrets are deliberately not writable here. They are read only far enough to
 * report whether they are still a placeholder.
 */

/* --------------------------------------------------------------- reading */

/** Value of `key` in a .env, or null. Quotes stripped, comments ignored. */
export function envValue(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm'));
  if (!m) return null;
  return m[1].trim().replace(/^"(.*)"$/, '$1');
}

/**
 * Replaces `key`'s value, preserving the rest of the line-for-line file --
 * comments in these files carry most of the reasoning and must survive an
 * edit. Appends the key if it is absent.
 */
export function setEnvValue(text, key, value) {
  const line = `${key}="${value}"`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return text.replace(/\s*$/, '') + `\n${line}\n`;
}

/**
 * The two hostnames, matched to the service each proxies to rather than to the
 * order they appear in. Returns nulls when the file is missing or still holds
 * the template's placeholder names.
 */
export function readCaddyHosts(text) {
  const hosts = { chat: null, livekit: null };
  let current = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;

    // Require a dot, so the global block and snippets like (tls443) are skipped.
    const site = line.match(/^([A-Za-z0-9][A-Za-z0-9.\-]*\.[A-Za-z]{2,})\s*\{/);
    if (site) {
      current = site[1];
      continue;
    }
    if (line === '}') {
      current = null;
      continue;
    }
    const proxy = line.match(/^reverse_proxy\s+127\.0\.0\.1:(\d+)/);
    if (current && proxy) {
      if (proxy[1] === '3000') hosts.chat = current;
      if (proxy[1] === '7880') hosts.livekit = current;
    }
  }
  return hosts;
}

/** Rewrites the site-block hostnames, leaving every other line untouched. */
export function writeCaddyHosts(text, { chat, livekit }) {
  const existing = readCaddyHosts(text);
  let out = text;

  for (const [oldHost, newHost] of [
    [existing.chat, chat],
    [existing.livekit, livekit],
  ]) {
    if (!oldHost || !newHost || oldHost === newHost) continue;
    // Only the site-block line, anchored: the old name also appears in the
    // comments at the top of the file, and rewriting those would be wrong the
    // moment the two names stop matching the prose around them.
    out = out.replace(
      new RegExp(`^(\\s*)${escapeRegExp(oldHost)}(\\s*\\{)`, 'm'),
      `$1${newHost}$2`,
    );
  }
  return out;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** node_ip / use_external_ip as they are actually in effect. */
export function readLivekitRtc(text) {
  const rtc = { nodeIp: null, useExternalIp: false };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const ip = line.match(/^node_ip:\s*(\S+)/);
    if (ip && rtc.nodeIp === null) rtc.nodeIp = ip[1];
    const ext = line.match(/^use_external_ip:\s*(true|false)/);
    if (ext) rtc.useExternalIp = ext[1] === 'true';
  }
  return rtc;
}

/**
 * Sets the two rtc address keys.
 *
 * Line by line, and only the first occurrence of each: the file documents both
 * modes and so contains two use_external_ip lines, one of them commented. A
 * global replace sets both and hands LiveKit a duplicate key, which it refuses
 * to start on. Later occurrences are left commented out.
 */
export function writeLivekitRtc(text, { nodeIp, useExternalIp }) {
  let seenNode = false;
  let seenExt = false;

  const lines = text.split(/\r?\n/).map((raw) => {
    const node = raw.match(/^(\s*)#?\s*node_ip:/);
    if (node) {
      const indent = node[1];
      if (seenNode) return raw.replace(/^(\s*)#?\s*/, '$1# ');
      seenNode = true;
      // Under TLS the LAN address is kept as a comment, so the file still
      // records what it was if the deployment moves back.
      return useExternalIp ? `${indent}# node_ip: ${nodeIp ?? ''}`.trimEnd()
                           : `${indent}node_ip: ${nodeIp ?? ''}`.trimEnd();
    }

    const ext = raw.match(/^(\s*)#?\s*use_external_ip:/);
    if (ext) {
      const indent = ext[1];
      if (seenExt) return raw.replace(/^(\s*)#?\s*/, '$1# ');
      seenExt = true;
      return `${indent}use_external_ip: ${useExternalIp}`;
    }

    return raw;
  });

  return lines.join('\r\n');
}

/* -------------------------------------------------------------- assembly */

const PLACEHOLDER_SECRETS = [
  'dev-only-secret-change-me',
  'change-me-to-a-long-random-string',
  'change-me-32-characters-or-longer-please',
  'APIchangeme',
];

export function readConfig(paths) {
  const out = {
    paths,
    env: {},
    livekit: { nodeIp: null, useExternalIp: false, present: false },
    caddy: { chat: null, livekit: null, present: false },
    warnings: [],
  };

  let envText = '';
  if (fs.existsSync(paths.env)) {
    envText = fs.readFileSync(paths.env, 'utf8');
    for (const key of [
      'PORT',
      'VOICE_QUALITY',
      'MAX_UPLOAD_BYTES',
      'LIVEKIT_URL',
      'BETTER_AUTH_URL',
      'UPLOAD_DIR',
    ]) {
      out.env[key] = envValue(envText, key);
    }
    // Reported, never returned: the console is loopback-only, but there is no
    // reason for a secret to travel to a browser at all.
    for (const key of ['BETTER_AUTH_SECRET', 'LIVEKIT_API_SECRET', 'LIVEKIT_API_KEY']) {
      const v = envValue(envText, key);
      if (v && PLACEHOLDER_SECRETS.some((p) => v.includes(p))) {
        out.warnings.push(`${key} is still a placeholder. Anyone can forge a session token.`);
      }
    }
  } else {
    out.warnings.push(`No .env at ${paths.env}. The server cannot start without one.`);
  }

  if (fs.existsSync(paths.livekit)) {
    out.livekit = { ...readLivekitRtc(fs.readFileSync(paths.livekit, 'utf8')), present: true };
  }

  if (fs.existsSync(paths.caddyfile)) {
    out.caddy = { ...readCaddyHosts(fs.readFileSync(paths.caddyfile, 'utf8')), present: true };
  }

  out.mode = out.livekit.useExternalIp ? 'internet' : 'lan';
  out.warnings.push(...consistencyWarnings(out));
  return out;
}

/**
 * The checks worth making, because each of these disagreements presents as a
 * call that connects and carries no audio rather than as an error.
 */
export function consistencyWarnings(cfg) {
  const warnings = [];
  const url = cfg.env.LIVEKIT_URL ?? '';

  if (cfg.mode === 'internet') {
    if (url.startsWith('ws://')) {
      warnings.push(
        'LiveKit is advertising a public address but LIVEKIT_URL is still ws://. ' +
          'Clients would be told to reach voice over plaintext.',
      );
    }
    if (cfg.caddy.livekit && !url.includes(cfg.caddy.livekit)) {
      warnings.push(
        `LIVEKIT_URL does not point at ${cfg.caddy.livekit}, which is the hostname Caddy serves LiveKit on.`,
      );
    }
  } else {
    if (url.startsWith('wss://')) {
      warnings.push(
        'LIVEKIT_URL is a public wss:// address but LiveKit is configured for the LAN. ' +
          'Voice will connect and stay silent for anyone outside.',
      );
    }
  }
  return warnings;
}

/* --------------------------------------------------------------- writing */

const QUALITIES = ['voice', 'balanced', 'high', 'studio'];
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function validate(patch) {
  const errors = [];

  if (patch.mode && !['lan', 'internet'].includes(patch.mode)) {
    errors.push('Mode must be lan or internet.');
  }
  if (patch.port !== undefined) {
    const p = Number(patch.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) errors.push('Port must be between 1 and 65535.');
  }
  if (patch.voiceQuality && !QUALITIES.includes(patch.voiceQuality)) {
    errors.push(`Voice quality must be one of ${QUALITIES.join(', ')}.`);
  }
  if (patch.maxUploadBytes !== undefined) {
    const n = Number(patch.maxUploadBytes);
    if (!Number.isFinite(n) || n < 1024) errors.push('Upload limit must be at least 1 KB.');
  }
  if (patch.mode === 'lan' && patch.lanIp !== undefined && !IPV4.test(String(patch.lanIp))) {
    errors.push('LAN address must be an IPv4 address.');
  }
  for (const [field, label] of [['chatHost', 'Chat hostname'], ['livekitHost', 'LiveKit hostname']]) {
    if (patch[field] && !HOSTNAME.test(patch[field])) {
      errors.push(`${label} is not a valid hostname.`);
    }
  }
  if (patch.mode === 'internet' && patch.chatHost && patch.chatHost === patch.livekitHost) {
    errors.push(
      'The two hostnames must differ. LiveKit gets its own name because the client ' +
        'SDK opens its socket at the root of whatever host it is given.',
    );
  }
  return errors;
}

/**
 * Applies a patch across all three files. Returns the paths it wrote, so the
 * UI can say what changed rather than claiming a blanket success.
 */
export function writeConfig(paths, patch) {
  const errors = validate(patch);
  if (errors.length) return { ok: false, errors };

  const written = [];
  const cfg = readConfig(paths);
  const mode = patch.mode ?? cfg.mode;

  const chatHost = patch.chatHost ?? cfg.caddy.chat;
  const livekitHost = patch.livekitHost ?? cfg.caddy.livekit;
  const port = patch.port ?? cfg.env.PORT ?? 3000;
  const lanIp = patch.lanIp ?? cfg.livekit.nodeIp;

  if (mode === 'internet' && (!chatHost || !livekitHost)) {
    return {
      ok: false,
      errors: ['Internet mode needs both hostnames. Set them before switching.'],
    };
  }
  if (mode === 'lan' && !lanIp) {
    return { ok: false, errors: ['LAN mode needs this machine\'s address on the network.'] };
  }

  /* .env */
  if (fs.existsSync(paths.env)) {
    let text = fs.readFileSync(paths.env, 'utf8');
    if (patch.port !== undefined) text = setEnvValue(text, 'PORT', port);
    if (patch.voiceQuality) text = setEnvValue(text, 'VOICE_QUALITY', patch.voiceQuality);
    if (patch.maxUploadBytes !== undefined) {
      text = setEnvValue(text, 'MAX_UPLOAD_BYTES', Math.round(Number(patch.maxUploadBytes)));
    }

    // The two derived values. Written together with the mode, never
    // separately, because separately is how they drift.
    text = setEnvValue(
      text,
      'LIVEKIT_URL',
      mode === 'internet' ? `wss://${livekitHost}` : `ws://${lanIp}:7880`,
    );
    text = setEnvValue(
      text,
      'BETTER_AUTH_URL',
      mode === 'internet' ? `https://${chatHost}` : `http://${lanIp}:${port}`,
    );

    fs.writeFileSync(paths.env, text);
    written.push(paths.env);
  }

  /* livekit.yaml */
  if (fs.existsSync(paths.livekit)) {
    const text = fs.readFileSync(paths.livekit, 'utf8');
    const next = writeLivekitRtc(text, { nodeIp: lanIp, useExternalIp: mode === 'internet' });
    if (next !== text) {
      fs.writeFileSync(paths.livekit, next);
      written.push(paths.livekit);
    }
  }

  /* Caddyfile */
  if (fs.existsSync(paths.caddyfile) && chatHost && livekitHost) {
    const text = fs.readFileSync(paths.caddyfile, 'utf8');
    const next = writeCaddyHosts(text, { chat: chatHost, livekit: livekitHost });
    if (next !== text) {
      fs.writeFileSync(paths.caddyfile, next);
      written.push(paths.caddyfile);
    }
  }

  return { ok: true, written, config: readConfig(paths) };
}

/** Where the three files live, in a repo checkout or an installed copy. */
export function resolvePaths(root, consoleDir) {
  const candidates = {
    env: [path.join(root, 'apps/server/.env'), path.resolve(consoleDir, '../../server/.env')],
    livekit: [
      path.join(root, 'infra/livekit/livekit.yaml'),
      path.resolve(consoleDir, '../../livekit/livekit.yaml'),
    ],
    caddyfile: [
      path.join(root, 'infra/caddy/Caddyfile'),
      path.resolve(consoleDir, '../../caddy/Caddyfile'),
    ],
  };

  const out = {};
  for (const [key, list] of Object.entries(candidates)) {
    out[key] = list.find((p) => fs.existsSync(p)) ?? list[0];
  }
  return out;
}
