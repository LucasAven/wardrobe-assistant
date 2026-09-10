import { button, clear, el } from '../dom.js';
import { normalizeForUpload, targetSize } from '../normalize.js';
import { imagePath, uploadContentType } from '../photo.js';
import { routeHash } from '../router.js';

const MIN_LASSO_POINTS = 3;

const OUTLINE_DASH = [16, 12];

/** How much of the screen the photo may take, leaving the buttons in reach. */
const VIEW_HEIGHT_VH = 56;

/** In source pixels. A crop under this is a mis-drag, never a framing anyone wants. */
const MIN_CROP = 32;

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

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

/** Two points enclose no area, so a stray tap on the photo has to erase nothing. */
export function isLasso(points) {
  return points.length >= MIN_LASSO_POINTS;
}

/**
 * Client space to canvas space. The canvas is CSS-scaled down to the screen
 * width, so a coordinate taken straight off the event erases a part of the photo
 * some distance from the finger. Every point on this screen comes through here.
 */
export function canvasPoint(client, rect, size) {
  return {
    x: ((client.x - rect.left) / rect.width) * size.width,
    y: ((client.y - rect.top) / rect.height) * size.height,
  };
}

/** A quarter turn swaps the axes, so the frame the photo is shown in swaps too. */
export function rotatedSize(source, quarterTurns) {
  const sideways = quarterTurns % 2 === 1;
  return {
    width: sideways ? source.height : source.width,
    height: sideways ? source.width : source.height,
  };
}

/**
 * Canvas space back to source space, the inverse of the transform `orient`
 * builds. Lasso points are held in source space for the life of the screen, so
 * a line drawn before a turn keeps erasing the same part of the garment after
 * it and nothing has to be re-mapped.
 */
export function sourcePoint(point, edit, source) {
  const offset = edit.crop ?? { x: 0, y: 0 };
  const rx = point.x + offset.x;
  const ry = point.y + offset.y;
  if (edit.quarterTurns === 1) return { x: ry, y: source.height - rx };
  if (edit.quarterTurns === 2) return { x: source.width - rx, y: source.height - ry };
  if (edit.quarterTurns === 3) return { x: source.width - ry, y: rx };
  return { x: rx, y: ry };
}

/**
 * The crop lives in rotated space, so a turn carries it along rather than
 * resetting it. Four turns the same way land back on the framing they started
 * from. `bounds` is the rotated size before the turn.
 */
export function rotateCrop(crop, bounds, direction) {
  if (direction === 1) {
    return { x: bounds.height - crop.y - crop.h, y: crop.x, w: crop.h, h: crop.w };
  }
  return { x: crop.y, y: bounds.width - crop.x - crop.w, w: crop.h, h: crop.w };
}

export function clampCrop(crop, bounds, minSide) {
  const w = clamp(crop.w, Math.min(minSide, bounds.width), bounds.width);
  const h = clamp(crop.h, Math.min(minSide, bounds.height), bounds.height);
  return {
    x: clamp(crop.x, 0, bounds.width - w),
    y: clamp(crop.y, 0, bounds.height - h),
    w,
    h,
  };
}

/** One edge moves and the other three stay put, which is what a handle drag means. */
export function edgeDrag(crop, edge, value, bounds, minSide) {
  const right = crop.x + crop.w;
  const bottom = crop.y + crop.h;

  if (edge === 'top') {
    const y = clamp(value, 0, bottom - minSide);
    return { x: crop.x, y, w: crop.w, h: bottom - y };
  }
  if (edge === 'bottom') {
    const next = clamp(value, crop.y + minSide, bounds.height);
    return { x: crop.x, y: crop.y, w: crop.w, h: next - crop.y };
  }
  if (edge === 'left') {
    const x = clamp(value, 0, right - minSide);
    return { x, y: crop.y, w: right - x, h: crop.h };
  }
  const next = clamp(value, crop.x + minSide, bounds.width);
  return { x: crop.x, y: crop.y, w: next - crop.x, h: crop.h };
}

