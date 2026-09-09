/**
 * Reading a SavedOutfit.
 *
 * Claude composes in the chat and saves the result, so this reads what came
 * back rather than what the app asked for. Two promises live here. Book rules
 * are shown with the book's own `because` sentence and never mixed with the
 * model's prose, and nothing saved still says something, because a blank screen
 * is the one outcome that makes the app feel broken.
 */

/** Base to shoes, the order the pieces are worn in. */
export const LAYER_ORDER = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes'];

/** What Today says when Claude has not saved anything yet. */
export const NOTHING_SAVED = {
  title: 'No outfit saved for today.',
  detail:
    'Ask Claude on your phone to pick one. It reads this wardrobe through the connector, and what you agree on lands here.',
};

/** The server already orders the pieces. Sorting again costs nothing and the screen stops depending on it. */
export function orderPieces(pieces) {
  const rank = (piece) => {
    const at = LAYER_ORDER.indexOf(piece.slot);
    return at < 0 ? LAYER_ORDER.length : at;
  };
  return [...(pieces ?? [])].sort((left, right) => rank(left) - rank(right));
}

function dedupeById(rules) {
  const seen = new Set();
  const kept = [];
  for (const rule of rules ?? []) {
    if (rule === null || rule === undefined || seen.has(rule.id)) continue;
    seen.add(rule.id);
    kept.push(rule);
  }
  return kept;
}

/**
 * Cited and missed are two lists the user reads as opposites, so a rule in both
 * would say the outfit follows a rule it breaks. Cited wins.
 */
export function splitRules(outfit) {
  const cited = dedupeById(outfit?.cited);
  const citedIds = new Set(cited.map((rule) => rule.id));
  return { cited, missed: dedupeById(outfit?.missed).filter((rule) => !citedIds.has(rule.id)) };
}

export function garmentIds(outfit) {
  const pieces = (outfit?.pieces ?? []).map((piece) => piece.garment.id);
  const accessories = (outfit?.accessories ?? []).map((garment) => garment.id);
  return [...pieces, ...accessories];
}

const isObject = (value) => value !== null && typeof value === 'object';
const asArray = (value) => (Array.isArray(value) ? value : []);
const asText = (value) => (typeof value === 'string' ? value : '');

function readRules(value) {
  return asArray(value)
    .filter((rule) => isObject(rule) && typeof rule.id === 'string' && typeof rule.because === 'string')
    .map((rule) => ({ id: rule.id, because: rule.because }));
}

function readPieces(value) {
  return asArray(value).filter((piece) => isObject(piece) && typeof piece.slot === 'string' && isObject(piece.garment));
}

/**
 * A SavedOutfit the screen can draw, or null. The tags now come from a chat
 * rather than from a validated structured call, so a row that arrives without
 * pieces is not an outfit and Today says so instead of drawing an empty card.
 */
export function readOutfit(value) {
  if (!isObject(value)) return null;
  const pieces = readPieces(value.pieces);
  if (pieces.length === 0) return null;

  return {
    id: asText(value.id),
    createdAt: asText(value.createdAt),
    pieces,
    accessories: asArray(value.accessories).filter(isObject),
    rationale: asText(value.rationale),
    cited: readRules(value.cited),
    missed: readRules(value.missed),
    worn: value.worn === true,
  };
}

function savedAt(outfit) {
  const time = Date.parse(outfit.createdAt);
  return Number.isNaN(time) ? 0 : time;
}

/** The history, newest first. The server sorts too, and a second sort keeps the screen honest. */
export function readOutfits(body) {
  const outfits = asArray(body?.outfits)
    .map(readOutfit)
    .filter((outfit) => outfit !== null);
  return outfits.sort((left, right) => savedAt(right) - savedAt(left));
}

/** What Today shows: the outfit that was saved, or the sentence that says how to get one. */
export function todayView(body) {
  const outfit = readOutfit(body?.outfit);
  if (outfit === null) return { kind: 'empty', ...NOTHING_SAVED };
  return { kind: 'outfit', outfit };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (value) => String(value).padStart(2, '0');
const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

/** The clock on the phone, not the server's. Every date here is read by one person in one place. */
export function savedClock(createdAt) {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return '';
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function savedLine(createdAt, now = new Date()) {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return 'Saved';

  const days = Math.round((midnight(now) - midnight(at)) / DAY_MS);
  if (days === 0) return `Today, ${savedClock(createdAt)}`;
  if (days === 1) return `Yesterday, ${savedClock(createdAt)}`;
  return `${DAY_NAMES[at.getDay()]} ${at.getDate()} ${MONTH_NAMES[at.getMonth()]}`;
}
