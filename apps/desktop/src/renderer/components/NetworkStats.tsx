import { useEffect, useRef, useState } from 'react';
import {
  formatBytes,
  formatDuration,
  formatMs,
  netQuality,
  useNetStats,
  type NetStats,
} from '../net-stats';
import type { Voice, VoiceNetStats } from '../voice';

/**
 * The signal-bars button in the footer, and the panel behind it.
 *
 * It lives here rather than in Chat.tsx because everything it shows is
 * measured on its own clock: the stats hook ticks four times a second while
 * the panel is open, and putting it in Chat would re-render the whole client
 * — every message, every member — at that rate for a number nobody is looking
 * at. As its own component the cost stops at this subtree.
 */

const PANEL_WIDTH = 286;

export function NetworkButton({
  status,
  voice,
}: {
  status: 'connected' | 'connecting' | 'disconnected';
  voice: Voice;
}) {
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  const stats = useNetStats(status, anchor !== null);
  const { quality, bars, label } = netQuality(status, stats);

  // Same dismissal as the account menu: a click anywhere closes it, and the
  // opening click stops propagating so it does not close it again.
  useEffect(() => {
    if (!anchor) return;
    const close = () => setAnchor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [anchor]);

  return (
    <>
      <button
        className={'net-btn q-' + quality + (anchor ? ' open' : '')}
        title={`Connection: ${label}`}
        aria-label={`Connection: ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          if (anchor) return setAnchor(null);
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({
            left: Math.max(8, Math.min(r.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - 8)),
            bottom: window.innerHeight - r.top + 8,
          });
        }}
      >
        <SignalBars bars={bars} />
      </button>

      {anchor && (
        <NetworkPanel
          anchor={anchor}
          status={status}
          stats={stats}
          label={label}
          quality={quality}
          voice={voice}
        />
      )}
    </>
  );
}

/** Four bars, lit up to the current grade. Zero lit reads as offline. */
function SignalBars({ bars }: { bars: number }) {
  return (
    <svg width="15" height="13" viewBox="0 0 15 13" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={i * 4}
          y={12 - (i + 1) * 3}
          width="2.6"
          height={(i + 1) * 3}
          rx="1"
          className={i < bars ? 'bar on' : 'bar'}
        />
      ))}
    </svg>
  );
}

function NetworkPanel({
  anchor,
  status,
  stats,
  label,
  quality,
  voice,
}: {
  anchor: { left: number; bottom: number };
  status: 'connected' | 'connecting' | 'disconnected';
  stats: NetStats;
  label: string;
  quality: string;
  voice: Voice;
}) {
  const now = useTicker();
  const voiceStats = useVoiceNetStats(voice);

  return (
    <div
      className="net-panel"
      style={{ left: anchor.left, bottom: anchor.bottom, width: PANEL_WIDTH }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="net-head">
        <span className={'status-dot ' + status} style={{ margin: 0 }} />
        <span className="net-title">{label}</span>
        <span className="net-ping">{formatMs(stats.rttMs)}</span>
      </div>

      <Sparkline history={stats.history} quality={quality} />

      <div className="net-grid">
        <Stat
          label="Ping"
          value={formatMs(stats.rttMs)}
          sub={`avg ${formatMs(stats.avgMs)}`}
        />
        <Stat
          label="Jitter"
          value={formatMs(stats.jitterMs)}
          sub={`${formatMs(stats.minMs)} – ${formatMs(stats.maxMs)}`}
        />
        <Stat
          label="Loss"
          value={`${stats.lossPct.toFixed(0)}%`}
          sub={`${stats.probesLost} of ${stats.probesSent} probes`}
          bad={stats.lossPct >= 5}
        />
        <Stat
          label="Transport"
          value={stats.transport ?? '—'}
          sub={stats.transport === 'polling' ? 'no websocket' : 'socket.io'}
          bad={stats.transport === 'polling'}
        />
        <Stat
          label="Packets in"
          value={stats.packetsIn.toLocaleString()}
          sub={formatBytes(stats.bytesIn)}
        />
        <Stat
          label="Packets out"
          value={stats.packetsOut.toLocaleString()}
          sub={formatBytes(stats.bytesOut)}
        />
        <Stat
          label="Connected for"
          value={
            stats.connectedSince ? formatDuration(now - stats.connectedSince) : '—'
          }
          sub={
            stats.reconnects === 0
              ? 'no drops'
              : `${stats.reconnects} reconnect${stats.reconnects === 1 ? '' : 's'}`
          }
          bad={stats.connectedSince === null}
        />
        <Stat
          label="Session"
          value={stats.sessionSince ? formatDuration(now - stats.sessionSince) : '—'}
          sub="since sign-in"
        />
        <Stat
          label="API"
          value={stats.httpError ?? formatMs(stats.httpMs)}
          sub="/api/health"
          bad={stats.httpError !== null}
        />
        <Stat
          label="Clock skew"
          value={
            stats.clockSkewMs === null
              ? '—'
              : `${stats.clockSkewMs > 0 ? '+' : ''}${(stats.clockSkewMs / 1000).toFixed(1)}s`
          }
          sub="server vs. you"
          bad={Math.abs(stats.clockSkewMs ?? 0) > 30000}
        />
      </div>

      {voiceStats && <VoiceSection stats={voiceStats} />}

      <div className="net-server" title={stats.serverUrl}>
        {stats.serverUrl}
      </div>
    </div>
  );
}

/** The call's own numbers, which are a different network from the socket's. */
function VoiceSection({ stats }: { stats: VoiceNetStats }) {
  const sendTotal = stats.send.packets + stats.send.lost;
  const recvTotal = stats.recv.packets + stats.recv.lost;
  const pct = (lost: number, total: number) =>
    total > 0 ? `${((lost / total) * 100).toFixed(1)}%` : '0%';

  return (
    <>
      <div className="net-sep" />
      <div className="net-subhead">
        Voice
        <span className={'net-tag q-' + stats.quality}>{stats.quality}</span>
      </div>
      <div className="net-grid">
        <Stat
          label="Voice ping"
          value={formatMs(stats.rttMs)}
          sub={stats.codec ?? 'to the SFU'}
        />
        <Stat
          label="Voice jitter"
          value={formatMs(stats.recv.jitterMs, 1)}
          sub="incoming"
        />
        <Stat
          label="Sent"
          value={stats.send.packets.toLocaleString()}
          sub={`${formatBytes(stats.send.bytes)} · ${pct(stats.send.lost, sendTotal)} lost`}
          bad={sendTotal > 0 && stats.send.lost / sendTotal > 0.02}
        />
        <Stat
          label="Received"
          value={stats.recv.packets.toLocaleString()}
          sub={`${formatBytes(stats.recv.bytes)} · ${pct(stats.recv.lost, recvTotal)} lost`}
          bad={recvTotal > 0 && stats.recv.lost / recvTotal > 0.02}
        />
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  bad,
}: {
  label: string;
  value: string;
  sub?: string;
  bad?: boolean;
}) {
  return (
    <div className="net-stat">
      <div className="net-stat-label">{label}</div>
      <div className={'net-stat-value' + (bad ? ' bad' : '')}>{value}</div>
      {sub && <div className="net-stat-sub">{sub}</div>}
    </div>
  );
}

/**
 * The last forty probes. Lost ones draw full height in red rather than as a
 * gap: a hole in a chart reads as "no data", and this is the opposite of that.
 */
function Sparkline({
  history,
  quality,
}: {
  history: (number | null)[];
  quality: string;
}) {
  const answered = history.filter((x): x is number => x !== null);
  // A fixed floor keeps a steady 12ms line from being drawn as a mountain
  // range by its own noise.
  const top = Math.max(60, ...answered) * 1.15;
  const slots = 40;
  const shown = history.slice(-slots);

  return (
    <div className={'net-spark q-' + quality}>
      {Array.from({ length: slots }, (_, i) => {
        const v = shown[i - (slots - shown.length)];
        if (v === undefined) return <span key={i} className="spark-bar empty" />;
        if (v === null) return <span key={i} className="spark-bar lost" />;
        return (
          <span
            key={i}
            className="spark-bar"
            style={{ height: `${Math.max(6, (v / top) * 100)}%` }}
            title={`${v.toFixed(0)} ms`}
          />
        );
      })}
    </div>
  );
}

/**
 * Wall clock, once a second, so the two uptime figures actually count up.
 *
 * Only mounted with the panel, so there is nothing to switch off: closing it
 * unmounts this along with everything else.
 */
function useTicker() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Poll the call for WebRTC counters while the panel is open.
 *
 * Guarded by `alive` because getStats is async and the panel can close between
 * the request and the answer, which would set state on a gone component.
 */
function useVoiceNetStats(voice: Voice): VoiceNetStats | null {
  const [stats, setStats] = useState<VoiceNetStats | null>(null);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const connected = voice.status === 'connected';

  useEffect(() => {
    if (!connected) {
      setStats(null);
      return;
    }
    let alive = true;
    const read = async () => {
      const next = await voiceRef.current.getNetStats().catch(() => null);
      if (alive) setStats(next);
    };
    void read();
    const t = setInterval(read, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [connected]);

  return stats;
}
