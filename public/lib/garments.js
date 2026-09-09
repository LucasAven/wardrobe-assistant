/**
 * What state a garment's tags are in.
 *
 * Tagging moved to the Claude connector, so a fresh upload is stored untagged
 * and stays that way until Claude looks at the photo. "Never tagged" and
 * "tagged but not confirmed" both need the user, and they need different things
 * from them, so the two are counted apart everywhere they are shown.
 */
import { FIELDS } from './vocab.js';

/**
 * Mirrors TAGGED_FIELDS in src/worker/vision.ts. `blankDraft` flags every one
 * of them, so a row that flags all of them is a row nothing ever looked at.
 */
const TAGGED_FIELDS = FIELDS.map((field) => field.name);

export function isUntagged(garment) {
  const flagged = new Set(Array.isArray(garment?.uncertain) ? garment.uncertain : []);
  return TAGGED_FIELDS.every((name) => flagged.has(name));
}

/** One of `reviewed`, `untagged` or `unconfirmed`. */
export function tagState(garment) {
  if (garment?.reviewed === true) return 'reviewed';
  return isUntagged(garment) ? 'untagged' : 'unconfirmed';
}

export function countTagStates(garments) {
  const counts = { reviewed: 0, untagged: 0, unconfirmed: 0 };
  for (const garment of garments ?? []) counts[tagState(garment)] += 1;
  return counts;
}

/**
 * A 201 from `POST /api/garments` carrying `taggingError` or `missing` means
 * the photo is stored and no key was set to read it with. That is the normal
 * upload now, so the row says what happened and who tags it, and never reads as
 * a failed upload.
 */
export function taggingPending(row) {
  if (row === null || typeof row !== 'object') return false;
  if (typeof row.taggingError === 'string' && row.taggingError !== '') return true;
  return Array.isArray(row.missing) && row.missing.length > 0;
}

export function uploadStatus(row) {
  if (taggingPending(row)) {
    return { tagged: false, status: 'Saved. Not tagged yet.', note: 'Ask Claude to tag it through the connector.' };
  }

  const flagged = Array.isArray(row?.uncertain) ? row.uncertain.length : 0;
  const base = `Tagged as ${row?.subtype}`;
  return {
    tagged: true,
    status: flagged === 0 ? `${base}. Nothing flagged.` : `${base}. ${flagged} field${flagged === 1 ? '' : 's'} to check.`,
    note: null,
  };
}