export function mountEditPhoto(ctx, route) {
  const node = el('section', { class: 'screen__body' });

  let garment = null;
  let bitmap = null;
  let size = { width: 0, height: 0 };
  let paths = [];
  let current = null;
  let dragging = null;
  let busy = false;
  let gone = false;

  const edit = { quarterTurns: 0, crop: null, mode: 'erase' };

  const canvas = el('canvas', { class: 'editor__canvas' });
  const surface = canvas.getContext('2d');

  const hint = el('p', { class: 'editor__hint' }, ERASE_HINT);
  const eraseChip = button('Erase', { class: 'filter' });
  const cropChip = button('Crop', { class: 'filter' });
  const turnLeft = button('Rotate left', { class: 'btn btn--small btn--ghost' });
  const turnRight = button('Rotate right', { class: 'btn btn--small btn--ghost' });
  const trim = button('Trim edges', { class: 'btn btn--small btn--ghost' });

  const undo = button('Undo', { class: 'btn btn--small btn--ghost' });
  const startOver = button('Start over', { class: 'btn btn--small btn--ghost' });
  const again = button('Ask Images again', { class: 'btn btn--small btn--ghost' });
  const save = button('Save', { class: 'btn btn--primary' });
  const picker = el('input', {
    type: 'file',
    accept: 'image/*',
    class: 'picker__input',
    id: 'replace-photo',
  });

  function show(...children) {
    clear(node);
    node.append(...children.filter((child) => child !== null));
  }

  function showMessage(text, action = null) {
    show(el('div', { class: 'empty' }, [el('p', { class: 'empty__text' }, text), action]));
  }

  function editor() {
    return [
      hint,
      // Above the photo, because the sticky bar covers a plain row placed under it.
      el('div', { class: 'editor__tools' }, [
        el('div', { class: 'editor__modes' }, [eraseChip, cropChip]),
        el('div', { class: 'editor__turns' }, [turnLeft, turnRight, trim]),
      ]),
      el('div', { class: 'editor' }, canvas),
      // Every control lives in the sticky bar. A row of its own below the photo
      // ends up behind that bar, which is what put Undo out of reach.
      el('div', { class: 'actionbar' }, [
        el('div', { class: 'actionbar__buttons' }, [undo, startOver, save]),
        el('div', { class: 'picker' }, [
          again,
          el('label', { class: 'btn btn--small btn--ghost', for: 'replace-photo' }, 'Replace photo'),
          picker,
        ]),
      ]),
    ];
  }

  function bounds() {
    return rotatedSize(size, edit.quarterTurns);
  }

  function cropRect() {
    const frame = bounds();
    return edit.crop ?? { x: 0, y: 0, w: frame.width, h: frame.height };
  }

  /**
   * What the canvas holds. Cropping shows the whole rotated photo, or there is
   * nothing to drag the edges back out into, so the canvas size and the
   * transform both come from here rather than from the crop.
   */
  function view(mode = edit.mode) {
    const frame = bounds();
    if (mode === 'crop') return { x: 0, y: 0, w: frame.width, h: frame.height };
    return cropRect();
  }

  function untouched() {
    const rect = cropRect();
    return (
      paths.length === 0 &&
      edit.quarterTurns === 0 &&
      rect.x === 0 &&
      rect.y === 0 &&
      rect.w === size.width &&
      rect.h === size.height
    );
  }

  function trace(points) {
    surface.beginPath();
    surface.moveTo(points[0].x, points[0].y);
    for (let at = 1; at < points.length; at += 1) surface.lineTo(points[at].x, points[at].y);
    surface.closePath();
  }

  /** Two colors, because one of them disappears against a photo of that color. */
  function outline(points) {
    surface.lineWidth = Math.max(2, Math.round(size.width / 220));
    surface.setLineDash(OUTLINE_DASH);
    surface.strokeStyle = '#ffffff';
    trace(points);
    surface.stroke();

    surface.lineDashOffset = OUTLINE_DASH[0];
    surface.strokeStyle = '#111111';
    trace(points);
    surface.stroke();

    surface.lineDashOffset = 0;
    surface.setLineDash([]);
  }

  /**
   * Source pixels onto the canvas: the view offset first, then the turn. The
   * lasso points ride this same transform, so `drawImage` at the origin and a
   * `fill` of a stored path both land in the same place.
   */
  function orient(rect) {
    surface.setTransform(1, 0, 0, 1, 0, 0);
    surface.translate(-rect.x, -rect.y);
    if (edit.quarterTurns === 1) {
      surface.translate(size.height, 0);
      surface.rotate(Math.PI / 2);
    } else if (edit.quarterTurns === 2) {
      surface.translate(size.width, size.height);
      surface.rotate(Math.PI);
    } else if (edit.quarterTurns === 3) {
      surface.translate(0, size.width);
      surface.rotate(-Math.PI / 2);
    }
  }

  /**
   * The committed lines are held as points and replayed from the untouched
   * bitmap on every frame, so Undo is one `pop` and no snapshot of the pixels is
   * ever kept. This is what the save exports, with no overlay on top of it.
   */
  function paint(rect) {
    surface.setTransform(1, 0, 0, 1, 0, 0);
    surface.clearRect(0, 0, rect.w, rect.h);
    orient(rect);

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
  }

  /** In crop mode the canvas is the whole rotated photo, so canvas space is rotated space. */
  function handleSpots(rect) {
    return [
      { edge: 'top', x: rect.x + rect.w / 2, y: rect.y },
      { edge: 'right', x: rect.x + rect.w, y: rect.y + rect.h / 2 },
      { edge: 'bottom', x: rect.x + rect.w / 2, y: rect.y + rect.h },
      { edge: 'left', x: rect.x, y: rect.y + rect.h / 2 },
    ];
  }

  function overlay(rect, frame) {
    surface.setTransform(1, 0, 0, 1, 0, 0);
    surface.fillStyle = CROP_DIM;
    surface.fillRect(0, 0, frame.width, rect.y);
    surface.fillRect(0, rect.y + rect.h, frame.width, frame.height - rect.y - rect.h);
    surface.fillRect(0, rect.y, rect.x, rect.h);
    surface.fillRect(rect.x + rect.w, rect.y, frame.width - rect.x - rect.w, rect.h);

    const line = Math.max(2, Math.round(frame.width / 220));
    surface.lineWidth = line;
    surface.strokeStyle = '#ffffff';
    surface.strokeRect(rect.x, rect.y, rect.w, rect.h);

    const radius = Math.max(10, Math.round(frame.width / 32));
    for (const spot of handleSpots(rect)) {
      surface.beginPath();
      surface.arc(spot.x, spot.y, radius, 0, Math.PI * 2);
      surface.fillStyle = '#ffffff';
      surface.fill();
      surface.strokeStyle = '#111111';
      surface.lineWidth = Math.max(1, Math.round(line / 2));
      surface.stroke();
    }
  }

  function draw(rect = view()) {
    paint(rect);
    if (current !== null) outline(current);
    if (edit.mode === 'crop') overlay(cropRect(), bounds());
  }

  function resize(rect) {
    if (canvas.width !== rect.w) canvas.width = rect.w;
    if (canvas.height !== rect.h) canvas.height = rect.h;

    // Bounded on the width and never on the height, so the rendered box keeps
    // the view's aspect ratio and a single ratio maps a pointer into it. A
    // max-height would letterbox the canvas and the rect would stop lining up.
    const cap = ((rect.w / rect.h) * VIEW_HEIGHT_VH).toFixed(1);
    canvas.style.maxWidth = `${cap}vh`;
  }

  function refresh() {
    const cropping = edit.mode === 'crop';
    eraseChip.setAttribute('aria-pressed', String(!cropping));
    cropChip.setAttribute('aria-pressed', String(cropping));
    trim.hidden = !cropping;
    hint.textContent = cropping ? CROP_HINT : ERASE_HINT;
    undo.disabled = cropping || paths.length === 0;
    startOver.disabled = untouched();

    const rect = view();
    resize(rect);
    draw(rect);
  }

  function pointFrom(event) {
    // Measured per event, because the page can scroll or rotate mid drag.
    const point = canvasPoint({ x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), {
      width: canvas.width,
      height: canvas.height,
    });
    return sourcePoint(point, edit, size);
  }

  function grabbedEdge(event) {
    const box = canvas.getBoundingClientRect();
    const across = box.width / canvas.width;
    const down = box.height / canvas.height;

    let closest = null;
    for (const spot of handleSpots(cropRect())) {
      const away = Math.hypot(box.left + spot.x * across - event.clientX, box.top + spot.y * down - event.clientY);
      if (away <= HANDLE_HIT_PX && (closest === null || away < closest.away)) closest = { edge: spot.edge, away };
    }
    return closest === null ? null : closest.edge;
  }

  /** Rounded here, because the canvas takes whole pixels and the rect drives its size. */
  function edgeValue(event, edge) {
    const point = canvasPoint({ x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), {
      width: canvas.width,
      height: canvas.height,
    });
    return Math.round(edge === 'top' || edge === 'bottom' ? point.y : point.x);
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (bitmap === null || busy) return;

    if (edit.mode === 'crop') {
      const edge = grabbedEdge(event);
      if (edge === null) return;
      canvas.setPointerCapture(event.pointerId);
      dragging = edge;
      return;
    }

    canvas.setPointerCapture(event.pointerId);
    current = [pointFrom(event)];
    draw();
  });

  canvas.addEventListener('pointermove', (event) => {
    if (dragging !== null) {
      edit.crop = edgeDrag(cropRect(), dragging, edgeValue(event, dragging), bounds(), MIN_CROP);
      draw();
      return;
    }
    if (current === null) return;
    current.push(pointFrom(event));
    draw();
  });

  canvas.addEventListener('pointerup', () => {
    if (dragging !== null) {
      dragging = null;
      refresh();
      return;
    }
    if (current === null) return;
    const drawn = current;
    current = null;
    if (isLasso(drawn)) paths.push(drawn);
    refresh();
  });

  canvas.addEventListener('pointercancel', () => {
    // A cancelled edge drag keeps the crop it reached, so the buttons that read
    // the crop have to be brought back in step with it.
    const cropping = dragging !== null;
    dragging = null;
    current = null;
    if (cropping) refresh();
    else draw();
  });

  function setMode(mode) {
    if (edit.mode === mode) return;
    edit.mode = mode;
    current = null;
    dragging = null;
    refresh();
  }

  function turn(direction) {
    if (edit.crop !== null) edit.crop = rotateCrop(edit.crop, bounds(), direction);
    edit.quarterTurns = (edit.quarterTurns + direction + 4) % 4;
    refresh();
  }

  /** The box the garment sits in, or null when every pixel is clear. */
  function alphaBox(image, rect) {
    const { data } = image;
    let left = rect.w;
    let right = -1;
    let top = -1;
    let bottom = -1;

    for (let y = 0; y < rect.h; y += 1) {
      for (let x = 0; x < rect.w; x += 1) {
        if (data[(y * rect.w + x) * 4 + 3] <= ALPHA_FLOOR) continue;
        if (top < 0) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }

    return right < 0 ? null : { left, top, right, bottom };
  }

  function trimEdges() {
    if (bitmap === null || busy) return;

    const frame = bounds();
    const rect = { x: 0, y: 0, w: frame.width, h: frame.height };
    resize(rect);
    // Read off the photo with no overlay on it, or the dim would count as pixels.
    paint(rect);
    const box = alphaBox(surface.getImageData(0, 0, rect.w, rect.h), rect);

    if (box === null) {
      refresh();
      ctx.toast('Every pixel of this photo is clear, so a trim would leave nothing.');
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
      ctx.toast('The garment already reaches the edges, so there is no empty space to cut off.');
      return;
    }

    edit.crop = next;
    refresh();
  }

  /**
   * Decoded from the bytes rather than drawn from an `<img>`, which would mark
   * the canvas as tainted and make `toBlob` throw at the one moment that
   * matters. `/img/*` is same origin behind the session cookie, so the
   * credentials ride along and nothing needs `crossOrigin`.
   */
  async function loadPhoto() {
    const path = imagePath(garment);
    if (path === null) throw new Error('There is no photo stored for this garment.');

    const response = await fetch(path, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('The photo could not be read.');

    const next = await createImageBitmap(await response.blob());
    bitmap?.close();
    bitmap = next;

    // `normalizeForUpload` hands back the untouched file when a decode fails, so
    // a full 12MP photo can be what is stored. The canvas takes the same cap the
    // upload aims for, or the PNG going back up is tens of megabytes of cellular.
    size = targetSize(bitmap.width, bitmap.height);
  }

  function toPng() {
    // The dashed line and the crop frame are screen overlays. Exporting the
    // cropped view drops both and applies the crop, which nothing else does.
    current = null;
    const rect = view('erase');
    resize(rect);
    paint(rect);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  async function saveEdit() {
    if (busy) return;
    if (untouched()) {
      ctx.toast('Nothing has changed yet. Erase, rotate or crop the photo first.');
      return;
    }

    busy = true;
    save.disabled = true;
    undo.disabled = true;
    startOver.disabled = true;
    save.textContent = 'Saving';
    try {
      const blob = await toPng();
      if (blob === null) throw new Error('The phone could not export the edited photo.');
      const updated = await ctx.api.putCutout(garment.id, blob);
      ctx.store.upsert(updated);
      ctx.go(routeHash('review', garment.id));
    } catch (error) {
      // The lines only live in this screen, so a failed save leaves them on the
      // canvas rather than throwing the drawing away.
      busy = false;
      save.disabled = false;
      save.textContent = 'Save';
      refresh();
      ctx.toast(error.message, 'error');
    }
  }

  /** Both of these keep the tags and change only the photo, so they reload it in place. */
  async function reload(request, note) {
    if (busy) return;
    busy = true;
    try {
      const updated = await request();
      if (gone) return;
      ctx.store.upsert(updated);
      garment = updated;
      paths = [];
      current = null;
      edit.quarterTurns = 0;
      edit.crop = null;
      await loadPhoto();
      if (gone) return;
      refresh();
      ctx.toast(note);
    } catch (error) {
      if (gone) return;
      ctx.toast(error.message, 'error');
    } finally {
      busy = false;
    }
  }

  async function askAgain() {
    again.disabled = true;
    again.textContent = 'Asking';
    await reload(() => ctx.api.resetCutout(garment.id), 'Back to what Images makes of the photo.');
    again.disabled = false;
    again.textContent = 'Ask Images again';
  }

  async function replacePhoto(file) {
    const { body } = await normalizeForUpload(file);
    const contentType = uploadContentType(body);
    if (contentType === null) {
      ctx.toast('This file is not an image the app can read.', 'error');
      return;
    }

    ctx.toast('Uploading the new photo.');
    await reload(
      () => ctx.api.replacePhoto(garment.id, body, contentType),
      'New photo saved, and the tags are untouched.',
    );
  }

  eraseChip.addEventListener('click', () => setMode('erase'));
  cropChip.addEventListener('click', () => setMode('crop'));
  turnLeft.addEventListener('click', () => turn(-1));
  turnRight.addEventListener('click', () => turn(1));
  trim.addEventListener('click', trimEdges);
  undo.addEventListener('click', () => {
    paths.pop();
    refresh();
  });
  startOver.addEventListener('click', () => {
    paths = [];
    edit.quarterTurns = 0;
    edit.crop = null;
    refresh();
  });
  save.addEventListener('click', saveEdit);
  again.addEventListener('click', askAgain);
  picker.addEventListener('change', () => {
    const [file] = picker.files;
    picker.value = '';
    if (file !== undefined) replacePhoto(file);
  });

  async function load() {
    showMessage('Loading the photo.');
    try {
      await ctx.store.ensure();
      if (gone) return;

      const found = ctx.store.find(route.id);
      if (found === null) {
        showMessage('That garment is not in the wardrobe any more.');
        return;
      }

      garment = found;
      await loadPhoto();
      if (gone) return;
      show(...editor());
      refresh();
    } catch (error) {
      if (gone) return;
      showMessage(error.message, button('Try again', { class: 'btn btn--primary', onclick: load }));
    }
  }

  ctx.setTitle('Fix the photo', '');
  ctx.setBack(routeHash('review', route.id));
  load();

  return {
    node,
    destroy() {
      gone = true;
      bitmap?.close();
      bitmap = null;
    },
  };
}
