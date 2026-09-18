/**
 * Fixing a cutout by hand: erase what is not the garment, turn the photo, crop
 * it, and put the result back as the cutout.
 *
 * The geometry lives in `client/lib/photoedit.js`. What is left here is the
 * canvas, which React does not draw, so the drawing state sits in a ref and
 * only what the buttons read is React state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  MIN_CROP,
  canvasPoint,
  clampCrop,
  edgeDrag,
  isLasso,
  rotateCrop,
  rotatedSize,
  sourcePoint,
} from '../lib/photoedit.js';
import { normalizeForUpload, targetSize } from '../lib/normalize.js';
import { imagePath, uploadContentType } from '../lib/photo.js';
import { api, garmentsQuery, upsertGarment } from '../lib/queries.js';
import type { Garment } from '../lib/queries.js';
import { go } from '../lib/route.js';
import { routeHash } from '../lib/router.js';
import { useScreenChrome, useShell } from '../lib/shell.js';

const OUTLINE_DASH = [16, 12];

/** How much of the screen the photo may take, leaving the buttons in reach. */
const VIEW_HEIGHT_VH = 56;

/**
 * The crop handles are hit tested in CSS pixels rather than in source pixels. A
 * radius wide enough for a thumb is about 22 of the screen's pixels whatever the
 * photo is, and 125 source pixels on a 2048px photo shown 360px wide.
 */
const HANDLE_HIT_PX = 22;

/** Room left around the garment, so `Trim edges` never shaves the garment itself. */
const TRIM_MARGIN = 12;

/** A cutout has soft edges, and a nearly clear pixel is not the garment. */
const ALPHA_FLOOR = 8;

const CROP_DIM = 'rgba(8, 6, 4, 0.6)';

const ERASE_HINT = 'Draw a closed line around the part that is not the garment. Everything inside it disappears.';

const CROP_HINT = 'Drag an edge to cut off the empty space around the garment. Save keeps what is inside the frame.';

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Mode = 'erase' | 'crop';

type Session = {
  bitmap: ImageBitmap | null;
  size: { width: number; height: number };
  /**
   * The committed lines are held as points and replayed from the untouched
   * bitmap on every frame, so Undo is one `pop` and no snapshot of the pixels
   * is ever kept.
   */
  paths: Point[][];
  current: Point[] | null;
  dragging: string | null;
  quarterTurns: number;
  crop: Rect | null;
};

function Body({ children }: { children: React.ReactNode }) {
  return (
    <main className="screen">
      <section className="screen__body">{children}</section>
    </main>
  );
}

