import { useCallback, useEffect, useState } from 'react';
import { api, type BanDto, type ChannelDto } from '../api';
import type { Confirmation } from './chat-types';

/**
 * Every dialog the chat screen puts over itself.
 *
 * All three share one shape -- a click-away wrapper, a head, a body, a foot
 * with the dangerous button on the right -- and that shape is the reason they
 * are filed together rather than next to the features that open them.
 */

/** One modal for every "are you sure" in the app: delete, kick, ban. */
export function ConfirmModal({
  confirmation,
  onClose,
}: {
  confirmation: Confirmation;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">{confirmation.title}</div>
        <div className="modal-body">
          <p style={{ margin: 0 }}>{confirmation.body}</p>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button
            className="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await confirmation.run();
              onClose();
            }}
          >
            {confirmation.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Create a channel, or rename one. Admin only, and refused again on the server.
 *
 * One dialog for both because they are one form: a name. The kind is not a
 * control — a new channel takes it from the section the `+` was clicked in,
 * and an existing one cannot change it, since a text channel full of messages
 * is not a voice room and there is nothing sensible to do with the history.
 */
export function ChannelModal({
  edit,
  onClose,
  onDone,
}: {
  edit:
    | { mode: 'create'; guildId: string; kind: ChannelDto['kind'] }
    | { mode: 'rename'; channel: ChannelDto };
  onClose: () => void;
  onDone: (channel: ChannelDto) => void;
}) {
  const creating = edit.mode === 'create';
  const kind = creating ? edit.kind : edit.channel.kind;
  const [name, setName] = useState(creating ? '' : edit.channel.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * What the server's schema accepts, checked here only to say so before a
   * round trip. Spaces are the one people actually hit, and turning them into
   * dashes is what every other chat app does, so the field does it as they
   * type rather than refusing afterwards.
   */
  const clean = (v: string) => v.replace(/\s+/g, '-').replace(/[#@]/g, '').slice(0, 64);
  const valid = name.length > 0;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const channel = creating
        ? await api.createChannel(edit.guildId, { name, kind })
        : await api.renameChannel(edit.channel.id, name);
      onDone(channel);
    } catch (e: any) {
      setError(e?.message || 'Could not save the channel.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          {creating
            ? `Create a ${kind === 'VOICE' ? 'voice' : 'text'} channel`
            : `Rename #${edit.channel.name}`}
        </div>
        <div className="modal-body">
          {error && <div className="banner">{error}</div>}
          <label htmlFor="channel-name">Channel name</label>
          <div className="channel-name-field">
            <span className="hash">{kind === 'VOICE' ? '🔊' : '#'}</span>
            <input
              id="channel-name"
              autoFocus
              value={name}
              placeholder={kind === 'VOICE' ? 'general-voice' : 'new-channel'}
              onChange={(e) => setName(clean(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
                if (e.key === 'Escape') onClose();
              }}
            />
          </div>
          <p className="hint">
            {kind === 'VOICE'
              ? 'Everyone on the server can see it and join the call.'
              : 'Everyone on the server can see it and read it.'}
          </p>
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button disabled={!valid || busy} onClick={() => void submit()}>
            {creating ? 'Create' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The ban list, and the only way to lift one. Lifting a ban does not put
 * anyone back in the server — they still need an invite — which is why this
 * says "Lift" rather than "Restore".
 */
export function BansModal({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const [bans, setBans] = useState<BanDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBans(await api.bans(guildId));
    } catch (e: any) {
      setError(e?.message ?? 'Could not load the ban list.');
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Banned accounts</div>
        <div className="modal-body">
          {error && <div className="banner">{error}</div>}
          {!bans && !error && <div className="hint">Loading…</div>}
          {bans?.length === 0 && <div className="hint">Nobody is banned.</div>}
          {bans?.map((b) => (
            <div className="ban-row" key={b.userId}>
              <div>
                <div>{b.displayName || b.username}</div>
                <div className="hint inline">
                  banned by {b.bannedBy ?? 'an admin'} ·{' '}
                  {new Date(b.createdAt).toLocaleDateString()}
                  {b.reason ? ` · ${b.reason}` : ''}
                </div>
              </div>
              <button
                onClick={async () => {
                  try {
                    await api.unban(guildId, b.userId);
                    await load();
                  } catch (e: any) {
                    setError(e?.message ?? 'Could not lift that ban.');
                  }
                }}
              >
                Lift ban
              </button>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Send one message on to another channel.
 *
 * A modal rather than a menu, because unlike a pin or a delete it needs two
 * things chosen -- where it goes, and whether anything is said with it -- and
 * because it is the one message action that puts something in front of people
 * who are not in the room. Worth a deliberate second.
 *
 * The list is the text channels of the guild the message is in, and nothing
 * else. Forwarding is bounded to one guild on the server for a reason worth
 * repeating here: everybody in a guild can already read every channel in it,
 * so a forward inside one shows nobody anything new -- and the "go to the
 * original" link on the card always leads somewhere the reader can go. Across
 * guilds neither of those holds.
 *
 * It does not navigate afterwards. Forwarding is something done in passing,
 * usually mid-conversation, and being moved to another channel for it would
 * lose the place of whoever did it.
 */
export function ForwardModal({
  quote,
  channels,
  onClose,
  onSent,
}: {
  /** One line describing what is being forwarded, for the header. */
  quote: string;
  /** Text channels this message may go to, in sidebar order. */
  channels: ChannelDto[];
  onClose: () => void;
  /** Does the sending. Resolves with the channel it went to, or throws. */
  onSent: (channelId: string, note: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState('');
  const [target, setTarget] = useState<string | null>(
    channels.length === 1 ? channels[0].id : null,
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? channels.filter((c) => c.name.toLowerCase().includes(needle))
    : channels;

  async function submit() {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSent(target, note.trim());
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Could not forward that message.');
      setBusy(false);
    }
  }

  return (
    <div className="modal-wrap" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Forward message</div>
        <div className="modal-body">
          {error && <div className="banner">{error}</div>}
          {/* What is being sent, said back. Two clicks apart from the message
              itself, this is the only thing confirming the right one was
              picked. */}
          <div className="fwd-quote">{quote}</div>

          <label htmlFor="fwd-filter">Send to</label>
          <input
            id="fwd-filter"
            autoFocus
            value={filter}
            placeholder="Find a channel"
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              // Enter on the filter picks the only thing left, which is how
              // typing three letters and pressing return ends up working.
              if (e.key === 'Enter' && shown.length === 1) setTarget(shown[0].id);
            }}
          />
          <div className="fwd-list">
            {shown.length === 0 && (
              <div className="hint">No channel matches “{filter.trim()}”.</div>
            )}
            {shown.map((c) => (
              <button
                key={c.id}
                className={'fwd-choice' + (target === c.id ? ' on' : '')}
                onClick={() => setTarget(c.id)}
              >
                <span className="hash">#</span>
                {c.name}
              </button>
            ))}
          </div>

          <label htmlFor="fwd-note">Add a message (optional)</label>
          <textarea
            id="fwd-note"
            rows={2}
            value={note}
            placeholder="Say something about it"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>Cancel</button>
          <button disabled={!target || busy} onClick={() => void submit()}>
            {busy ? 'Sending…' : 'Forward'}
          </button>
        </div>
      </div>
    </div>
  );
}
