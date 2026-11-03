import {
  SOUND_GROUPS,
  SOUNDS,
  type GuildSoundOverride,
  type NotificationSettings,
  type SoundSwitches,
} from '../../sound-events';
import { previewSound } from '../sound-player';

/**
 * Settings → Notifications: the desktop notification for tags, and every
 * sound the app makes.
 *
 * The sound half follows Mumble's Messages page: a row per event with its own
 * switch and a button to hear it, under one master switch and one volume.
 * Servers may be silenced or given a table of their own below that.
 *
 * Every control saves as it changes, like the rest of the settings screen.
 */

type Guild = { id: string; name: string };

/** One switch per event, grouped the way the events are. */
function SoundTable({
  switches,
  disabled,
  onChange,
}: {
  switches: SoundSwitches;
  disabled: boolean;
  onChange: (next: SoundSwitches) => void;
}) {
  return (
    <div className={`sound-table${disabled ? ' off' : ''}`}>
      {SOUND_GROUPS.map((g) => (
        <div key={g.id} className="sound-group">
          <h5>{g.label}</h5>
          {SOUNDS.filter((s) => s.group === g.id).map((s) => (
            <div key={s.id} className="sound-row">
              <label>
                <input
                  type="checkbox"
                  checked={switches[s.id]}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({ ...switches, [s.id]: e.target.checked })
                  }
                />
                {s.label}
              </label>
              <button
                type="button"
                className="sound-play"
                title="Play this sound"
                aria-label={`Play: ${s.label}`}
                onClick={() => previewSound(s.id)}
              >
                ▶
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function NotificationSettingsPage({
  notifications,
  guilds,
  onChange,
}: {
  notifications: NotificationSettings;
  guilds: Guild[];
  onChange: (patch: Partial<NotificationSettings>) => void;
}) {
  const n = notifications;

  function setOverride(guildId: string, next: GuildSoundOverride | null) {
    const { [guildId]: _old, ...rest } = n.guildSounds;
    onChange({ guildSounds: next ? { ...rest, [guildId]: next } : rest });
  }

  return (
    <>
      <section className="set-group">
        <h4>When someone tags you or sends a DM</h4>
        <label className="row-label">
          <input
            type="checkbox"
            checked={n.mentions}
            onChange={(e) => onChange({ mentions: e.target.checked })}
          />
          Show a desktop notification
        </label>
        <div className="hint">
          Held back for a message already on screen in a window you are looking
          at. Nothing here can override the operating system: if notifications
          are switched off for this app in Windows settings, the taskbar button
          still flashes and the sound still plays.
        </div>
      </section>

      <section className="set-group">
        <h4>Sounds</h4>
        <label className="row-label">
          <input
            type="checkbox"
            checked={n.sound}
            onChange={(e) => onChange({ sound: e.target.checked })}
          />
          Play sounds
        </label>

        <label className="row-label" htmlFor="sound-volume">
          Volume: {Math.round(n.soundVolume * 100)}%
        </label>
        <input
          id="sound-volume"
          className="slider"
          type="range"
          min={0}
          max={100}
          step={5}
          disabled={!n.sound}
          value={Math.round(n.soundVolume * 100)}
          onChange={(e) => onChange({ soundVolume: Number(e.target.value) / 100 })}
        />

        <div className="sound-crowd">
          <span>Quiet join and leave sounds when more than</span>
          <input
            type="number"
            min={0}
            max={999}
            disabled={!n.sound}
            value={n.soundCrowdLimit}
            onChange={(e) =>
              onChange({
                soundCrowdLimit: Math.max(0, Math.round(Number(e.target.value) || 0)),
              })
            }
          />
          <span>people are in the channel</span>
        </div>
        <div className="hint">
          0 means never. Sounds come out of the same device as the call, and
          they still play while you are deafened — deafen silences people, not
          the app.
        </div>

        <SoundTable
          switches={n.soundEvents}
          disabled={!n.sound}
          onChange={(soundEvents) => onChange({ soundEvents })}
        />
      </section>

      {guilds.length > 0 && (
        <section className="set-group">
          <h4>Per server</h4>
          <div className="hint">
            A server can follow the table above, stay silent, or have a table
            of its own. Direct messages and their calls are in no server and
            always follow the table above.
          </div>
          {guilds.map((g) => {
            const o = n.guildSounds[g.id];
            return (
              <div key={g.id} className="sound-guild">
                <div className="sound-guild-head">
                  <span className="sound-guild-name">{g.name}</span>
                  <select
                    value={o?.mode ?? 'default'}
                    disabled={!n.sound}
                    onChange={(e) => {
                      const mode = e.target.value;
                      if (mode === 'off') setOverride(g.id, { mode: 'off' });
                      else if (mode === 'custom')
                        // Starts from the global table, so choosing Custom
                        // changes nothing until a switch is flipped.
                        setOverride(g.id, {
                          mode: 'custom',
                          events: { ...n.soundEvents },
                        });
                      else setOverride(g.id, null);
                    }}
                  >
                    <option value="default">Same as above</option>
                    <option value="off">Silent</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                {o?.mode === 'custom' && (
                  <SoundTable
                    switches={o.events}
                    disabled={!n.sound}
                    onChange={(events) =>
                      setOverride(g.id, { mode: 'custom', events })
                    }
                  />
                )}
              </div>
            );
          })}
        </section>
      )}

      <div className="hint">
        Sounds by Kenney (kenney.nl), released into the public domain under
        CC0.
      </div>
    </>
  );
}
