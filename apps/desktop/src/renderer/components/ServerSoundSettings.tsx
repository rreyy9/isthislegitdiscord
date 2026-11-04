import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  BUILTIN_EVENT_SOUNDS,
  EVENT_SOUND_EVENTS,
  MAX_EVENT_SOUND_BYTES,
  type EventSoundEvent,
  type EventSoundSlot,
  type EventSoundsConfig,
  type SetEventSoundBody,
} from '../event-sounds';
import { previewEventSound } from '../sound-player';

/**
 * Settings → Server sounds. Admins only: the page is not in the nav for
 * anybody else, and the server refuses the changes from anybody else anyway.
 *
 * One row per event: what plays, how loud, and a button to hear it. Saved as
 * it changes, like the rest of the settings screen, and announced to every
 * client by the server -- so the next person to walk into a channel already
 * gets the new sound.
 */

const DEFAULT_VOLUME = 0.6;

export function ServerSoundSettings({
  config,
  onChange,
}: {
  config: EventSoundsConfig;
  onChange: (next: EventSoundsConfig) => void;
}) {
  return (
    <>
      <section className="set-group">
        <h4>Sounds everyone hears</h4>
        <div className="hint">
          These play to everybody in a server voice channel, and nobody can
          switch them off — their own sound settings, volume and deafen do not
          apply. Only people in that channel hear them. Where one is set it
          replaces each person's own join or leave sound, so nobody hears two.
          Direct message calls are not affected. Uploads can be WAV, MP3, OGG,
          FLAC, M4A or WebM, up to 1 MB; keep them to a second or two.
        </div>
      </section>
      {EVENT_SOUND_EVENTS.map((e) => (
        <EventRow
          key={e.id}
          event={e.id}
          label={e.label}
          hint={e.hint}
          slot={config[e.id]}
          onChange={onChange}
        />
      ))}
    </>
  );
}

function EventRow({
  event,
  label,
  hint,
  slot,
  onChange,
}: {
  event: EventSoundEvent;
  label: string;
  hint: string;
  slot: EventSoundSlot | null;
  onChange: (next: EventSoundsConfig) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // The slider moves locally and saves once it settles, rather than one
  // request per pixel dragged.
  const [volume, setVolume] = useState(slot?.volume ?? DEFAULT_VOLUME);
  useEffect(() => setVolume(slot?.volume ?? DEFAULT_VOLUME), [slot?.volume]);
  const volumeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (volumeTimer.current !== null) window.clearTimeout(volumeTimer.current);
    },
    [],
  );

  async function save(body: SetEventSoundBody) {
    setError(null);
    setBusy(true);
    try {
      onChange(await api.setEventSound(event, body));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_EVENT_SOUND_BYTES) {
      setError('That file is over the 1 MB limit for a sound.');
      return;
    }
    setBusy(true);
    try {
      onChange(await api.uploadEventSound(event, file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function pick(value: string) {
    if (value === 'none') return void save({ source: 'none' });
    if (value === 'custom') return; // Already the uploaded file.
    void save({ source: 'builtin', file: value, volume });
  }

  function changeVolume(next: number) {
    setVolume(next);
    if (!slot) return;
    if (volumeTimer.current !== null) window.clearTimeout(volumeTimer.current);
    volumeTimer.current = window.setTimeout(() => {
      volumeTimer.current = null;
      void save(
        slot.source === 'custom'
          ? { source: 'custom', volume: next }
          : { source: 'builtin', file: slot.file, volume: next },
      );
    }, 300);
  }

  const selected =
    slot === null ? 'none' : slot.source === 'custom' ? 'custom' : slot.file;

  return (
    <section className="set-group">
      <h4>{label}</h4>
      <div className="hint inline">{hint}</div>

      <div className="event-sound-row">
        <select
          value={selected}
          disabled={busy}
          onChange={(e) => pick(e.target.value)}
        >
          <option value="none">No sound</option>
          {slot?.source === 'custom' && (
            <option value="custom">Uploaded: {slot.name}</option>
          )}
          {BUILTIN_EVENT_SOUNDS.map((s) => (
            <option key={s.file} value={s.file}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="sound-play"
          title="Play this sound"
          aria-label={`Play: ${label}`}
          disabled={!slot}
          onClick={() => slot && previewEventSound({ ...slot, volume })}
        >
          ▶
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          Upload a sound…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.webm"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Cleared so picking the same file again still fires a change.
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
      </div>

      <label className="row-label" htmlFor={`event-sound-${event}`}>
        Volume: {Math.round(volume * 100)}%
      </label>
      <input
        id={`event-sound-${event}`}
        className="slider"
        type="range"
        min={0}
        max={100}
        step={5}
        disabled={!slot}
        value={Math.round(volume * 100)}
        onChange={(e) => changeVolume(Number(e.target.value) / 100)}
      />

      {error && <div className="hint event-sound-error">{error}</div>}
    </section>
  );
}
