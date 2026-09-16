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
 * Cited on one side, missed and broken on the other. The user reads them as
 * opposites, so a rule on both sides would say the outfit follows a rule it
 * breaks. Cited wins.
 */
export function splitRules(outfit) {
  const cited = dedupeById(outfit?.cited);
  const citedIds = new Set(cited.map((rule) => rule.id));
  const notCited = (rule) => !citedIds.has(rule.id);
  return {
    cited,
    missed: dedupeById(outfit?.missed).filter(notCited),
    broke: dedupeById(outfit?.broke).filter(notCited),
  };
}

/**
 * What the closed book row says, and its only argument for being tapped. A side
 * with nothing on it is left out rather than counted at zero, since "0 missed"
 * is a fact nobody opened the card to learn.
 */
export function bookTally(kept, missed) {
  const counts = [];
  if (kept > 0) counts.push(`${kept} kept`);
  if (missed > 0) counts.push(`${missed} missed`);
  return counts.join(', ');
}

export function garmentIds(outfit) {
  const pieces = (outfit?.pieces ?? []).map((piece) => piece.garment.id);
  const accessories = (outfit?.accessories ?? []).map((garment) => garment.id);
  return [...pieces, ...accessories];
}

/**
 * What "Wore this" sends. The outfit id is the whole of what tells two outfits
 * worn on the same day apart, and leaving it out costs nothing where the tap
 * happens and everything after it, so the wear is built here and named once.
 */
export function wearEntry(outfit) {
  return { garmentIds: garmentIds(outfit), outfitId: outfit.id };
}

const isObject = (value) => value !== null && typeof value === 'object';
const asArray = (value) => (Array.isArray(value) ? value : []);
const asText = (value) => (typeof value === 'string' ? value : '');

/**
 * `short` names what the rule asks for in the book's own words, and is the
 * whole of what a pill on the card can show. A rule saved before the book
 * carried one still has its sentence, and a pill with nothing on it is worse
 * than a pill reading `rect-01`, so the id stands in and the rule stays.
 */
function readRules(value) {
  return asArray(value)
    .filter((rule) => isObject(rule) && typeof rule.id === 'string' && typeof rule.because === 'string')
    .map((rule) => ({
      id: rule.id,
      because: rule.because,
      short: typeof rule.short === 'string' && rule.short !== '' ? rule.short : rule.id,
    }));
}

function readNamed(value) {
  if (!isObject(value) || typeof value.id !== 'string') return null;
  return { id: value.id, subtype: typeof value.subtype === 'string' ? value.subtype : null };
}

/**
 * What the owner changed by hand. Read the way the rules are read: a row the
 * card cannot draw is dropped rather than drawn half empty.
 *
 * Both sides are nullable and they mean opposite things. No `to` is a piece the
 * owner took out, no `from` is one they added to a slot the outfit never had,
 * so only a row with neither side left says nothing a card can draw.
 */
function readCorrections(value) {
  return asArray(value).flatMap((row) => {
    if (!isObject(row) || typeof row.slot !== 'string') return [];
    const from = readNamed(row.from);
    const to = readNamed(row.to);
    if (from === null && to === null) return [];
    return [{ slot: row.slot, from, to, reason: asText(row.reason) }];
  });
}

/** The three codes `Waived` in src/domain/types.ts holds. Anything else is dropped. */
const WAIVED = ['season', 'formality', 'cooldown'];

/**
 * What the owner asked for by name, and what admitting it turned off. Read like
 * the corrections: a row the card cannot draw is dropped rather than drawn half
 * empty, and the whole block is dropped when the words are gone, because a
 * waiver with nothing to justify it is the one thing this section exists to
 * make impossible to hide.
 */
function readOwnerRequest(value) {
  if (!isObject(value) || typeof value.words !== 'string' || value.words === '') return null;

  const honored = asArray(value.honored).flatMap((row) => {
    if (!isObject(row) || typeof row.id !== 'string') return [];
    const waived = asArray(row.waived).filter((one) => WAIVED.includes(one));
    return [{ id: row.id, subtype: typeof row.subtype === 'string' ? row.subtype : null, waived }];
  });
  if (honored.length === 0) return null;

  return {
    words: value.words,
    disagreement: typeof value.disagreement === 'string' ? value.disagreement : '',
    honored,
  };
}

function readPieces(value) {
  return asArray(value).filter((piece) => isObject(piece) && typeof piece.slot === 'string' && isObject(piece.garment));
}

