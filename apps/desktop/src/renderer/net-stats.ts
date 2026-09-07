import { useEffect, useRef, useState } from 'react';
import { getServerUrl } from './api';
import { getSocket } from './socket';

/**
 * Everything the network panel shows, measured here.
 *
 * Three independent sources, because no one of them answers the question on
 * its own:
 *
 * - An application-level probe ('net:ping'), which is the only latency figure
 *   that includes the server's event loop. A TCP or ICMP round trip stays fast
 *   on a box that has stopped answering, which is exactly the failure someone
 *   opens this panel to diagnose.
 * - The Engine.IO packet counters, for volume and for the transport in use. A
 *   session that fell back to HTTP long-polling behaves nothing like a
 *   WebSocket one, and nothing else in the UI would ever say so.
 * - An HTTP probe of /api/health, run only while the panel is open. It is the
 *   one that separates "the socket is wedged" from "the server is gone", since
 *   it takes a different path through any proxy in front of it.
 *
 * Loss is loss of probes, not of TCP segments: a WebSocket rides on TCP, so
 * genuine packet loss shows up as latency and retransmission rather than as
 * missing data. A probe that never comes back is the honest client-side
 * equivalent, and it is what a stalled connection actually looks like.
 */

/** Samples kept for the graph, the averages and the loss window. */
const WINDOW = 40;
/** A probe still unanswered after this counts as lost. */
const PROBE_TIMEOUT = 4000;
/** Probe cadence with the panel open, and with it closed. */
const PROBE_INTERVAL_OPEN = 1000;
const PROBE_INTERVAL_IDLE = 5000;
/** The health probe is a real request against the database; keep it sparse. */
const HTTP_INTERVAL = 5000;

export interface NetStats {
  /** The most recent round trip, or null if the last probe was lost. */
  rttMs: number | null;
  avgMs: number | null;
  minMs: number | null;
  maxMs: number | null;
  /** Mean change between consecutive round trips: how steady the line is. */
  jitterMs: number | null;
  /** Newest last. null entries are lost probes, and draw as gaps. */
  history: (number | null)[];
  probesSent: number;
  probesLost: number;
  /** Loss over the recent window, not over the whole session. */
  lossPct: number;
  packetsIn: number;
  packetsOut: number;
  bytesIn: number;
  bytesOut: number;
  transport: string | null;
  /** When the current connection was established. */
  connectedSince: number | null;
  /** When the first connection of this session was established. */
  sessionSince: number | null;
  reconnects: number;
  /** Server clock minus ours, corrected for half the round trip. */
  clockSkewMs: number | null;
  httpMs: number | null;
  httpError: string | null;
  serverUrl: string;
}

/** Everything that has to survive a re-render, which is all of it. */
interface Meters {
  history: (number | null)[];
  probesSent: number;
  probesLost: number;
  packetsIn: number;
  packetsOut: number;
  bytesIn: number;
  bytesOut: number;
  transport: string | null;
  connectedSince: number | null;
  sessionSince: number | null;
  reconnects: number;
  clockSkewMs: number | null;
  httpMs: number | null;
  httpError: string | null;
  /** The engine already being counted, so listeners are attached once each. */
  engine: unknown;
  inFlight: boolean;
  lastProbe: number;
  lastHttp: number;
}

function freshMeters(): Meters {
  return {
    history: [],
    probesSent: 0,
    probesLost: 0,
    packetsIn: 0,
    packetsOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    transport: null,
    connectedSince: null,
    sessionSince: null,
    reconnects: 0,
    clockSkewMs: null,
    httpMs: null,
    httpError: null,
    engine: null,
    inFlight: false,
    lastProbe: 0,
    lastHttp: 0,
  };
}

