import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { ConsoleLogger } from '@nestjs/common';

/**
 * Everything Nest logs, also written to a file that survives the window
 * closing.
 *
 * Until this existed, every log line in this deployment went to a console and
 * nowhere else. Each service runs in its own window on purpose -- see
 * start-all.ps1 -- and that is fine for watching something happen, and no use
 * at all for anything that happened while nobody was watching. A hundred
 * thousand failed logins overnight looked exactly like a quiet night, and
 * still would after a restart cleared the scrollback.
 *
 * This is a log file, not observability. There is no metric, no alert and
 * nothing that reaches a phone. What it buys is the ability to answer "what
 * happened last Tuesday" at all, which is the step that has to come first, and
 * it is the reason `login-throttle.ts` bothers to log a blocked address.
 *
 * Deliberately not a dependency. `winston` and `pino` both solve a much larger
 * problem than one file per day on a box with ten users, and this is thirty
 * lines that cannot break the server.
 */

/** Where logs go. Beside `data/uploads`, and settable the same way. */
export const LOG_DIR = path.resolve(
  process.env.LOG_DIR ?? path.join(process.cwd(), '..', '..', 'data', 'logs'),
);

/** Days of logs to keep. Small: these are text, but they are also forever. */
const KEEP_DAYS = Number(process.env.LOG_KEEP_DAYS ?? 30);

/** `2026-09-08`, in local time, because that is the clock the operator reads. */
function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function logFileFor(day: string): string {
  return path.join(LOG_DIR, `server-${day}.log`);
}

/**
 * Delete log files past the retention window.
 *
 * Matched by filename rather than mtime: a file's timestamp moves when it is
 * touched or copied, and the day in the name is the day the lines are from.
 * Only files this logger could have written are considered, so nothing else
 * that ends up in the directory is ever a candidate for deletion -- the file
 * sweeper's lesson, in miniature. When a directory has more than one kind of
 * owner, the sweep has to ask all of them; here it asks none, because it only
 * removes what it can prove it wrote.
 */
export function pruneLogs(dir = LOG_DIR, keepDays = KEEP_DAYS, now = new Date()): string[] {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffDay = today(cutoff);

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }

  const removed: string[] = [];
  for (const name of names) {
    const m = name.match(/^server-(\d{4}-\d{2}-\d{2})\.log$/);
    if (!m) continue;
    // String comparison is date comparison for this format, which is the only
    // reason it is written this way round.
    if (m[1] >= cutoffDay) continue;
    try {
      unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      // A file being read by something else is not worth failing a boot over.
    }
  }
  return removed;
}

/** One line, in the shape the console prints. */
export function formatLine(
  level: string,
  message: unknown,
  context?: string,
  now = new Date(),
): string {
  const text =
    typeof message === 'string'
      ? message
      : message instanceof Error
        ? (message.stack ?? message.message)
        : (() => {
            try {
              return JSON.stringify(message);
            } catch {
              // A circular object should not be able to take the logger down.
              return String(message);
            }
          })();
  const where = context ? ` [${context}]` : '';
  return `${now.toISOString()} ${level.toUpperCase().padEnd(7)}${where} ${text}\n`;
}

export class FileLogger extends ConsoleLogger {
  private day = '';
  private file = '';
  /** Said once. A logger that cannot write must not shout about it per line. */
  private complained = false;

  private write(level: string, message: unknown, context?: string) {
    try {
      const now = new Date();
      const day = today(now);
      if (day !== this.day) {
        // Rolls at midnight, and on the first line after a restart. Doing it
        // here rather than on a timer means a server that sits idle over the
        // boundary still writes tomorrow's lines to tomorrow's file.
        mkdirSync(LOG_DIR, { recursive: true });
        this.day = day;
        this.file = logFileFor(day);
        pruneLogs();
      }
      appendFileSync(this.file, formatLine(level, message, context, now));
    } catch (err) {
      if (!this.complained) {
        this.complained = true;
        // Straight to the console, not through this class, or a failing write
        // would recurse.
        // eslint-disable-next-line no-console
        console.error(`[FileLogger] cannot write to ${LOG_DIR}:`, err);
      }
    }
  }

  /*
   * Each of these calls super first, so the console output is exactly what it
   * was before this class existed. Nest's own signatures take a rest parameter
   * whose last element may be the context, which is why the context is picked
   * off the end rather than named.
   */
  private contextOf(rest: unknown[]): string | undefined {
    const last = rest[rest.length - 1];
    return typeof last === 'string' ? last : undefined;
  }

  log(message: unknown, ...rest: unknown[]) {
    super.log(message as never, ...(rest as never[]));
    this.write('log', message, this.contextOf(rest));
  }

  error(message: unknown, ...rest: unknown[]) {
    super.error(message as never, ...(rest as never[]));
    this.write('error', message, this.contextOf(rest));
  }

  warn(message: unknown, ...rest: unknown[]) {
    super.warn(message as never, ...(rest as never[]));
    this.write('warn', message, this.contextOf(rest));
  }

  debug(message: unknown, ...rest: unknown[]) {
    super.debug(message as never, ...(rest as never[]));
    this.write('debug', message, this.contextOf(rest));
  }

  verbose(message: unknown, ...rest: unknown[]) {
    super.verbose(message as never, ...(rest as never[]));
    this.write('verbose', message, this.contextOf(rest));
  }
}
