import { useEffect, useRef, useState } from 'react';
import type { Track } from 'livekit-client';
import type { NotificationSettings, ScreenSource } from '../../preload';
import {
  conflictsFor,
  type Keybind,
  type KeybindAction,
} from '../../keybinds';
import {
  api,
  getClientVersion,
  getServerUrl,
  type Me,
  type PublicUserDto,
} from '../api';
import type { Updates } from '../updates';
import { bridge } from '../bridge';
import { ProfileSettings } from './ProfileSettings';
import {
  listAudioDevices,
  noteScreenPickerCancelled,
  type InputLevel,
  type Voice,
  type VoiceSettings,
} from '../voice';

/* ------------------------------------------------------------ screen picker */

/**
 * Electron ships no screen picker of its own on Windows, so the app supplies
 * one. Main asks for a choice; this answers.
 *
 * The list and the thumbnails arrive separately, because capturing a frame of
 * every open window is slow enough to be the entire perceived cost of clicking
 * the share button. The names come first and the pictures land underneath them
 * a moment later; picking before they do is perfectly allowed.
 */
export function ScreenPicker() {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  useEffect(
    () =>
      bridge.onScreenChoose((list) => {
        // Cleared here rather than on close: a second picker must not open
        // showing the last one's pictures against this one's names.
        setThumbnails({});
        setSources(list);
      }),
    [],
  );
  useEffect(() => bridge.onScreenThumbnails(setThumbnails), []);

  function pick(id: string | null) {
    setSources(null);
    // Said here rather than inferred from the rejection later: this is the
    // only place that knows the difference between changing your mind and
    // capture actually failing.
    if (id === null) noteScreenPickerCancelled();
    void bridge.chooseScreenSource(id);
  }

  if (!sources) return null;

  const screens = sources.filter((s) => s.isScreen);
  const windows = sources.filter((s) => !s.isScreen);

  return (
    <div className="modal-wrap" onClick={() => pick(null)}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Share your screen</div>
        <div className="src-scroll">
          {[
            ['Screens', screens],
            ['Windows', windows],
          ].map(([label, list]) =>
            (list as ScreenSource[]).length ? (
              <div key={label as string}>
                <div className="sb-section">{label as string}</div>
                <div className="src-grid">
                  {(list as ScreenSource[]).map((s) => {
                    const shot = s.thumbnail ?? thumbnails[s.id];
                    return (
                      <div key={s.id} className="src" onClick={() => pick(s.id)}>
                        {shot ? (
                          <img src={shot} alt="" />
                        ) : (
                          <div className="src-shot-empty" />
                        )}
                        <div className="src-name" title={s.name}>
                          {s.name}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null,
          )}
        </div>
        <div className="modal-foot">
          <button onClick={() => pick(null)}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- screen stage */

function VideoTile({ track, label }: { track: Track; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  return (
    <div className="tile">
      <video ref={ref} autoPlay playsInline muted={false} />
      <div className="tile-label">{label}</div>
    </div>
  );
}

/** The band above the message list when someone in your call is sharing. */
export function ScreenStage({ voice }: { voice: Voice }) {
  const [expanded, setExpanded] = useState(false);
  if (voice.screenShares.length === 0) return null;

  return (
    <div
      className={'stage' + (expanded ? ' expanded' : '')}
      onDoubleClick={() => setExpanded((v) => !v)}
      title="Double-click to expand"
    >
      {voice.screenShares.map((s) => (
        <VideoTile
          key={s.identity + s.track.sid}
          track={s.track}
          label={`${s.name}'s screen`}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------- per-person volume */

/** The box is drawn against the viewport, so its size has to be known here. */
const VOLUME_MENU_WIDTH = 208;
const VOLUME_MENU_HEIGHT = 116;

/**
 * Right-click somebody in a voice channel and turn them down.
 *
 * It replaced a single output slider, which was the wrong control: turning the
 * whole room down is what the volume knob on the desk is for. The problem
 * worth solving is the one person who is twice as loud as everyone else, and
 * that is per person by definition. The setting is remembered and follows them
 * between calls.
 */
export function UserVolumeMenu({
  name,
  volume,
  x,
  y,
  onChange,
}: {
  name: string;
  /** 0..1. */
  volume: number;
  x: number;
  y: number;
  onChange: (volume: number) => void;
}) {
  const pct = Math.round(volume * 100);
  return (
    <div
      className="menu volume-menu"
      style={{
        left: Math.min(x, window.innerWidth - VOLUME_MENU_WIDTH - 8),
        top: Math.min(y, window.innerHeight - VOLUME_MENU_HEIGHT - 8),
        width: VOLUME_MENU_WIDTH,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="menu-label">{name}</div>
      <div className="vol-row">
        <input
          className="slider"
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
        />
        <span className="vol-pct">{pct}%</span>
      </div>
      <div className="menu-sep" />
      <button onClick={() => onChange(1)}>Reset to 100%</button>
    </div>
  );
}

/* ---------------------------------------------------------------- settings */

/**
 * A live input meter with the gate threshold drawn on it.
 *
 * It polls the hook rather than being handed a level as a prop, because the
 * underlying reading changes fifty times a second and pushing that through
 * React would re-render the whole chat window at the same rate. Nothing above
 * this component ever learns the number.
 */
function InputMeter({
  getLevel,
  mode,
}: {
  getLevel: () => InputLevel;
  mode: VoiceSettings['gateMode'];
}) {
  const [level, setLevel] = useState<InputLevel>(getLevel);

  useEffect(() => {
    const t = setInterval(() => setLevel({ ...getLevel() }), 50);
    return () => clearInterval(t);
  }, [getLevel]);

  // -70..0 dBFS across the full width; below -70 is silence for our purposes.
  const pct = (db: number) => Math.max(0, Math.min(100, ((db + 70) / 70) * 100));

  return (
    <div className="meter">
      <div
        className={'meter-fill' + (level.open ? ' open' : '')}
        style={{ width: `${pct(level.db)}%` }}
      />
      {mode !== 'off' && (
        <div className="meter-mark" style={{ left: `${pct(level.thresholdDb)}%` }} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ about */

/**
 * Which version of everything is running, and where it is connected.
 *
 * The client and the server are two separate builds that are upgraded
 * separately, so this is two rows and never one: "you are on 0.2.6" is not an
 * answer to "why is search missing" when the server is on 0.2.5. The address
 * is here for the same reason — it is the first question anyone asks when
 * something is not working, and it is otherwise buried on the sign-in screen.
 */
function AboutSettings({ updates }: { updates: Updates }) {
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .config()
      .then((cfg) => alive && setServerVersion(cfg.appVersion))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  const { state } = updates;
  const busy = state.stage === 'checking' || state.stage === 'downloading';

  return (
    <>
      <section className="set-group">
        <h4>Versions</h4>
        <div className="about-rows">
          <div className="about-row">
            <span>This app</span>
            <b>{getClientVersion() || 'unknown'}</b>
          </div>
          <div className="about-row">
            <span>Server</span>
            <b>
              {failed ? 'could not ask' : (serverVersion ?? 'checking…')}
            </b>
          </div>
          <div className="about-row">
            <span>Connected to</span>
            <b className="about-url">{getServerUrl()}</b>
          </div>
        </div>
        <div className="hint">
          The app and the server are updated separately, so these two are
          often different — and a feature missing from one of them is usually
          why.
        </div>
      </section>

      <section className="set-group">
        <h4>Updates</h4>
        {updates.available ? (
          <div className="about-update">
            <div>
              Version <b>{updates.available}</b> is available.
            </div>
            {/* Mirrors the banner rather than replacing it. This is where
                somebody comes looking on purpose; the banner is where it
                finds them. */}
            {state.stage === 'ready' ? (
              <button onClick={updates.install}>Restart and install</button>
            ) : state.stage === 'downloading' ? (
              <button disabled>Downloading… {Math.round(state.percent)}%</button>
            ) : (
              <button onClick={updates.download} disabled={busy}>
                Download it
              </button>
            )}
          </div>
        ) : (
          <div className="about-update">
            <div className="muted">
              {busy ? 'Looking…' : 'This is the newest build the server has.'}
            </div>
            <button onClick={updates.recheck} disabled={busy}>
              Check again
            </button>
          </div>
        )}
        {state.stage === 'error' && state.message && (
          <div className="profile-msg bad">{state.message}</div>
        )}
        {state.stage === 'unsupported' && (
          <div className="hint">
            This build updates itself only when it was installed from the
            installer, and only over an https server address.
          </div>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------ keybindings */

/**
 * What each action is, in the order the page lists them.
 *
 * `hold` is not decoration: it is the difference between an action that reads
 * both edges of the key and one that fires once on the press, and it changes
 * what advice the page can honestly give about binding a bare key.
 */
const KEYBIND_ACTIONS: {
  id: KeybindAction;
  label: string;
  blurb: string;
  hold: boolean;
}[] = [
  {
    id: 'ptt',
    label: 'Push to talk',
    blurb:
      'Transmit only while the binding is held. Does nothing unless push-to-talk is switched on under Input.',
    hold: true,
  },
  {
    id: 'pushToMute',
    label: 'Push to mute',
    blurb:
      'The other way round: the microphone stays open, and holding the binding silences it.',
    hold: true,
  },
  {
    id: 'toggleMute',
    label: 'Toggle mute',
    blurb: 'Mute or unmute the microphone, once per press.',
    hold: false,
  },
  {
    id: 'toggleDeafen',
    label: 'Toggle deafen',
    blurb: 'Silence everyone else, and yourself along with them.',
    hold: false,
  },
  {
    id: 'disconnect',
    label: 'Disconnect from voice',
    blurb: 'Leave the voice channel you are in. Does nothing if you are not in one.',
    hold: false,
  },
];

function KeybindSettings({
  keybinds,
  onChange,
  available,
  pushToTalk,
  onOpenInput,
}: {
  keybinds: Keybind[];
  onChange: (rows: Keybind[]) => void;
  /** False when the native hook could not load. Nothing here can work then. */
  available: boolean;
  /** Whether push-to-talk mode is on, which decides if `ptt` rows do anything. */
  pushToTalk: boolean;
  onOpenInput: () => void;
}) {
  /** The action currently waiting for a key, if any. */
  const [binding, setBinding] = useState<KeybindAction | null>(null);

  async function addBinding(action: KeybindAction) {
    setBinding(action);
    const result = await bridge.captureBinding();
    setBinding(null);
    if (!result) return; // nothing pressed before the capture timed out
    onChange([
      ...keybinds,
      {
        id: crypto.randomUUID(),
        action,
        binding: result.binding,
        label: result.label,
        enabled: true,
      },
    ]);
  }

  if (!available) {
    return (
      <div className="hint">
        The global input hook could not load on this machine, so keybindings
        are unavailable. Everything else still works.
      </div>
    );
  }

  return (
    <>
      {KEYBIND_ACTIONS.map((action) => {
        const rows = keybinds.filter((k) => k.action === action.id);
        const waiting = binding === action.id;
        return (
          <section className="set-group" key={action.id}>
            <div className="kb-head">
              <h4>{action.label}</h4>
              <button
                onClick={() => void addBinding(action.id)}
                disabled={binding !== null}
              >
                {waiting ? 'Press a key…' : 'Add a binding'}
              </button>
            </div>
            <div className="hint">{action.blurb}</div>

            {waiting && (
              <div className="hint">
                Press any key or mouse button, with modifiers if you want them.
                Left click and the modifier keys on their own are skipped, so
                this panel stays usable. Ten seconds, then it gives up.
              </div>
            )}

            {rows.length === 0 ? (
              <div className="kb-empty">Nothing bound.</div>
            ) : (
              <div className="kb-rows">
                {rows.map((row) => {
                  const clashes = conflictsFor(row, keybinds);
                  return (
                    <div className="kb-row" key={row.id}>
                      <label className="kb-chip">
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={(e) =>
                            onChange(
                              keybinds.map((k) =>
                                k.id === row.id
                                  ? { ...k, enabled: e.target.checked }
                                  : k,
                              ),
                            )
                          }
                        />
                        <span className={row.enabled ? '' : 'off'}>
                          {row.label}
                        </span>
                      </label>
                      <button
                        className="kb-clear"
                        title="Remove this binding"
                        onClick={() =>
                          onChange(keybinds.filter((k) => k.id !== row.id))
                        }
                      >
                        ✕
                      </button>
                      {clashes.length > 0 && (
                        <span className="kb-warn">
                          Also fires{' '}
                          {clashes
                            .map(
                              (c) =>
                                KEYBIND_ACTIONS.find((a) => a.id === c.action)
                                  ?.label ?? c.action,
                            )
                            .join(', ')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Said here rather than on the Input page, because this is where
                somebody is standing when they bind the key and wonder why
                holding it does nothing. */}
            {action.id === 'ptt' && rows.length > 0 && !pushToTalk && (
              <div className="hint">
                Push-to-talk is switched off, so these do nothing.{' '}
                <button className="link" onClick={onOpenInput}>
                  Turn it on under Input.
                </button>
              </div>
            )}
          </section>
        );
      })}

      <section className="set-group">
        <div className="hint">
          Bindings work while another window has focus — that is the point of
          them — so a bare letter will fire while you are typing in something
          else. Holding a key is safe enough bare; anything that toggles is
          worth a modifier.
        </div>
        <div className="hint">
          Extra modifiers are ignored, so a binding on V still fires when Shift
          is down. Games hold Shift to sprint, and a push-to-talk key that quit
          working the moment you started running would be the worse bug.
        </div>
      </section>
    </>
  );
}

type Section =
  | 'profile'
  | 'devices'
  | 'input'
  | 'keybinds'
  | 'notifications'
  | 'behaviour'
  | 'about';

/**
 * The nav down the left. Every section carries a sentence saying what it is
 * for, because a settings screen that is only a list of switches makes people
 * read each switch to find the one they came for.
 */
const SECTIONS: { id: Section; label: string; blurb: string }[] = [
  {
    id: 'profile',
    label: 'Profile',
    blurb: 'The name and the picture everyone else sees beside your messages.',
  },
  {
    id: 'devices',
    label: 'Devices',
    blurb: 'Which microphone you speak into, and where everyone else comes out.',
  },
  {
    id: 'input',
    label: 'Input',
    blurb: 'What gets sent, and when. Push-to-talk, sensitivity, and what the microphone does to your voice before anyone hears it.',
  },
  {
    id: 'keybinds',
    label: 'Keybindings',
    blurb: 'Keys and mouse buttons that work while another window has focus. An action may have as many as you like.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    blurb: 'What happens when somebody tags you by name.',
  },
  {
    id: 'behaviour',
    label: 'Behaviour',
    blurb: 'What the app does on its own when you open it.',
  },
  {
    id: 'about',
    label: 'About',
    blurb: 'Which version of everything you are running, and where it is connected.',
  },
];

export function SettingsModal({
  me,
  settings,
  notifications,
  keybinds,
  voice,
  onChange,
  onNotificationsChange,
  onKeybindsChange,
  onProfileSaved,
  updates,
  onClose,
}: {
  me: Me;
  settings: VoiceSettings;
  notifications: NotificationSettings;
  keybinds: Keybind[];
  voice: Voice;
  onChange: (patch: Partial<VoiceSettings>) => void;
  onNotificationsChange: (patch: Partial<NotificationSettings>) => void;
  /** The whole table, every time: a row removed has to actually go. */
  onKeybindsChange: (rows: Keybind[]) => void;
  /** The saved user, for the app to redraw every list this person is in. */
  onProfileSaved: (user: PublicUserDto) => void;
  /** What this build is, and whether the server is offering a newer one. */
  updates: Updates;
  onClose: () => void;
}) {
  // Profile first, because it is the one page here somebody opens the settings
  // window specifically to reach -- the audio pages are the ones they end up
  // on after something already went wrong.
  const [section, setSection] = useState<Section>('profile');
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  /** False when the native hook could not load; see voice-main.ts. */
  const [keybindsOk, setKeybindsOk] = useState(true);

  useEffect(() => {
    void (async () => {
      const d = await listAudioDevices();
      setInputs(d.inputs);
      setOutputs(d.outputs);
      setKeybindsOk(await bridge.keybindsAvailable());
    })();
  }, []);

  /** Push-to-talk keys, for the summary the Input page shows. */
  const pttRows = keybinds.filter((k) => k.action === 'ptt' && k.enabled);
  const active = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-nav">
          <div className="settings-title">Settings</div>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={s.id === section ? 'on' : ''}
              onClick={() => setSection(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="settings-main">
          <div className="settings-head">
            <div>
              <div className="settings-h">{active.label}</div>
              <div className="settings-sub">{active.blurb}</div>
            </div>
            <button className="settings-close" onClick={onClose}>
              Done
            </button>
          </div>

          <div className="settings-body">
            {section === 'profile' && (
              <ProfileSettings me={me} onSaved={onProfileSaved} />
            )}

            {section === 'about' && <AboutSettings updates={updates} />}

            {section === 'keybinds' && (
              <KeybindSettings
                keybinds={keybinds}
                onChange={onKeybindsChange}
                available={keybindsOk}
                pushToTalk={settings.pushToTalk}
                onOpenInput={() => setSection('input')}
              />
            )}

            {section === 'devices' && (
              <>
                <section className="set-group">
                  <h4>Microphone</h4>
                  <select
                    value={settings.inputDeviceId ?? ''}
                    onChange={(e) =>
                      onChange({ inputDeviceId: e.target.value || null })
                    }
                  >
                    <option value="">System default</option>
                    {inputs.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || 'Microphone'}
                      </option>
                    ))}
                  </select>
                </section>

                <section className="set-group">
                  <h4>Output</h4>
                  <select
                    value={settings.outputDeviceId ?? ''}
                    onChange={(e) =>
                      onChange({ outputDeviceId: e.target.value || null })
                    }
                  >
                    <option value="">System default</option>
                    {outputs.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || 'Speakers'}
                      </option>
                    ))}
                  </select>
                  {inputs.every((d) => !d.label) && (
                    <div className="hint">
                      Device names appear after you have joined a call once —
                      the browser hides them until the microphone has been used.
                    </div>
                  )}
                </section>
              </>
            )}

            {section === 'input' && (
              <>
                <section className="set-group">
                  <h4>Push to talk</h4>
                  <label className="row-label">
                    <input
                      type="checkbox"
                      checked={settings.pushToTalk}
                      disabled={!keybindsOk}
                      onChange={(e) => onChange({ pushToTalk: e.target.checked })}
                    />
                    Only transmit while a key or mouse button is held
                  </label>

                  {/* The keys themselves live on the Keybindings page, since
                      push-to-talk may have several and they are bound the same
                      way as everything else. What stays here is the switch and
                      a straight answer to "so what is it bound to" — asking
                      somebody to visit another page to find that out would be
                      the change making the feature worse. */}
                  {!keybindsOk ? (
                    <div className="hint">
                      The global input hook could not load on this machine, so
                      push-to-talk is unavailable. Everything else still works.
                    </div>
                  ) : (
                    settings.pushToTalk && (
                      <>
                        <div className="ptt-row">
                          <button onClick={() => setSection('keybinds')}>
                            {pttRows.length === 0
                              ? 'Set a key or button'
                              : `Bound to: ${pttRows.map((k) => k.label).join(', ')}`}
                          </button>
                          <span className="hint inline">
                            {pttRows.length === 0
                              ? 'Nothing bound yet — nothing will transmit.'
                              : 'Works while another window has focus.'}
                          </span>
                        </div>
                        <div className="hint">
                          While push-to-talk is on it decides everything;
                          sensitivity below is ignored.
                        </div>
                      </>
                    )
                  )}
                </section>

                <section className="set-group">
                  <h4>Sensitivity</h4>
                  <select
                    value={settings.gateMode}
                    onChange={(e) =>
                      onChange({
                        gateMode: e.target.value as VoiceSettings['gateMode'],
                      })
                    }
                  >
                    <option value="off">Always transmit</option>
                    <option value="auto">Automatic</option>
                    <option value="manual">Manual threshold</option>
                  </select>

                  <InputMeter
                    getLevel={voice.getInputLevel}
                    mode={settings.gateMode}
                  />

                  {/* The meter is fed by the call's own microphone track, so
                      out of a call it is honestly empty rather than broken.
                      Worth saying now that these settings open from the
                      account menu, where being in a call is not the norm. */}
                  {voice.status === 'idle' && (
                    <div className="hint">
                      The bar moves once you are in a voice channel — the
                      microphone is only open during a call.
                    </div>
                  )}

                  {settings.gateMode === 'manual' && (
                    <input
                      className="slider"
                      type="range"
                      min={-80}
                      max={-10}
                      step={1}
                      value={settings.gateThreshold}
                      onChange={(e) =>
                        onChange({ gateThreshold: Number(e.target.value) })
                      }
                    />
                  )}
                  <div className="hint">
                    {settings.gateMode === 'off'
                      ? 'Everything the microphone hears is sent.'
                      : settings.gateMode === 'auto'
                        ? 'Follows the room: the bar sits above whatever background noise it measures, and moves when the room does.'
                        : 'The marker on the bar is the cut-off. Speak normally and put it just under where the bar reaches.'}
                  </div>
                </section>

                <section className="set-group">
                  <h4>Processing</h4>
                  <label className="row-label">
                    <input
                      type="checkbox"
                      checked={settings.echoCancellation}
                      onChange={(e) =>
                        onChange({ echoCancellation: e.target.checked })
                      }
                    />
                    Echo cancellation
                  </label>
                  <label className="row-label">
                    <input
                      type="checkbox"
                      checked={settings.noiseSuppression}
                      onChange={(e) =>
                        onChange({ noiseSuppression: e.target.checked })
                      }
                    />
                    Noise suppression
                  </label>
                  <label className="row-label">
                    <input
                      type="checkbox"
                      checked={settings.autoGainControl}
                      onChange={(e) =>
                        onChange({ autoGainControl: e.target.checked })
                      }
                    />
                    Automatic gain (keeps your level steady for everyone else)
                  </label>
                  <div className="hint">
                    Changing any of these three restarts the microphone, so your
                    voice will drop out for a moment if you are in a call.
                  </div>
                  {voice.audio?.stereo && settings.echoCancellation && (
                    <div className="hint">
                      This server is set to stereo, and no echo canceller
                      anywhere is: until you turn echo cancellation off, and
                      wear headphones, your calls stay mono.
                    </div>
                  )}
                </section>
              </>
            )}

            {section === 'notifications' && (
              <section className="set-group">
                <h4>When someone tags you</h4>
                <label className="row-label">
                  <input
                    type="checkbox"
                    checked={notifications.mentions}
                    onChange={(e) =>
                      onNotificationsChange({ mentions: e.target.checked })
                    }
                  />
                  Show a desktop notification
                </label>
                <label className="row-label">
                  <input
                    type="checkbox"
                    checked={notifications.sound}
                    onChange={(e) =>
                      onNotificationsChange({ sound: e.target.checked })
                    }
                  />
                  Play a sound
                </label>
                <div className="hint">
                  Only for messages that name you — everything else stays a
                  quiet unread mark. The notification is held back for a message
                  already on screen in a window you are looking at; the sound is
                  not, since that is the half people react to.
                </div>
                <div className="hint">
                  Nothing here can override the operating system. If notifications
                  are switched off for this app in Windows settings, the taskbar
                  button still flashes and the sound still plays.
                </div>
              </section>
            )}

            {section === 'behaviour' && (
              <section className="set-group">
                <h4>Voice channels</h4>
                <label className="row-label">
                  <input
                    type="checkbox"
                    checked={settings.rejoinLastChannel}
                    onChange={(e) =>
                      onChange({ rejoinLastChannel: e.target.checked })
                    }
                  />
                  Rejoin the voice channel I was in when I open the app
                </label>
                <div className="hint">
                  Only if you were still in one when the app closed — leaving a
                  channel on purpose is remembered as leaving. Your microphone
                  opens as it normally would on joining, so if that matters,
                  mute before you close.
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- voice panel */

/** The connected-to-voice strip that sits above the account footer. */
export function VoicePanel({
  voice,
  channelName,
  onLeave,
  pushToTalk,
  pttLabel,
  serverMuted,
}: {
  voice: Voice;
  channelName: string;
  /** Leaving goes through Chat, which also forgets the channel to rejoin. */
  onLeave: () => void;
  pushToTalk: boolean;
  /**
   * Named here so the reminder says which key or button, not just "your key".
   * Several, joined, when push-to-talk is bound more than once — the reminder
   * is only honest if it lists every key that would work.
   */
  pttLabel: string | null;
  /**
   * Why an admin has taken the microphone away, ready to read, or null.
   *
   * The phrasing rather than a boolean, because the only thing this panel does
   * with it is show it — and "until 21:40" is the part somebody actually wants
   * from a mute they did not ask for.
   */
  serverMuted: string | null;
}) {
  if (voice.status === 'idle') return null;

  const connecting =
    voice.status === 'connecting' || voice.status === 'reconnecting';

  return (
    <div className="voice-panel">
      <div className="vp-head">
        <span className={'vp-dot ' + voice.status} />
        <span className="vp-status">
          {voice.status === 'connected'
            ? 'Voice connected'
            : voice.status === 'connecting'
              ? 'Connecting…'
              : voice.status === 'reconnecting'
                ? 'Reconnecting…'
                : 'Voice failed'}
        </span>
        <button className="vp-leave" onClick={onLeave}>
          Leave
        </button>
      </div>
      <div className="vp-channel">🔊 {channelName}</div>

      {voice.error && (
        <div
          className="vp-error"
          title="Dismiss"
          onClick={voice.clearError}
          role="button"
        >
          {voice.error}
        </div>
      )}

      {/* Above the push-to-talk line, and instead of nothing at all: without
          it a muted person sees a microphone button that does nothing and no
          reason anywhere for why nobody can hear them. */}
      {serverMuted && <div className="vp-gagged">🔇 {serverMuted}</div>}

      {/* Deafened is not a state the key can talk its way out of, so the line
          says so rather than reading "Transmitting" over a microphone that is
          shut. Same reason the gagged line above exists. */}
      {pushToTalk && !serverMuted && voice.status === 'connected' && (
        <div
          className={
            'vp-ptt' +
            (voice.talking && !voice.deafened && !voice.pushMuted
              ? ' live'
              : '')
          }
        >
          {voice.deafened
            ? 'Deafened — undeafen or unmute to talk'
            : voice.pushMuted
              ? 'Held muted'
              : voice.talking
                ? 'Transmitting'
                : pttLabel
                  ? `Hold ${pttLabel} to talk`
                  : 'Nothing bound — set a key or button in settings'}
        </div>
      )}

      <div className="vp-buttons">
        <button
          // Push-to-mute shows here too. It is not what the button toggles --
          // that is the standing choice, and this is a key somebody is holding
          // -- but a microphone that is shut has to look shut, or the client
          // is telling you that you are being heard when you are not.
          className={
            voice.muted || voice.pushMuted || serverMuted ? 'on' : ''
          }
          // An admin's mute is enforced on the server, where this button
          // cannot reach. Leaving it live would let somebody click it, watch
          // it change, and still not be heard.
          disabled={connecting || Boolean(serverMuted)}
          onClick={() => void voice.setMuted(!voice.muted)}
          title={
            serverMuted ??
            (voice.pushMuted
              ? 'Held muted'
              : voice.deafened
                ? 'Unmute and undeafen'
                : voice.muted
                  ? 'Unmute'
                  : 'Mute')
          }
        >
          {voice.muted || voice.pushMuted || serverMuted ? '🔇' : '🎙'}
        </button>
        <button
          className={voice.deafened ? 'on' : ''}
          disabled={connecting}
          onClick={() => void voice.setDeafened(!voice.deafened)}
          title={voice.deafened ? 'Undeafen' : 'Deafen'}
        >
          {voice.deafened ? '🔕' : '🎧'}
        </button>
        <button
          className={voice.screenSharing ? 'on' : ''}
          disabled={connecting}
          onClick={() => void voice.toggleScreenShare()}
          title={voice.screenSharing ? 'Stop sharing' : 'Share your screen'}
        >
          🖥
        </button>
      </div>
    </div>
  );
}
