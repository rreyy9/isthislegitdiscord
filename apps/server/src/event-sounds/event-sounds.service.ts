import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  EVENT_SOUND_EVENTS,
  EventSoundSlot,
  type EventSoundEvent,
  type EventSoundsConfig,
  type SetEventSoundInput,
} from '@isthislegit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ChatGateway } from '../gateway/chat.gateway';
import { newId } from '../common/ids';

/** Where the table lives in ServerSetting. */
const CONFIG_KEY = 'eventSounds';
/** One row per uploaded file, beside the table. */
const FILE_KEY = (id: string) => `eventSoundFile:${id}`;

interface StoredFile {
  contentType: string;
  name: string;
  /** The bytes, base64. */
  data: string;
}

export function emptyEventSounds(): EventSoundsConfig {
  return { join: null, leave: null, away: null };
}

/**
 * Whatever the row held, as something every field of can be trusted. A slot
 * that no longer parses -- a built-in file this version stopped shipping, say
 * -- becomes no sound rather than a broken one.
 */
export function normalizeEventSounds(stored: unknown): EventSoundsConfig {
  const out = emptyEventSounds();
  if (!stored || typeof stored !== 'object') return out;
  for (const event of EVENT_SOUND_EVENTS) {
    const parsed = EventSoundSlot.safeParse((stored as Record<string, unknown>)[event]);
    if (parsed.success) out[event] = parsed.data;
  }
  return out;
}

/**
 * What an uploaded file really is, from its first bytes. The name and the
 * type the browser claimed are ignored: what is served back is labelled from
 * this, and anything this does not recognise is refused.
 */
export function sniffAudio(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  const ascii = (start: number, end: number) =>
    bytes.subarray(start, end).toString('latin1');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'audio/webm';
  }
  return null;
}

/**
 * The server's event sounds: which sound plays to a voice channel when
 * somebody joins it, leaves it or goes away in it.
 *
 * Stored in ServerSetting, uploads included, rather than in the upload
 * directory: the files are small, at most three are in use at once, they
 * belong in the database backup with the table that points at them, and the
 * upload sweeper deletes anything in that directory that no Attachment row or
 * avatar points at.
 *
 * The server only keeps the table. Each client plays the sound itself, from
 * what LiveKit and presence already tell it -- see the desktop's Chat.tsx.
 */
@Injectable()
export class EventSoundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ChatGateway,
  ) {}

  async config(): Promise<EventSoundsConfig> {
    const row = await this.prisma.serverSetting.findUnique({
      where: { key: CONFIG_KEY },
    });
    return normalizeEventSounds(row?.value);
  }

  async set(
    event: EventSoundEvent,
    input: SetEventSoundInput,
  ): Promise<EventSoundsConfig> {
    const config = await this.config();
    const current = config[event];

    if (input.source === 'none') {
      config[event] = null;
    } else if (input.source === 'builtin') {
      config[event] = { source: 'builtin', file: input.file, volume: input.volume };
    } else {
      if (current?.source !== 'custom') {
        throw new BadRequestException('Upload a sound for this event first.');
      }
      config[event] = { ...current, volume: input.volume };
    }

    await this.save(config);
    if (current?.source === 'custom' && config[event]?.source !== 'custom') {
      await this.dropFile(current.id);
    }
    return config;
  }

  /** Store an uploaded file and make it this event's sound. */
  async upload(
    event: EventSoundEvent,
    file: { buffer: Buffer; originalname: string },
  ): Promise<EventSoundsConfig> {
    const contentType = sniffAudio(file.buffer);
    if (!contentType) {
      throw new BadRequestException(
        'That is not a sound file this app can play (WAV, MP3, OGG, FLAC, M4A or WebM).',
      );
    }

    const config = await this.config();
    const previous = config[event];
    const id = newId();
    // Shown on the settings page and nowhere else; trimmed so a path or a
    // very long name cannot crowd the row.
    const name = (file.originalname.split(/[\\/]/).pop() || 'sound').slice(0, 100);

    const stored: StoredFile = {
      contentType,
      name,
      data: file.buffer.toString('base64'),
    };
    await this.prisma.serverSetting.create({
      data: { key: FILE_KEY(id), value: stored as never },
    });

    config[event] = {
      source: 'custom',
      id,
      name,
      // Keep the volume already set for this event: a new file is a new
      // sound, not a reason to start the slider over.
      volume: previous?.volume ?? 0.6,
    };
    await this.save(config);
    if (previous?.source === 'custom') await this.dropFile(previous.id);
    return config;
  }

  async file(id: string): Promise<{ contentType: string; bytes: Buffer }> {
    // Ids are ours, so anything not shaped like one is not worth a query.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new NotFoundException('No such sound.');
    }
    const row = await this.prisma.serverSetting.findUnique({
      where: { key: FILE_KEY(id) },
    });
    const value = row?.value as Partial<StoredFile> | undefined;
    if (!value?.data || !value.contentType) {
      throw new NotFoundException('No such sound.');
    }
    return {
      contentType: value.contentType,
      bytes: Buffer.from(value.data, 'base64'),
    };
  }

  private async save(config: EventSoundsConfig) {
    await this.prisma.serverSetting.upsert({
      where: { key: CONFIG_KEY },
      create: { key: CONFIG_KEY, value: config as never },
      update: { value: config as never },
    });
    this.gateway.broadcastEventSounds(config);
  }

  /** Best-effort: a row that will not delete is a wasted row, not an error. */
  private async dropFile(id: string) {
    await this.prisma.serverSetting
      .deleteMany({ where: { key: FILE_KEY(id) } })
      .catch(() => undefined);
  }
}
