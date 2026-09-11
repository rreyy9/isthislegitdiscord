import { useImageActions } from './ImageViewer';

/**
 * What an attachment looks like before the server has it.
 *
 * Both of these draw a message that does not exist yet -- the ring measures
 * the bytes on their way out, the image is the local copy standing in until
 * the echo lands and replaces it -- so they are filed together and neither
 * knows anything about the message it is standing in for.
 */

/**
 * How far an attachment upload has got.
 *
 * An SVG ring rather than a bar, because it sits inside a message rather than
 * across one, and it has to read at the size of a line of text. The stroke is
 * drawn by dash offset, which is the one way to do this without a library.
 *
 * At 100% it stops being a measurement and becomes a spinner: the bytes have
 * all left, but the server is still writing the files and the row, and a full
 * ring sitting motionless through that looks like something that has finished
 * and got stuck rather than something still working.
 */
export function UploadRing({ fraction }: { fraction: number }) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const done = clamped >= 1;
  // r=7 in a 18x18 box leaves room for the 2px stroke without clipping.
  const circumference = 2 * Math.PI * 7;

  return (
    <div className={'upload-ring' + (done ? ' finishing' : '')}>
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
        <circle className="ring-track" cx="9" cy="9" r="7" />
        <circle
          className="ring-arc"
          cx="9"
          cy="9"
          r="7"
          strokeDasharray={circumference}
          // A full circle when it is spinning, so the arc the animation turns
          // is a constant rather than whatever the last reading happened to be.
          strokeDashoffset={done ? circumference * 0.25 : circumference * (1 - clamped)}
        />
      </svg>
      <span>
        {done ? 'Finishing…' : `Uploading… ${Math.round(clamped * 100)}%`}
      </span>
    </div>
  );
}

/** One of our own pasted images, shown until the server echo replaces it. */
export function PreviewImage({ url }: { url: string }) {
  const { imageProps } = useImageActions();
  return (
    <div className="attach">
      <img src={url} alt="" {...imageProps({ src: url, name: 'image' })} />
    </div>
  );
}
