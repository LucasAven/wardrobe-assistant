/**
 * The geometry behind the photo editor, kept apart from the screen that draws
 * it. `client/screens/EditPhoto.tsx` owns the canvas and the pointer handling.
 *
 * It stays a plain ES module because `test/ui.selftest.mjs` imports every
 * export here under node with no transform, and these are the parts worth
 * testing: a wrong sign in one of them erases the wrong half of a photo.
 */

const MIN_LASSO_POINTS = 3;

/** In source pixels. A crop under this is a mis-drag, never a framing anyone wants. */
export const MIN_CROP = 32;

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