/** The seven `EventKind` values in src/domain/types.ts. Anything else is dropped. */
const EVENTS = ['home', 'errands', 'work', 'social', 'dinner', 'formal', 'active'];

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
    planId: asText(value.planId),
    createdAt: asText(value.createdAt),
    // The picker judges a candidate against the day this outfit was built for.
    event: EVENTS.includes(value.event) ? value.event : null,
    pieces,
    accessories: asArray(value.accessories).filter(isObject),
    title: asText(value.title),
    rationale: asText(value.rationale),
    cited: readRules(value.cited),
    missed: readRules(value.missed),
    broke: readRules(value.broke),
    worn: value.worn === true,
    wearNamed: value.wearNamed === true,
    corrections: readCorrections(value.corrections),
    ownerRequest: readOwnerRequest(value.ownerRequest),
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

/**
 * The outfits gathered into the sets they were composed as, newest set first.
 *
 * The order is read off the list rather than off the clock. The caller hands
 * these over newest first, so the sets come out in the order they are first
 * met, and inside a set the order flips back to the order Claude wrote them:
 * option 1 is the first outfit it composed, not the last.
 */
export function groupBySet(outfits) {
  const sets = new Map();
  for (const [index, outfit] of outfits.entries()) {
    // An outfit saved before the plan id reached the client carries none, and
    // one empty key would gather every one of them into a set they were never
    // composed as, so each takes a key of its own that nothing can match.
    const key = outfit.planId === '' ? `unplanned-${index}` : outfit.planId;
    const found = sets.get(key);
    if (found === undefined) sets.set(key, [outfit]);
    else found.push(outfit);
  }
  return [...sets].map(([setId, group]) => ({ setId, outfits: group.reverse() }));
}

/**
 * What Today shows: every set saved today, newest first, or the sentence that
 * says how to get one. One request can be answered with two or three outfits,
 * so a day holds sets rather than a single outfit.
 */
export function todayView(body) {
  const outfits = readOutfits(body);
  if (outfits.length === 0) return { kind: 'empty', ...NOTHING_SAVED };
  return { kind: 'sets', sets: groupBySet(outfits) };
}

const DATE_HEAD = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Copied from `seasonOf` in src/domain/constraints.ts, southern hemisphere and
 * all, so the swap picker can name the season a saved outfit was built for
 * without a call. `test/swapLabelParity.test.ts` fails when the two drift, and
 * nothing else would notice: the picker would caution against the wrong half of
 * the year while every outfit the engine builds still reads the right one.
 *
 * The month comes out of the digits rather than through `new Date`.
 * `insertOutfit` binds `toISOString()`, so a live row is UTC, but the column's
 * own DEFAULT writes `YYYY-MM-DD HH:MM:SS` and the fixtures carry no trailing
 * `Z`, and JS reads both of those as local time. Reading the digits puts no
 * timezone in the middle of a question about the calendar.
 *
 * Null rather than a guess for a string that starts with no date or names no
 * real month, since spring would be a claim about a day the row cannot describe.
 */
function seasonOfDay(createdAt) {
  const head = DATE_HEAD.exec(typeof createdAt === 'string' ? createdAt : '');
  if (head === null) return null;

  const month = Number(head[2]);
  if (month < 1 || month > 12) return null;
  if (month === 12 || month <= 2) return 'summer';
  if (month <= 5) return 'autumn';
  if (month <= 8) return 'winter';
  return 'spring';
}

/**
 * Copied key for key from `MIN_FORMALITY_BY_EVENT` in
 * src/domain/constraints.ts, the floor the engine holds every garment but an
 * accessory to. `test/swapLabelParity.test.ts` fails when the two drift, and
 * nothing else would notice: the picker would measure a candidate against a
 * floor no outfit was ever built to.
 */
const MIN_FORMALITY_BY_EVENT = {
  home: 1,
  active: 1,
  errands: 1,
  work: 3,
  social: 3,
  dinner: 3,
  formal: 4,
};

/**
 * The day a saved outfit was built for, as much of it as the row still holds.
 * The outfit stores no weather and no plan, so the season and the formality
 * floor are the whole of what can be read back.
 *
 * A missing input gives null rather than a default. An outfit saved without an
 * event has no floor to fail, and a floor of 1 would be a claim about a day
 * nothing recorded.
 */
export function outfitDay(outfit) {
  return {
    season: seasonOfDay(outfit?.createdAt),
    minFormality: MIN_FORMALITY_BY_EVENT[outfit?.event] ?? null,
  };
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
