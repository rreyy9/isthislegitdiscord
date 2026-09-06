import { useEffect, useRef, useState } from 'react';
import type { Track } from 'livekit-client';
import type { ScreenSource } from '../../preload';
import { bridge } from '../bridge';
import {
  listAudioDevices,
  type InputLevel,
  type Voice,
  type VoiceSettings,
} from '../voice';
import type { VoiceAudioDto } from '../api';

/* ------------------------------------------------------------ screen picker */

/**
 * Electron ships no screen picker of its own on Windows, so the app supplies
 * one. Main asks for a choice; this answers.
 */
export function ScreenPicker() {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);

  useEffect(() => bridge.onScreenChoose(setSources), []);

  function pick(id: string | null) {
    setSources(null);
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
                  {(list as ScreenSource[]).map((s) => (
                    <div key={s.id} className="src" onClick={() => pick(s.id)}>
                      <img src={s.thumbnail} alt="" />
                      <div className="src-name" title={s.name}>
                        {s.name}
                      </div>
                    </div>
                  ))}
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

const QUALITY_LABEL: Record<VoiceAudioDto['quality'], string> = {
  voice: 'Voice',
  balanced: 'Balanced',
  high: 'High',
  studio: 'Studio',
};

export function VoiceSettingsModal({
  settings,
  voice,
  onChange,
  onClose,
}: {
  settings: VoiceSettings;
  voice: Voice;
  onChange: (patch: Partial<VoiceSettings>) => void;
  onClose: () => void;
}) {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [pttOk, setPttOk] = useState(true);
  const [binding, setBinding] = useState(false);

  useEffect(() => {
    void (async () => {
      const d = await listAudioDevices();
      setInputs(d.inputs);
      setOutputs(d.outputs);
      setPttOk(await bridge.pttAvailable());
    })();
  }, []);

  async function bindKey() {
    setBinding(true);
    const result = await bridge.capturePttKey();
    setBinding(false);
    if (result) {
      onChange({ pttKeycode: result.keycode, pttLabel: result.label });
    }
  }

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Voice settings</div>
        <div className="modal-body">
          <label>Microphone</label>
          <select
            value={settings.inputDeviceId ?? ''}
            onChange={(e) => onChange({ inputDeviceId: e.target.value || null })}
          >
            <option value="">System default</option>
            {inputs.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || 'Microphone'}
              </option>
            ))}
          </select>

          <label>Output</label>
          <select
            value={settings.outputDeviceId ?? ''}
            onChange={(e) => onChange({ outputDeviceId: e.target.value || null })}
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
              Device names appear after you have joined a call once — the
              browser hides them until the microphone has been used.
            </div>
          )}

          <label className="row-label">
            <input
              type="checkbox"
              checked={settings.pushToTalk}
              disabled={!pttOk}
              onChange={(e) => onChange({ pushToTalk: e.target.checked })}
            />
            Push to talk
          </label>

          {pttOk ? (
            <div className="ptt-row">
              <button onClick={bindKey} disabled={binding}>
                {binding
                  ? 'Press any key…'
                  : settings.pttLabel
                    ? `Key: ${settings.pttLabel}`
                    : 'Set a key'}
              </button>
              <span className="hint inline">
                Works while another window has focus.
              </span>
            </div>
          ) : (
            <div className="hint">
              The global key hook could not load on this machine, so
              push-to-talk is unavailable. Everything else still works.
            </div>
          )}

          {settings.pushToTalk && (
            <div className="hint">
              While push-to-talk is on it decides everything; sensitivity below
              is ignored.
            </div>
          )}

          <div className="sb-section spaced">Input</div>

          <label>Sensitivity</label>
          <select
            value={settings.gateMode}
            onChange={(e) =>
              onChange({ gateMode: e.target.value as VoiceSettings['gateMode'] })
            }
          >
            <option value="off">Always transmit</option>
            <option value="auto">Automatic</option>
            <option value="manual">Manual threshold</option>
          </select>

          <InputMeter getLevel={voice.getInputLevel} mode={settings.gateMode} />

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

          <label className="row-label">
            <input
              type="checkbox"
              checked={settings.echoCancellation}
              onChange={(e) => onChange({ echoCancellation: e.target.checked })}
            />
            Echo cancellation
          </label>
          <label className="row-label">
            <input
              type="checkbox"
              checked={settings.noiseSuppression}
              onChange={(e) => onChange({ noiseSuppression: e.target.checked })}
            />
            Noise suppression
          </label>
          <label className="row-label">
            <input
              type="checkbox"
              checked={settings.autoGainControl}
              onChange={(e) => onChange({ autoGainControl: e.target.checked })}
            />
            Automatic gain (keeps your level steady for everyone else)
          </label>
          <div className="hint">
            Changing any of these three restarts the microphone, so your voice
            will drop out for a moment if you are in a call.
          </div>

          <div className="sb-section spaced">Output</div>

          <label className="row-label">
            <input
              type="checkbox"
              checked={settings.normalizeVoices}
              onChange={(e) => onChange({ normalizeVoices: e.target.checked })}
            />
            Even out how loud people are
          </label>
          <div className="hint">
            Turns down whoever is much louder than the rest, gradually enough
            not to be noticeable. It only turns people down — the other half of
            the job is automatic gain, above, doing the same for your own
            microphone before anyone else hears it.
          </div>

          <label>Volume — {Math.round(settings.outputVolume * 100)}%</label>
          <input
            className="slider"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(settings.outputVolume * 100)}
            onChange={(e) =>
              onChange({ outputVolume: Number(e.target.value) / 100 })
            }
          />

          <div className="sb-section spaced">Quality</div>
          {voice.audio ? (
            <>
              <div className="quality">
                <b>{QUALITY_LABEL[voice.audio.quality]}</b>
                <span>
                  {Math.round(voice.audio.maxBitrate / 1000)} kbps
                  {voice.audio.stereo ? ' stereo' : ' mono'}
                  {voice.audio.red ? ' · loss protection' : ''}
                </span>
              </div>
              {voice.audio.stereo && settings.echoCancellation && (
                <div className="hint">
                  Stereo needs echo cancellation off, and headphones. Until you
                  turn it off above, this call stays mono.
                </div>
              )}
            </>
          ) : (
            <div className="hint">Shown once you have joined a call.</div>
          )}
          <div className="hint">
            Set on the server, for everyone — it is the host&apos;s upload that
            has to carry it. Change <code>VOICE_QUALITY</code> in the
            server&apos;s .env and restart it.
          </div>

        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Done</button>
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
  onOpenSettings,
  pushToTalk,
}: {
  voice: Voice;
  channelName: string;
  onOpenSettings: () => void;
  pushToTalk: boolean;
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
        <button className="vp-leave" onClick={() => void voice.leave()}>
          Leave
        </button>
      </div>
      <div className="vp-channel">🔊 {channelName}</div>

      {voice.error && <div className="vp-error">{voice.error}</div>}

      {pushToTalk && voice.status === 'connected' && (
        <div className={'vp-ptt' + (voice.talking ? ' live' : '')}>
          {voice.talking ? 'Transmitting' : 'Hold your key to talk'}
        </div>
      )}

      <div className="vp-buttons">
        <button
          className={voice.muted ? 'on' : ''}
          disabled={connecting}
          onClick={() => void voice.setMuted(!voice.muted)}
          title={voice.muted ? 'Unmute' : 'Mute'}
        >
          {voice.muted ? '🔇' : '🎙'}
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
        <button onClick={onOpenSettings} title="Voice settings">
          ⚙
        </button>
      </div>
    </div>
  );
}
