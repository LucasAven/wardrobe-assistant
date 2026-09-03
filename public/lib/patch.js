import { FIELDS, isRelevant } from './vocab.js';

export function parseColors(text) {
  return text
    .split(',')
    .map((color) => color.trim().toLowerCase())
    .filter((color) => color.length > 0);
}

export function formatColors(colors) {
  return colors.join(', ');
}

function same(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return left === right;
}

/**
 * Fields the slot does not use are sent as null rather than left alone, so
 * moving a piece from `base` to `bottom` cannot leave a neckline on a pair of
 * trousers for the book's rules to read later.
 */
export function buildPatch(original, edited) {
  const patch = {};
  for (const field of FIELDS) {
    const next = isRelevant(field.name, edited.slot) ? edited[field.name] : null;
    if (!same(original[field.name], next)) patch[field.name] = next;
  }
  return patch;
}

/** An empty patch is a 400, and confirming an untouched garment still has to review it. */
export function confirmPatch(patch) {
  return Object.keys(patch).length === 0 ? { uncertain: [] } : patch;
}
