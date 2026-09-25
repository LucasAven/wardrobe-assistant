import { useState } from 'react';
import type { ReactNode } from 'react';
import { retryPath } from '../lib/photo.js';
import { probeSession } from '../lib/queries.js';

/**
 * `/img/*` is behind the session too, so an expired cookie turns every photo
 * into a broken frame. A failed frame says so through `data-failed`, which is
 * what the stylesheet draws the message on, and can be asked again.
 */
export function Photo({
  src,
  alt = '',
  frameClass = 'tile__frame',
  imageClass = 'tile__img',
  retry = false,
  lazy = true,
  children = null,
}: {
  src: string | null;
  /**
   * Empty wherever the garment's name is already on screen next to the frame,
   * which is every grid and picker tile. The review photo and the pieces on an
   * outfit card are the two that have to say it themselves.
   */
  alt?: string;
  frameClass?: string;
  imageClass?: string;
  retry?: boolean;
  lazy?: boolean;
  children?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const [retryAt, setRetryAt] = useState(0);
  // A new photo starts clean, whatever the one before it did. Held in state
  // rather than in a ref, because a render React throws away leaves a ref
  // already advanced and the next attempt then sees no change at all.
  const [lastSrc, setLastSrc] = useState(src);

  if (lastSrc !== src) {
    setLastSrc(src);
    setFailed(false);
    setRetryAt(0);
  }

  const shown = src === null ? undefined : retryAt === 0 ? src : retryPath(src, retryAt);

  return (
    <div
      className={frameClass}
      data-failed={failed ? 'true' : undefined}
      onClick={retry && failed ? () => setRetryAt(Date.now()) : undefined}
    >
      <img
        className={imageClass}
        src={shown}
        alt={alt}
        loading={lazy ? 'lazy' : undefined}
        decoding="async"
        onError={() => {
          setFailed(true);
          // The frame can offer a retry, but a retry against an expired cookie
          // fails the same way forever, so something has to go and find out.
          probeSession();
        }}
        onLoad={() => setFailed(false)}
      />
      {children}
    </div>
  );
}
