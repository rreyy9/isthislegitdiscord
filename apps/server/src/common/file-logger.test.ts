import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatLine, pruneLogs } from './file-logger';

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'itl-logs-'));
}

describe('formatLine', () => {
  const at = new Date('2026-09-08T12:00:00.000Z');

  it('writes a timestamp, a level and the context', () => {
    expect(formatLine('warn', 'rate limited 1.2.3.4', 'login', at)).toBe(
      '2026-09-08T12:00:00.000Z WARN    [login] rate limited 1.2.3.4\n',
    );
  });

  it('works without a context', () => {
    expect(formatLine('log', 'listening', undefined, at)).toBe(
      '2026-09-08T12:00:00.000Z LOG     listening\n',
    );
  });

  it('keeps the stack when handed an Error', () => {
    const line = formatLine('error', new Error('boom'), 'ctx', at);
    expect(line).toContain('Error: boom');
    expect(line).toContain('file-logger.test.ts');
  });

  it('does not throw on a circular object', () => {
    // A logger that can be crashed by what it is asked to log is worse than no
    // logger, because it takes the request down with it.
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => formatLine('log', circular, undefined, at)).not.toThrow();
  });

  it('ends with exactly one newline, so lines stay one per line', () => {
    const line = formatLine('log', 'x', undefined, at);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.match(/\n/g)).toHaveLength(1);
  });
});

describe('pruneLogs', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');

  it('removes logs past the window and keeps the rest', () => {
    const dir = scratch();
    for (const day of ['2026-09-08', '2026-09-05', '2026-08-08', '2026-07-01']) {
      writeFileSync(path.join(dir, `server-${day}.log`), 'x');
    }
    pruneLogs(dir, 7, now);
    expect(readdirSync(dir).sort()).toEqual([
      'server-2026-09-05.log',
      'server-2026-09-08.log',
    ]);
  });

  it('touches nothing it did not write', () => {
    // The lesson from the file sweeper that deleted every avatar: a directory
    // can have more than one kind of owner, so only remove what you can prove
    // is yours.
    const dir = scratch();
    writeFileSync(path.join(dir, 'server-2020-01-01.log'), 'x');
    writeFileSync(path.join(dir, 'notes.txt'), 'x');
    writeFileSync(path.join(dir, 'server.log'), 'x');
    writeFileSync(path.join(dir, 'caddy-2020-01-01.log'), 'x');
    const removed = pruneLogs(dir, 7, now);
    expect(removed).toEqual(['server-2020-01-01.log']);
    expect(readdirSync(dir).sort()).toEqual([
      'caddy-2020-01-01.log',
      'notes.txt',
      'server.log',
    ]);
  });

  it('keeps today when the window is zero days', () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'server-2026-09-08.log'), 'x');
    writeFileSync(path.join(dir, 'server-2026-09-07.log'), 'x');
    pruneLogs(dir, 0, now);
    expect(readdirSync(dir)).toEqual(['server-2026-09-08.log']);
  });

  it('is quiet about a directory that does not exist', () => {
    // It runs on the first line logged, which is before anything has been
    // written, and a boot must not fail because there is nothing to prune.
    expect(pruneLogs(path.join(tmpdir(), 'itl-logs-does-not-exist'), 7, now)).toEqual([]);
  });
});