function summarise(m: Meters): NetStats {
  const answered = m.history.filter((x): x is number => x !== null);
  const avg = answered.length
    ? answered.reduce((a, b) => a + b, 0) / answered.length
    : null;

  // Consecutive differences, so a line that sits at 200ms reads as steady and
  // one that swings 40/160/40 does not -- which is the one that ruins a call.
  let jitter: number | null = null;
  if (answered.length > 1) {
    let sum = 0;
    for (let i = 1; i < answered.length; i++) {
      sum += Math.abs(answered[i] - answered[i - 1]);
    }
    jitter = sum / (answered.length - 1);
  }

  const lost = m.history.filter((x) => x === null).length;
  return {
    rttMs: m.history.length ? m.history[m.history.length - 1] : null,
    avgMs: avg,
    minMs: answered.length ? Math.min(...answered) : null,
    maxMs: answered.length ? Math.max(...answered) : null,
    jitterMs: jitter,
    history: m.history,
    probesSent: m.probesSent,
    probesLost: m.probesLost,
    lossPct: m.history.length ? (lost / m.history.length) * 100 : 0,
    packetsIn: m.packetsIn,
    packetsOut: m.packetsOut,
    bytesIn: m.bytesIn,
    bytesOut: m.bytesOut,
    transport: m.transport,
    connectedSince: m.connectedSince,
    sessionSince: m.sessionSince,
    reconnects: m.reconnects,
    clockSkewMs: m.clockSkewMs,
    httpMs: m.httpMs,
    httpError: m.httpError,
    serverUrl: getServerUrl(),
  };
}

/** Engine.IO hands us the frame; this is its payload size, near enough. */
function packetBytes(packet: { data?: unknown }): number {
  const data = packet?.data;
  if (typeof data === 'string') return data.length + 1;
  if (data instanceof ArrayBuffer) return data.byteLength + 1;
  if (ArrayBuffer.isView(data)) return data.byteLength + 1;
  if (data instanceof Blob) return data.size + 1;
  // A ping or pong carries nothing but its type byte.
  return 1;
}

/**
 * Count what the transport actually moves.
 *
 * The engine object is replaced on every reconnect, so this runs again each
 * time a new one appears; the counters live on `m` and survive, because the
 * total for the session is the number worth showing.
 */
function attachEngine(m: Meters, socket: ReturnType<typeof getSocket>) {
  const engine: any = (socket as any)?.io?.engine;
  if (!engine || engine === m.engine) return;
  m.engine = engine;
  m.transport = engine.transport?.name ?? null;

  engine.on('packet', (packet: { data?: unknown }) => {
    m.packetsIn++;
    m.bytesIn += packetBytes(packet);
  });
  engine.on('packetCreate', (packet: { data?: unknown }) => {
    m.packetsOut++;
    m.bytesOut += packetBytes(packet);
  });
  // Socket.IO may open on polling and upgrade a moment later.
  engine.on('upgrade', (transport: { name?: string }) => {
    m.transport = transport?.name ?? m.transport;
  });
}

function record(m: Meters, rtt: number | null) {
  m.history.push(rtt);
  if (m.history.length > WINDOW) m.history.shift();
}

function probe(m: Meters) {
  const socket = getSocket();
  if (!socket?.connected || m.inFlight) return;

  m.inFlight = true;
  m.probesSent++;
  const sentAt = performance.now();
  const sentWall = Date.now();

  socket
    .timeout(PROBE_TIMEOUT)
    .emit(
      'net:ping',
      { t: sentWall },
      (err: Error | null, reply?: { serverTime?: number }) => {
        m.inFlight = false;
        if (err) {
          m.probesLost++;
          record(m, null);
          return;
        }
        const rtt = performance.now() - sentAt;
        record(m, rtt);
        // Half the round trip is the best estimate of the one-way delay, so
        // that is what the server's clock has to be compared against.
        if (typeof reply?.serverTime === 'number') {
          m.clockSkewMs = reply.serverTime - (sentWall + rtt / 2);
        }
      },
    );
}

