import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { maxUploadBytes } from '../attachments/storage';

/**
 * Says what the attachment limit actually is when an upload passes it.
 *
 * Multer refuses an oversized file with the bare string "File too large",
 * which is the less useful half of the answer. Without the number, somebody
 * who has just raised the limit on the server and still cannot send a file has
 * no way to tell whether the change did not take effect or whether the file is
 * genuinely over the new limit -- and those want opposite next steps.
 *
 * Read at the time of the refusal, not at import, for the reason spelled out
 * above `maxUploadBytes` in the storage layer.
 */
@Catch(PayloadTooLargeException)
export class UploadLimitFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.status(413).json({
      statusCode: 413,
      error: 'Payload Too Large',
      message:
        `That file is over this server's attachment limit of ` +
        `${describeBytes(maxUploadBytes())}.`,
    });
  }
}

/** Bytes as somebody would say them. Whole units above a gigabyte. */
export function describeBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}
