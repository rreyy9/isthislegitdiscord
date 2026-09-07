import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Me, type PublicUserDto } from '../api';
import { Avatar } from './Avatar';

/**
 * The profile page of the settings screen: the name everyone sees, and the
 * picture beside it.
 *
 * The name is saved explicitly rather than as you type. Every other setting in
 * this window is yours alone and applies the moment you touch it; this one is
 * broadcast to everybody the instant it lands, and half a name arriving in
 * eight other people's member lists on the way to the whole one is not a thing
 * to do quietly.
 */

/** Avatars are stored at the size they are drawn at, squared and cropped. */
const AVATAR_SIZE = 256;

export function ProfileSettings({
  me,
  onSaved,
}: {
  me: Me;
  /** The saved user, straight from the server, for the app to redraw from. */
  onSaved: (user: PublicUserDto) => void;
}) {
  const [name, setName] = useState(me.displayName ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  /** The file somebody picked, held while they frame it. */
  const [editing, setEditing] = useState<HTMLImageElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The name can also change from under this panel -- an admin renaming you,
  // or the same account signed in on another machine -- and the field has to
  // follow, or saving here would quietly put the old name back.
  useEffect(() => {
    setName(me.displayName ?? '');
  }, [me.displayName]);

  const trimmed = name.trim();
  const dirty = trimmed !== (me.displayName ?? '');

  /** Runs one save and reports whether it landed, so a modal knows to close. */
  async function run(work: () => Promise<PublicUserDto>): Promise<boolean> {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      onSaved(await work());
      setSaved(true);
      return true;
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : 'That did not save. Check the connection and try again.',
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  function pick(file: File | undefined) {
    // Cleared either way: picking the same file twice in a row fires no change
    // event otherwise, which looks exactly like the button being broken.
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('That is not an image.');
      return;
    }
    setError(null);

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => setEditing(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError('That image could not be opened.');
    };
    img.src = url;
  }

  return (
    <>
      <section className="set-group">
        <h4>Display name</h4>
        <div className="profile-name">
          <input
            value={name}
            maxLength={64}
            placeholder={me.username ?? 'Your name'}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && dirty && trimmed) {
                void run(() => api.updateProfile({ displayName: trimmed }));
              }
            }}
          />
          <button
            className="profile-save"
            disabled={!dirty || !trimmed || saving}
            onClick={() =>
              void run(() => api.updateProfile({ displayName: trimmed }))
            }
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="hint">
          What people see next to your messages. Your handle stays{' '}
          <b>{me.username}</b> — that is what an @ mention matches, and it does
          not change.
        </div>
      </section>

      <section className="set-group">
        <h4>Avatar</h4>
        <div className="profile-avatar">
          <Avatar
            size={80}
            name={me.displayName || me.username || '?'}
            image={me.image}
          />
          <div className="profile-avatar-actions">
            <button disabled={saving} onClick={() => fileRef.current?.click()}>
              {me.image ? 'Change picture' : 'Upload a picture'}
            </button>
            {me.image && (
              <button
                className="profile-remove"
                disabled={saving}
                onClick={() =>
                  void run(() => api.updateProfile({ removeAvatar: true }))
                }
              >
                Remove
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => pick(e.target.files?.[0])}
            />
          </div>
        </div>
        <div className="hint">
          PNG, JPEG, GIF or WebP. You choose the part of it that shows next —
          avatars are round and square-cropped, so a picture that is not already
          square will lose its edges.
        </div>
      </section>

      {error && <div className="profile-msg bad">{error}</div>}
      {saved && !error && <div className="profile-msg ok">Saved.</div>}

      {editing && (
        <AvatarEditor
          image={editing}
          busy={saving}
          error={error}
          onCancel={() => {
            URL.revokeObjectURL(editing.src);
            setEditing(null);
          }}
          // The editor stays up for the upload -- it is where the button
          // that started it is, and it is where an upload that fails has to
          // put the message. Only a save that landed closes it.
          onConfirm={async (blob) => {
            if (!(await run(() => api.uploadAvatar(blob)))) return;
            URL.revokeObjectURL(editing.src);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ editor */

/**
 * Framing the picture: drag to move, the slider to zoom, and what is inside
 * the circle is what gets uploaded.
 *
 * The crop happens here rather than on the server on purpose. The server has
 * no image codec -- attachments are stored as the exact bytes that arrived,
 * and the only thing it reads out of them is the width and height in the
 * header -- so the alternative to cropping in the client is either a decoder
 * dependency on the server or storing whatever anybody picked and squashing it
 * with CSS at every size it is drawn at.
 */
function AvatarEditor({
  image,
  busy,
  onCancel,
  onConfirm,
  error,
}: {
  image: HTMLImageElement;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
  /** An upload that failed, said here rather than behind the modal. */
  error: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  /**
   * The scale at which the picture exactly covers the square. Everything else
   * is a multiple of it, so zoom 1 is always "no gaps" whatever shape the
   * original was, and the crop can never include empty space.
   */
  const cover = Math.max(
    AVATAR_SIZE / image.naturalWidth,
    AVATAR_SIZE / image.naturalHeight,
  );

  /** How far the picture may be dragged before an edge comes into the square. */
  function clamp(next: { x: number; y: number }, at = zoom) {
    const scale = cover * at;
    const slackX = Math.max(0, (image.naturalWidth * scale - AVATAR_SIZE) / 2);
    const slackY = Math.max(0, (image.naturalHeight * scale - AVATAR_SIZE) / 2);
    return {
      x: Math.min(slackX, Math.max(-slackX, next.x)),
      y: Math.min(slackY, Math.max(-slackY, next.y)),
    };
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const scale = cover * zoom;
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;
    ctx.clearRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.drawImage(
      image,
      (AVATAR_SIZE - w) / 2 + offset.x,
      (AVATAR_SIZE - h) / 2 + offset.y,
      w,
      h,
    );
  }, [image, zoom, offset, cover]);

  function save() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The canvas already holds exactly the square that was framed, so this is
    // a read of what is on screen rather than a second, separate render.
    canvas.toBlob((blob) => {
      if (blob) onConfirm(blob);
    }, 'image/png');
  }

  return (
    <div className="modal-wrap" onClick={busy ? undefined : onCancel}>
      <div className="modal crop" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">Frame your picture</div>
        <div
          className="crop-stage"
          onPointerDown={(e) => {
            drag.current = { x: e.clientX - offset.x, y: e.clientY - offset.y };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const from = drag.current;
            if (!from) return;
            setOffset(clamp({ x: e.clientX - from.x, y: e.clientY - from.y }));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <canvas
            ref={canvasRef}
            width={AVATAR_SIZE}
            height={AVATAR_SIZE}
            className="crop-canvas"
          />
          {/* The mask is drawn over the canvas rather than into it: what is
              uploaded is the square, and rounding it off here would bake a
              circle into a picture that every client already rounds off
              itself. */}
          <div className="crop-mask" aria-hidden />
        </div>

        <label className="crop-zoom">
          Zoom
          <input
            className="slider"
            type="range"
            min={1}
            max={4}
            step={0.01}
            value={zoom}
            onChange={(e) => {
              const next = Number(e.target.value);
              // Zooming back out can leave the picture far enough off-centre
              // to show an edge, so the offset is re-clamped against the new
              // scale here rather than only while dragging.
              setOffset((o) => clamp(o, next));
              setZoom(next);
            }}
          />
        </label>
        <div className="hint">Drag the picture to choose what shows.</div>
        {error && <div className="profile-msg bad">{error}</div>}

        <div className="crop-actions">
          <button disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button className="crop-go" disabled={busy} onClick={save}>
            {busy ? 'Uploading…' : 'Use this'}
          </button>
        </div>
      </div>
    </div>
  );
}