async function httpProbe(m: Meters) {
  const started = performance.now();
  try {
    const res = await fetch(`${getServerUrl()}/api/health`, { cache: 'no-store' });
    m.httpMs = performance.now() - started;
    m.httpError = res.ok ? null : `HTTP ${res.status}`;
  } catch {
    m.httpMs = null;
    m.httpError = 'unreachable';
  }
}

/**
 * Measure the connection to the server.
 *
 * `active` is the panel being open. Closed, this still probes -- slowly --
 * because the icon is a live indicator and because uptime and loss are
 * histories: they are worth nothing if collection starts when someone looks.
 */
export function useNetStats(
  status: 'connected' | 'connecting' | 'disconnected',
  active: boolean,
): NetStats {
  const metersRef = useRef<Meters>(freshMeters());
  const [stats, setStats] = useState<NetStats>(() =>
    summarise(metersRef.current),
  );

  // Connection lifecycle is driven off the status the socket already reports,
  // rather than a second set of listeners that could disagree with it.
  useEffect(() => {
    const m = metersRef.current;
    if (status === 'connected') {
      if (m.connectedSince === null) {
        m.connectedSince = Date.now();
        if (m.sessionSince === null) m.sessionSince = m.connectedSince;
        else m.reconnects++;
      }
    } else if (m.connectedSince !== null) {
      m.connectedSince = null;
      // A dropped connection leaves its probe unanswered; it is lost, not
      // pending, and nothing else would ever clear it.
      m.inFlight = false;
    }
    setStats(summarise(m));
  }, [status]);

  useEffect(() => {
    const m = metersRef.current;
    const probeEvery = active ? PROBE_INTERVAL_OPEN : PROBE_INTERVAL_IDLE;

    const tick = () => {
      const socket = getSocket();
      attachEngine(m, socket);

      const now = Date.now();
      if (socket?.connected && now - m.lastProbe >= probeEvery) {
        m.lastProbe = now;
        probe(m);
      }
      if (active && now - m.lastHttp >= HTTP_INTERVAL) {
        m.lastHttp = now;
        void httpProbe(m);
      }
      setStats(summarise(m));
    };

    tick();
    // One timer at the display rate: the probe cadence is decided inside the
    // tick, so the open/closed switch never leaves a probe half-scheduled.
    const timer = setInterval(tick, active ? 250 : 1000);
    return () => clearInterval(timer);
  }, [active]);

  return stats;
}

export type NetQuality = 'offline' | 'poor' | 'fair' | 'good' | 'great';

/**
 * One word for the state of the line, and the number of bars for the icon.
 *
 * Graded on loss first and jitter second, because both wreck a call at
 * latencies that look perfectly respectable on their own.
 */
export function netQuality(
  status: 'connected' | 'connecting' | 'disconnected',
  stats: NetStats,
): { quality: NetQuality; bars: number; label: string } {
  if (status !== 'connected') {
    return {
      quality: 'offline',
      bars: 0,
      label: status === 'connecting' ? 'Reconnecting' : 'Offline',
    };
  }
  const rtt = stats.avgMs;
  if (rtt === null) return { quality: 'fair', bars: 2, label: 'Measuring' };

  if (stats.lossPct >= 20) return { quality: 'poor', bars: 1, label: 'Poor' };
  if (stats.lossPct >= 5 || rtt > 300 || (stats.jitterMs ?? 0) > 100) {
    return { quality: 'fair', bars: 2, label: 'Fair' };
  }
  if (rtt > 120 || (stats.jitterMs ?? 0) > 30) {
    return { quality: 'good', bars: 3, label: 'Good' };
  }
  return { quality: 'great', bars: 4, label: 'Excellent' };
}

/** "4h 12m", "3m 07s", "18s" -- the two units that matter at that scale. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMs(ms: number | null, digits = 0): string {
  return ms === null ? '—' : `${ms.toFixed(digits)} ms`;
}
