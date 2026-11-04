import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import {
  BUILTIN_EVENT_SOUNDS,
  EVENT_SOUND_EVENTS,
  MAX_EVENT_SOUND_BYTES,
  emptyUserSounds,
  type EventSoundEvent,
  type EventSoundSlot,
  type EventSoundsConfig,
  type SetEventSoundBody,
} from '../event-sounds';
import { previewEventSound } from '../sound-player';
import { Avatar } from './Avatar';

/**
 * Settings → Server sounds. Admins only: the page is not in the nav for
 * anybody else, and the server refuses the changes from anybody else anyway.
 *
 * One card per person the admin has given sounds to, and within it one row
 * per event: what plays, how loud, and a button to hear it. Saved as it
 * changes, like the rest of the settings screen, and announced to every client
 * by the server -- so the next time that person walks into a channel, the
 * others already get the new sound.
 */

const DEFAULT_VOLUME = 0.6;

export interface SoundPerson {
  id: string;
  name: string;
  image: string | null;
}

export function ServerSoundSettings({
  config,
  people,
  onChange,
}: {
  config: EventSoundsConfig;
  /** Everybody on the server, to pick from. */
  people: SoundPerson[];
  onChange: (next: EventSoundsConfig) => void;
}) {
  // Picked from the list but not given a sound yet, so not in the table.
  const [added, setAdded] = useState<string[]>([]);
  const byId = new Map(people.map((p) => [p.id, p]));

  const listed = [...new Set([...Object.keys(config.users), ...added])]
    .map((id) => byId.get(id) ?? { id, name: 'Someone no longer here', image: null })
    .sort((a, b) => a.name.localeCompare(b.name));
  const listedIds = new Set(listed.map((p) => p.id));
  const addable = people
    .filter((p) => !listedIds.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <section className="set-group">
        <h4>Sounds for particular people</h4>
        <div className="hint">
          Give someone their own sound for joining a voice channel, leaving it
          or going away in it. Everybody else in that channel hears it, and
          nobody can switch it off — their own sound settings, volume and deafen
          do not apply. Only people in that channel hear it. It replaces the
          usual join or leave sound for that person, so nobody hears two.
          People without one here get the usual sounds. Direct message calls
          are not affected. Uploads can be WAV, MP3, OGG, FLAC, M4A or WebM, up
          to 1 MB; keep them to a second or two.
        </div>
        <label className="row-label" htmlFor="event-sound-add">
          Add a person
        </label>
        <select
          id="event-sound-add"
          value=""
          disabled={addable.length === 0}
          onChange={(e) => {
            const id = e.target.value;
            if (id) setAdded((prev) => [...prev, id]);
          }}
        >
          <option value="">
            {addable.length === 0 ? 'Everyone is already listed' : 'Choose someone…'}
          </option>
          {addable.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </section>

      {listed.length === 0 && (
        <section className="set-group">
          <div className="hint">Nobody has a sound yet.</div>
        </section>
      )}

      {listed.map((person) => (
        <PersonCard
          key={person.id}
          person={person}
          config={config}
          onChange={onChange}
          onRemoved={() => setAdded((prev) => prev.filter((id) => id !== person.id))}
        />
      ))}
    </>
  );
}

function PersonCard({
  person,
  config,
  onChange,
  onRemoved,
}: {
  person: SoundPerson;
  config: EventSoundsConfig;
  onChange: (next: EventSoundsConfig) => void;
  onRemoved: () => void;
}) {
  const sounds = config.users[person.id] ?? emptyUserSounds();
  const saved = person.id in config.users;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setError(null);
    if (!saved) return onRemoved();
    setBusy(true);
    try {
      onChange(await api.clearEventSounds(person.id));
      onRemoved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="set-group event-sound-person">
      <div className="event-sound-person-head">
        <Avatar name={person.name} image={person.image} className="tiny" />
        <h4>{person.name}</h4>
        <button type="button" disabled={busy} onClick={() => void remove()}>
          Remove
        </button>
      </div>
      {error && <div className="hint event-sound-error">{error}</div>}
      {EVENT_SOUND_EVENTS.map((e) => (
        <EventRow
          key={e.id}
          userId={person.id}
          event={e.id}
          label={e.label}
          hint={e.hint}
          slot={sounds[e.id]}
          onChange={onChange}
        />
      ))}
    </section>
  );
}

function EventRow({
  userId,
  event,
  label,
  hint,
  slot,
  onChange,
}: {
  userId: string;
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
      onChange(await api.setEventSound(userId, event, body));
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
      onChange(await api.uploadEventSound(userId, event, file));
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
  const inputId = `event-sound-${userId}-${event}`;

  return (
    <div className="event-sound-event">
      <div className="row-label">{label}</div>
      <div className="hint inline">{hint}</div>

      <div className="event-sound-row">
        <select
          value={selected}
          disabled={busy}
          aria-label={label}
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

      <label className="row-label" htmlFor={inputId}>
        Volume: {Math.round(volume * 100)}%
      </label>
      <input
        id={inputId}
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
    </div>
  );
}