export function EditPhoto({ route }: { route: { id: string | null } }) {
  const { toast } = useShell();
  useScreenChrome({ title: 'Fix the photo', back: routeHash('review', route.id) });

  const garments = useQuery(garmentsQuery);
  const found = garments.data?.find((row) => row.id === route.id) ?? null;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const work = useRef<Session>({
    bitmap: null,
    size: { width: 0, height: 0 },
    paths: [],
    current: null,
    dragging: null,
    quarterTurns: 0,
    crop: null,
  });

  const [mode, setModeState] = useState<Mode>('erase');
  const [canUndo, setCanUndo] = useState(false);
  const [canStartOver, setCanStartOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [photo, setPhoto] = useState<{ state: 'loading' | 'ready' } | { state: 'failed'; message: string }>({
    state: 'loading',
  });
  /** Bumped when the stored photo is replaced, which is what reloads the bitmap. */
  const [reloads, setReloads] = useState(0);

  const bounds = useCallback(() => rotatedSize(work.current.size, work.current.quarterTurns), []);

  const cropRect = useCallback((): Rect => {
    const frame = bounds();
    return work.current.crop ?? { x: 0, y: 0, w: frame.width, h: frame.height };
  }, [bounds]);

  /**
   * What the canvas holds. Cropping shows the whole rotated photo, or there is
   * nothing to drag the edges back out into, so the canvas size and the
   * transform both come from here rather than from the crop.
   */
  const view = useCallback(
    (at: Mode): Rect => {
      const frame = bounds();
      if (at === 'crop') return { x: 0, y: 0, w: frame.width, h: frame.height };
      return cropRect();
    },
    [bounds, cropRect],
  );

  const untouched = useCallback(() => {
    const rect = cropRect();
    const { size, paths, quarterTurns } = work.current;
    return (
      paths.length === 0 &&
      quarterTurns === 0 &&
      rect.x === 0 &&
      rect.y === 0 &&
      rect.w === size.width &&
      rect.h === size.height
    );
  }, [cropRect]);

  const draw = useCallback(
    (at: Mode, rect: Rect) => {
      const canvas = canvasRef.current;
      const { bitmap, size, paths, current, quarterTurns } = work.current;
      if (canvas === null || bitmap === null) return;
      const surface = canvas.getContext('2d');
      if (surface === null) return;

      const trace = (points: Point[]) => {
        const first = points[0];
        if (first === undefined) return;
        surface.beginPath();
        surface.moveTo(first.x, first.y);
        for (let at2 = 1; at2 < points.length; at2 += 1) {
          const point = points[at2];
          if (point !== undefined) surface.lineTo(point.x, point.y);
        }
        surface.closePath();
      };

      /**
       * Source pixels onto the canvas: the view offset first, then the turn.
       * The lasso points ride this same transform, so `drawImage` at the origin
       * and a `fill` of a stored path both land in the same place.
       */
      surface.setTransform(1, 0, 0, 1, 0, 0);
      surface.clearRect(0, 0, rect.w, rect.h);
      surface.translate(-rect.x, -rect.y);
      if (quarterTurns === 1) {
        surface.translate(size.height, 0);
        surface.rotate(Math.PI / 2);
      } else if (quarterTurns === 2) {
        surface.translate(size.width, size.height);
        surface.rotate(Math.PI);
      } else if (quarterTurns === 3) {
        surface.translate(0, size.width);
        surface.rotate(-Math.PI / 2);
      }

      surface.drawImage(bitmap, 0, 0, size.width, size.height);

      // `destination-out` cuts by the fill's alpha, and the crop dim leaves a
      // translucent color in `fillStyle`, so an opaque one is set back here.
      surface.globalCompositeOperation = 'destination-out';
      surface.fillStyle = '#000000';
      for (const path of paths) {
        trace(path);
        surface.fill();
      }
      surface.globalCompositeOperation = 'source-over';

      /** Two colors, because one of them disappears against a photo of that color. */
      if (current !== null) {
        surface.lineWidth = Math.max(2, Math.round(size.width / 220));
        surface.setLineDash(OUTLINE_DASH);
        surface.strokeStyle = '#ffffff';
        trace(current);
        surface.stroke();

        surface.lineDashOffset = OUTLINE_DASH[0] ?? 0;
        surface.strokeStyle = '#111111';
        trace(current);
        surface.stroke();

        surface.lineDashOffset = 0;
        surface.setLineDash([]);
      }

      if (at !== 'crop') return;

      const box = cropRect();
      const frame = bounds();
      surface.setTransform(1, 0, 0, 1, 0, 0);
      surface.fillStyle = CROP_DIM;
      surface.fillRect(0, 0, frame.width, box.y);
      surface.fillRect(0, box.y + box.h, frame.width, frame.height - box.y - box.h);
      surface.fillRect(0, box.y, box.x, box.h);
      surface.fillRect(box.x + box.w, box.y, frame.width - box.x - box.w, box.h);

      const line = Math.max(2, Math.round(frame.width / 220));
      surface.lineWidth = line;
      surface.strokeStyle = '#ffffff';
      surface.strokeRect(box.x, box.y, box.w, box.h);

      const radius = Math.max(10, Math.round(frame.width / 32));
      for (const spot of handleSpots(box)) {
        surface.beginPath();
        surface.arc(spot.x, spot.y, radius, 0, Math.PI * 2);
        surface.fillStyle = '#ffffff';
        surface.fill();
        surface.strokeStyle = '#111111';
        surface.lineWidth = Math.max(1, Math.round(line / 2));
        surface.stroke();
      }
    },
    [bounds, cropRect],
  );

  const resize = useCallback((rect: Rect) => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (canvas.width !== rect.w) canvas.width = rect.w;
    if (canvas.height !== rect.h) canvas.height = rect.h;

    // Bounded on the width and never on the height, so the rendered box keeps
    // the view's aspect ratio and a single ratio maps a pointer into it. A
    // max-height would letterbox the canvas and the rect would stop lining up.
    canvas.style.maxWidth = `${((rect.w / rect.h) * VIEW_HEIGHT_VH).toFixed(1)}vh`;
  }, []);

  const refresh = useCallback(
    (at: Mode = mode) => {
      setCanUndo(at !== 'crop' && work.current.paths.length > 0);
      setCanStartOver(!untouched());
      const rect = view(at);
      resize(rect);
      draw(at, rect);
    },
    [draw, mode, resize, untouched, view],
  );

  /**
   * Decoded from the bytes rather than drawn from an `<img>`, which would mark
   * the canvas as tainted and make `toBlob` throw at the one moment that
   * matters. `/img/*` is same origin behind the session cookie, so the
   * credentials ride along and nothing needs `crossOrigin`.
   */
  useEffect(() => {
    if (found === null) return;
    let live = true;

    void (async () => {
      try {
        const path = imagePath(found);
        if (path === null) throw new Error('There is no photo stored for this garment.');

        const response = await fetch(path, { credentials: 'same-origin' });
        if (!response.ok) throw new Error('The photo could not be read.');

        const next = await createImageBitmap(await response.blob());
        if (!live) {
          next.close();
          return;
        }
        work.current.bitmap?.close();
        work.current.bitmap = next;
        // `normalizeForUpload` hands back the untouched file when a decode
        // fails, so a full 12MP photo can be what is stored. The canvas takes
        // the same cap the upload aims for, or the PNG going back up is tens of
        // megabytes of cellular.
        work.current.size = targetSize(next.width, next.height);
        setPhoto({ state: 'ready' });
      } catch (error) {
        if (live) setPhoto({ state: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    })();

    return () => {
      live = false;
    };
  }, [found?.id, reloads]);

  useEffect(
    () => () => {
      work.current.bitmap?.close();
      work.current.bitmap = null;
    },
    [],
  );

  useEffect(() => {
    if (photo.state === 'ready') refresh();
  }, [photo.state, refresh]);

  function pointFrom(event: React.PointerEvent) {
    const canvas = canvasRef.current;
    if (canvas === null) return { x: 0, y: 0 };
    // Measured per event, because the page can scroll or rotate mid drag.
    const point = canvasPoint({ x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), {
      width: canvas.width,
      height: canvas.height,
    });
    return sourcePoint(point, { quarterTurns: work.current.quarterTurns, crop: work.current.crop }, work.current.size);
  }

  function grabbedEdge(event: React.PointerEvent) {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const box = canvas.getBoundingClientRect();
    const across = box.width / canvas.width;
    const down = box.height / canvas.height;

    let closest: { edge: string; away: number } | null = null;
    for (const spot of handleSpots(cropRect())) {
      const away = Math.hypot(box.left + spot.x * across - event.clientX, box.top + spot.y * down - event.clientY);
      if (away <= HANDLE_HIT_PX && (closest === null || away < closest.away)) closest = { edge: spot.edge, away };
    }
    return closest === null ? null : closest.edge;
  }

  /** Rounded here, because the canvas takes whole pixels and the rect drives its size. */
  function edgeValue(event: React.PointerEvent, edge: string) {
    const canvas = canvasRef.current;
    if (canvas === null) return 0;
    const point = canvasPoint({ x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), {
      width: canvas.width,
      height: canvas.height,
    });
    return Math.round(edge === 'top' || edge === 'bottom' ? point.y : point.x);
  }

  function setMode(next: Mode) {
    if (mode === next) return;
    work.current.current = null;
    work.current.dragging = null;
    setModeState(next);
    refresh(next);
  }

  function turn(direction: 1 | -1) {
    if (work.current.crop !== null) work.current.crop = rotateCrop(work.current.crop, bounds(), direction);
    work.current.quarterTurns = (work.current.quarterTurns + direction + 4) % 4;
    refresh();
  }

  /** The box the garment sits in, or null when every pixel is clear. */
  function alphaBox(image: ImageData, rect: Rect) {
    const { data } = image;
    let left = rect.w;
    let right = -1;
    let top = -1;
    let bottom = -1;

    for (let y = 0; y < rect.h; y += 1) {
      for (let x = 0; x < rect.w; x += 1) {
        if ((data[(y * rect.w + x) * 4 + 3] ?? 0) <= ALPHA_FLOOR) continue;
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }

    return right < 0 ? null : { left, top, right, bottom };
  }

  function trimEdges() {
    const canvas = canvasRef.current;
    if (canvas === null || work.current.bitmap === null || busy) return;

    const frame = bounds();
    const rect = { x: 0, y: 0, w: frame.width, h: frame.height };
    resize(rect);
    // Read off the photo with no overlay on it, or the dim would count as pixels.
    draw('erase', rect);
    const surface = canvas.getContext('2d');
    if (surface === null) return;
    const box = alphaBox(surface.getImageData(0, 0, rect.w, rect.h), rect);

    if (box === null) {
      refresh();
      toast('Every pixel of this photo is clear, so a trim would leave nothing.');
      return;
    }

    const next = clampCrop(
      {
        x: box.left - TRIM_MARGIN,
        y: box.top - TRIM_MARGIN,
        w: box.right - box.left + 1 + TRIM_MARGIN * 2,
        h: box.bottom - box.top + 1 + TRIM_MARGIN * 2,
      },
      frame,
      MIN_CROP,
    );

    // A photo with no alpha fills its own box, and so does one the garment
    // already reaches the edges of. Say so rather than leaving the tap silent.
    if (next.w === frame.width && next.h === frame.height) {
      refresh();
      toast('The garment already reaches the edges, so there is no empty space to cut off.');
      return;
    }

    work.current.crop = next;
    refresh();
  }

  async function saveEdit() {
    if (busy || found === null) return;
    if (untouched()) {
      toast('Nothing has changed yet. Erase, rotate or crop the photo first.');
      return;
    }

    setBusy(true);
    try {
      // The dashed line and the crop frame are screen overlays. Exporting the
      // cropped view drops both and applies the crop, which nothing else does.
      work.current.current = null;
      const rect = view('erase');
      resize(rect);
      draw('erase', rect);
      const blob = await new Promise<Blob | null>((resolve) => canvasRef.current?.toBlob(resolve, 'image/png'));
      if (blob === null) throw new Error('The phone could not export the edited photo.');

      const updated = await api.putCutout(found.id, blob);
      upsertGarment(updated);
      go(routeHash('review', found.id));
    } catch (error) {
      // The lines only live in this screen, so a failed save leaves them on the
      // canvas rather than throwing the drawing away.
      setBusy(false);
      refresh();
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /** Both of these keep the tags and change only the photo, so they reload it in place. */
  async function reload(request: () => Promise<Garment>, note: string) {
    if (busy) return;
    setBusy(true);
    try {
      upsertGarment(await request());
      work.current.paths = [];
      work.current.current = null;
      work.current.quarterTurns = 0;
      work.current.crop = null;
      setPhoto({ state: 'loading' });
      setReloads((at) => at + 1);
      toast(note);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function replacePhoto(file: File) {
    const { body } = await normalizeForUpload(file);
    const contentType = uploadContentType(body);
    if (contentType === null) {
      toast('This file is not an image the app can read.', 'error');
      return;
    }
    if (found === null) return;

    toast('Uploading the new photo.');
    await reload(() => api.replacePhoto(found.id, body, contentType), 'New photo saved, and the tags are untouched.');
  }

  if (garments.isPending || (photo.state === 'loading' && found !== null)) {
    return (
      <Body>
        <div className="empty">
          <p className="empty__text">Loading the photo.</p>
        </div>
      </Body>
    );
  }

  if (found === null) {
    return (
      <Body>
        <div className="empty">
          <p className="empty__text">That garment is not in the wardrobe any more.</p>
        </div>
      </Body>
    );
  }

  if (photo.state === 'failed') {
    return (
      <Body>
        <div className="empty">
          <p className="empty__text">{photo.message}</p>
          <button
            className="btn btn--primary"
            type="button"
            onClick={() => {
              setPhoto({ state: 'loading' });
              setReloads((at) => at + 1);
            }}
          >
            Try again
          </button>
        </div>
      </Body>
    );
  }

  const cropping = mode === 'crop';

  return (
    <Body>
      <p className="editor__hint">{cropping ? CROP_HINT : ERASE_HINT}</p>

      {/* Above the photo, because the sticky bar covers a plain row placed under it. */}
      <div className="editor__tools">
        <div className="editor__modes">
          <button className="filter" type="button" aria-pressed={!cropping} onClick={() => setMode('erase')}>
            Erase
          </button>
          <button className="filter" type="button" aria-pressed={cropping} onClick={() => setMode('crop')}>
            Crop
          </button>
        </div>
        <div className="editor__turns">
          <button className="btn btn--small btn--ghost" type="button" onClick={() => turn(-1)}>
            Rotate left
          </button>
          <button className="btn btn--small btn--ghost" type="button" onClick={() => turn(1)}>
            Rotate right
          </button>
          <button className="btn btn--small btn--ghost" type="button" hidden={!cropping} onClick={trimEdges}>
            Trim edges
          </button>
        </div>
      </div>

      <div className="editor">
        <canvas
          className="editor__canvas"
          ref={canvasRef}
          onPointerDown={(event) => {
            if (work.current.bitmap === null || busy) return;
            if (cropping) {
              const edge = grabbedEdge(event);
              if (edge === null) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              work.current.dragging = edge;
              return;
            }
            event.currentTarget.setPointerCapture(event.pointerId);
            work.current.current = [pointFrom(event)];
            draw(mode, view(mode));
          }}
          onPointerMove={(event) => {
            if (work.current.dragging !== null) {
              work.current.crop = edgeDrag(
                cropRect(),
                work.current.dragging,
                edgeValue(event, work.current.dragging),
                bounds(),
                MIN_CROP,
              );
              draw(mode, view(mode));
              return;
            }
            if (work.current.current === null) return;
            work.current.current.push(pointFrom(event));
            draw(mode, view(mode));
          }}
          onPointerUp={() => {
            if (work.current.dragging !== null) {
              work.current.dragging = null;
              refresh();
              return;
            }
            const drawn = work.current.current;
            if (drawn === null) return;
            work.current.current = null;
            if (isLasso(drawn)) work.current.paths.push(drawn);
            refresh();
          }}
          onPointerCancel={() => {
            // A cancelled edge drag keeps the crop it reached, so the buttons
            // that read the crop have to be brought back in step with it.
            const wasDragging = work.current.dragging !== null;
            work.current.dragging = null;
            work.current.current = null;
            if (wasDragging) refresh();
            else draw(mode, view(mode));
          }}
        />
      </div>

      {/* Every control lives in the sticky bar. A row of its own below the photo
          ends up behind that bar, which is what put Undo out of reach. */}
      <div className="actionbar">
        <div className="actionbar__buttons">
          <button
            className="btn btn--small btn--ghost"
            type="button"
            disabled={!canUndo || busy}
            onClick={() => {
              work.current.paths.pop();
              refresh();
            }}
          >
            Undo
          </button>
          <button
            className="btn btn--small btn--ghost"
            type="button"
            disabled={!canStartOver || busy}
            onClick={() => {
              work.current.paths = [];
              work.current.quarterTurns = 0;
              work.current.crop = null;
              refresh();
            }}
          >
            Start over
          </button>
          <button className="btn btn--primary" type="button" disabled={busy} onClick={() => void saveEdit()}>
            {busy ? 'Saving' : 'Save'}
          </button>
        </div>
        <div className="picker">
          <button
            className="btn btn--small btn--ghost"
            type="button"
            disabled={asking || busy}
            onClick={() => {
              setAsking(true);
              void reload(() => api.resetCutout(found.id), 'Back to what Images makes of the photo.').finally(() =>
                setAsking(false),
              );
            }}
          >
            {asking ? 'Asking' : 'Ask Images again'}
          </button>
          <label className="btn btn--small btn--ghost" htmlFor="replace-photo">
            Replace photo
          </label>
          <input
            className="picker__input"
            type="file"
            accept="image/*"
            id="replace-photo"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) void replacePhoto(file);
            }}
          />
        </div>
      </div>
    </Body>
  );
}

/** In crop mode the canvas is the whole rotated photo, so canvas space is rotated space. */
function handleSpots(rect: Rect) {
  return [
    { edge: 'top', x: rect.x + rect.w / 2, y: rect.y },
    { edge: 'right', x: rect.x + rect.w, y: rect.y + rect.h / 2 },
    { edge: 'bottom', x: rect.x + rect.w / 2, y: rect.y + rect.h },
    { edge: 'left', x: rect.x, y: rect.y + rect.h / 2 },
  ];
}
