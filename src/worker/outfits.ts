/**
 * The storage the connector added: outfits composed in the Claude app, and the
 * home location a plan reads its weather from.
 *
 * A saved outfit holds garment ids and rule ids, never copies of the garments
 * or of the book's sentences. Both of those have one home already, so a stored
 * copy would be a second one that drifts. Reading an outfit hydrates the ids
 * from the wardrobe, which is also what makes an edited garment show its new
 * photo inside an outfit saved last week.
 */

import { RULES_BY_ID } from '../domain/bookRules';
import { doubledAccessories, recheck } from '../domain/certify';
import { wardrobeGaps } from '../domain/gaps';
import type {
  BodyProfile,
  EventKind,
  Garment,
  ResolvedOutfit,
  Severity,
  Slot,
  Waived,
} from '../domain/types';
import { ruleView } from './compose';
import type {
  Correction,
  GarmentView,
  HonoredRequest,
  OutfitPiece,
  OwnerRequest,
  RuleView,
  SavedOutfit,
  Waiver,
} from './contract';
import { getProfile } from './profile';
import { getGarment, listGarments } from './repo';
import type { LoggedWear } from './routes/wear';
import { day, recentWear } from './routes/wear';

/**
 * The shapes the web app reads live in `./contract`, which is the file both
 * sides are written against. They are re-exported here because this module is
 * where they are built and where every worker caller already looks for them.
 */
export type { Correction, HonoredRequest, OutfitPiece, OwnerRequest, SavedOutfit, Waiver };

/** Base to shoes, then accessories. The order an outfit is read in. */
const PIECE_ORDER: readonly Slot[] = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes', 'accessory'];

/** An outfit without one of these is not an outfit, so none of them can be emptied. */
const REQUIRED_SLOTS: readonly Slot[] = ['base', 'bottom', 'shoes'];

/** Newest first, and never more than this whatever the caller asks for. */
export const MAX_OUTFITS = 20;

export interface HomeLocation {
  readonly lat: number;
  readonly lon: number;
}

interface HomeRow {
  readonly home_lat: unknown;
  readonly home_lon: unknown;
}

export async function homeLocation(db: D1Database): Promise<HomeLocation | null> {
  const row = await db
    .prepare('SELECT home_lat, home_lon FROM profile WHERE id = 1')
    .first<HomeRow>();
  if (row === null) return null;

  const { home_lat: lat, home_lon: lon } = row;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return { lat, lon };
}

/**
 * An UPDATE and never an insert: `profile.data` is NOT NULL, so a row made for a
 * home alone would have to invent a body profile. No profile row yet means no
 * write, which is the state the screen already draws as no home stored.
 */
export async function putHome(db: D1Database, home: HomeLocation): Promise<void> {
  await db
    .prepare('UPDATE profile SET home_lat = ?, home_lon = ? WHERE id = 1')
    .bind(home.lat, home.lon)
    .run();
}

export async function clearHome(db: D1Database): Promise<void> {
  await db.prepare('UPDATE profile SET home_lat = NULL, home_lon = NULL WHERE id = 1').run();
}



/**
 * An owner's request as it is stored. The words are theirs, captured when the
 * plan was made, so the outfit records what was asked rather than a later
 * account of it.
 */
export interface NewOwnerRequest {
  readonly words: string;
  /** The composer's own read on the pieces it was asked for. Null when it wrote none. */
  readonly disagreement: string | null;
  /** Only the requested garments this outfit actually wears. */
  readonly honored: readonly Waiver[];
}



export interface NewOutfit {
  readonly planId: string;
  readonly event: EventKind;
  readonly title: string;
  readonly pieces: readonly OutfitPiece[];
  readonly rationale: string;
  readonly citedRules: readonly string[];
  readonly missedRules: readonly string[];
  readonly warmthCore: number;
  readonly warmthWithOuter: number;
  /** Null for the ordinary outfit, which is one nobody overrode a filter for. */
  readonly ownerRequest: NewOwnerRequest | null;
}

export async function insertOutfit(
  db: D1Database,
  outfit: NewOutfit,
  savedAt: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO outfit
         (id, plan_id, event, title, pieces, rationale, cited_rules, missed_rules, warmth_core, warmth_with_outer, owner_request, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      outfit.planId,
      outfit.event,
      outfit.title,
      JSON.stringify(outfit.pieces),
      outfit.rationale,
      JSON.stringify(outfit.citedRules),
      JSON.stringify(outfit.missedRules),
      outfit.warmthCore,
      outfit.warmthWithOuter,
      outfit.ownerRequest === null ? null : JSON.stringify(outfit.ownerRequest),
      // ISO rather than SQLite's `datetime('now')`, so the first ten characters
      // are the same UTC day the wear log writes and the two can be compared.
      savedAt.toISOString(),
    )
    .run();
  return id;
}

/**
 * One piece of a saved outfit changed by hand, as the owner asked for it.
 *
 * Garments going in and out are named by id and never by slot. A slot names one
 * piece only while the outfit wears one garment in it, and an outfit wears as
 * many accessories as the owner likes, so a bare slot cannot say which of them
 * a tap meant. The add is the one edit with no `fromId` at all, and it needs no
 * slot either: the garment arriving knows its own.
 *
 * Three cases rather than two nullable ids, so an edit naming neither garment
 * is a shape nothing here can hold.
 */
export type OutfitEdit =
  | { readonly kind: 'swap'; readonly fromId: string; readonly toId: string; readonly reason: string }
  | { readonly kind: 'drop'; readonly fromId: string; readonly reason: string }
  | { readonly kind: 'add'; readonly toId: string; readonly reason: string };



interface OutfitRow {
  readonly id: string;
  readonly plan_id: string;
  readonly event: string | null;
  readonly title: string | null;
  readonly pieces: string;
  readonly rationale: string;
  readonly cited_rules: string;
  readonly missed_rules: string;
  readonly warmth_core: number;
  readonly warmth_with_outer: number;
  readonly owner_request: string | null;
  readonly created_at: string;
}

interface FeedbackRow {
  readonly outfit_id: string;
  readonly slot: string;
  readonly from_id: string | null;
  readonly to_id: string | null;
  readonly reason: string;
  readonly created_at: string;
}

/**
 * Reads a column, so it never throws. A LEFT JOIN can hand this a null, and an
 * unreadable `pieces` on one old row should cost that row its garments rather
 * than cost the whole plan call its answer.
 */
function parsePieces(json: string | null | undefined): readonly OutfitPiece[] {
  if (typeof json !== 'string') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (piece): piece is OutfitPiece =>
      typeof piece === 'object' &&
      piece !== null &&
      typeof (piece as OutfitPiece).id === 'string' &&
      PIECE_ORDER.includes((piece as OutfitPiece).slot),
  );
}

function ruleIds(json: string): readonly string[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((id: unknown): id is string => typeof id === 'string');
}

/**
 * Which half of `missed_rules` a stored id belongs to. The severity is read
 * from the book rather than stored beside the id, because a stored copy is free
 * to say `prefer` about a rule the book has since made a dont.
 */
function withSeverity(ids: readonly string[], severity: Severity): readonly string[] {
  return ids.filter((id) => RULES_BY_ID.get(id)?.severity === severity);
}

function ruleViews(ids: readonly string[]): readonly RuleView[] {
  return ids.flatMap((id): RuleView[] => {
    const rule = RULES_BY_ID.get(id);
    return rule === undefined ? [] : [ruleView(rule)];
  });
}

/** A garment as a correction names it: an id, plus whatever the wardrobe calls it now. */
function named(
  id: string,
  wardrobe: ReadonlyMap<string, Garment>,
): { readonly id: string; readonly subtype: string | null } {
  return { id, subtype: wardrobe.get(id)?.subtype ?? null };
}

const WAIVED: readonly Waived[] = ['season', 'formality', 'cooldown'];

/**
 * Read the way `parsePieces` reads its column: this app wrote the JSON, but a
 * row written by an older version of it is still a row this one has to draw.
 * Anything unreadable comes back as no request rather than as a broken one.
 */
function parseOwnerRequest(
  json: string | null,
  wardrobe: ReadonlyMap<string, Garment>,
): OwnerRequest | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const row = parsed as Record<string, unknown>;
  if (typeof row.words !== 'string' || row.words === '') return null;

  const honored = (Array.isArray(row.honored) ? row.honored : []).flatMap(
    (entry: unknown): HonoredRequest[] => {
      if (entry === null || typeof entry !== 'object') return [];
      const one = entry as Record<string, unknown>;
      if (typeof one.id !== 'string') return [];
      const waived = (Array.isArray(one.waived) ? one.waived : []).filter(
        (value: unknown): value is Waived =>
          typeof value === 'string' && WAIVED.includes(value as Waived),
      );
      return [{ id: one.id, subtype: wardrobe.get(one.id)?.subtype ?? null, waived }];
    },
  );

  // An empty list is no request. The words only mean something next to the
  // garments they let in, which is the same call `readOwnerRequest` makes in
  // client/lib/outfits.js, and the two have to agree or the card and the API
  // disagree about whether a request exists.
  if (honored.length === 0) return null;

  return {
    words: row.words,
    disagreement: typeof row.disagreement === 'string' ? row.disagreement : null,
    honored,
  };
}

function toCorrection(
  row: FeedbackRow,
  event: EventKind | null,
  wardrobe: ReadonlyMap<string, Garment>,
  pieces: readonly OutfitPiece[],
): Correction {
  return {
    at: row.created_at,
    event,
    slot: row.slot as Slot,
    from: row.from_id === null ? null : named(row.from_id, wardrobe),
    to: row.to_id === null ? null : named(row.to_id, wardrobe),
    reason: row.reason,
    alongside: pieces.flatMap((piece) => {
      if (piece.id === row.to_id) return [];
      const garment = wardrobe.get(piece.id);
      return garment === undefined ? [] : [{ slot: piece.slot, subtype: garment.subtype }];
    }),
  };
}

/** The UTC day an outfit belongs to, which is the day the wear log writes. */
function dayOf(createdAt: string): string {
  return createdAt.slice(0, 10);
}

/**
 * The wear log as the two readings of worn need it. A row that names an outfit
 * answers for that outfit and for nothing else, so it is kept out of `byDay`
 * entirely: otherwise a day holding three outfits would have the wear of one of
 * them speaking for all three, which is the guess `outfit_id` exists to end.
 */
interface WornLog {
  readonly outfits: ReadonlySet<string>;
  readonly byDay: ReadonlyMap<string, ReadonlySet<string>>;
}

function wornLog(events: readonly LoggedWear[]): WornLog {
  const outfits = new Set<string>();
  const byDay = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.outfitId !== null) {
      outfits.add(event.outfitId);
      continue;
    }
    const key = day(event.wornOn);
    const logged = byDay.get(key) ?? new Set<string>();
    for (const id of event.garmentIds) logged.add(id);
    byDay.set(key, logged);
  }
  return { outfits, byDay };
}

/**
 * Read against the stored ids rather than the hydrated garments, so archiving a
 * garment after the fact cannot turn a worn outfit back into an unworn one.
 */
function wasWorn(
  id: string,
  pieces: readonly OutfitPiece[],
  createdAt: string,
  worn: WornLog,
): boolean {
  if (worn.outfits.has(id)) return true;

  // All that is left to read when a wear names no outfit: every row written
  // before the column existed, and any wear logged without one since. A row
  // that names an outfit stays out of `byDay`, so nothing here answers for a
  // wear another outfit already claimed. Between unnamed rows the day is still
  // a union and a smaller outfit still matches a larger one's wear, which is
  // the guess `outfit_id` ends going forward and cannot end backwards.
  if (pieces.length === 0) return false;
  const logged = worn.byDay.get(dayOf(createdAt));
  if (logged === undefined) return false;
  return pieces.every((piece) => logged.has(piece.id));
}

function toSaved(
  row: OutfitRow,
  wardrobe: ReadonlyMap<string, GarmentView>,
  worn: WornLog,
  feedback: readonly FeedbackRow[],
  gaps: ReadonlySet<string>,
): SavedOutfit {
  const event = row.event as EventKind | null;
  const stored = parsePieces(row.pieces);
  const missedIds = ruleIds(row.missed_rules);
  const hydrated = stored.flatMap((piece) => {
    const garment = wardrobe.get(piece.id);
    // A garment archived after the outfit was saved drops out of the render
    // rather than taking the whole outfit down with it. It is still named in
    // `gone`, so a reader is not shown an outfit that is short a slot.
    return garment === undefined ? [] : [{ slot: piece.slot, garment }];
  });

  return {
    id: row.id,
    planId: row.plan_id,
    event,
    title: row.title,
    createdAt: row.created_at,
    pieces: hydrated.filter((piece) => piece.slot !== 'accessory'),
    accessories: hydrated.filter((piece) => piece.slot === 'accessory').map((piece) => piece.garment),
    rationale: row.rationale,
    cited: ruleViews(ruleIds(row.cited_rules)),
    // The stored row keeps every miss, because what was true of the outfit on
    // the day it was saved is a record. What the card shows is the shorter
    // question of what this outfit could have done differently, so a rule the
    // wardrobe cannot satisfy is left to the wardrobe screen to say once.
    //
    // Judged against the wardrobe as it stands now and not as it stood that
    // day, so buying a belt makes every old card mention the belt rule again.
    // That is the intent: the card is read to decide what to wear next, and
    // what could have been different is a question about what is owned today.
    missed: ruleViews(withSeverity(missedIds, 'prefer').filter((id) => !gaps.has(id))),
    // Not gap filtered, and it cannot be: a gap is a rule no garment in the
    // wardrobe can satisfy, which the book only ever says of a preference, so
    // the filter here would read as a rule that was never broken.
    broke: ruleViews(withSeverity(missedIds, 'require')),
    warmthCore: row.warmth_core,
    warmthWithOuter: row.warmth_with_outer,
    gone: stored.filter((piece) => !wardrobe.has(piece.id)),
    worn: wasWorn(row.id, stored, row.created_at, worn),
    wearNamed: worn.outfits.has(row.id),
    corrections: feedback.map((entry) => toCorrection(entry, event, wardrobe, stored)),
    ownerRequest: parseOwnerRequest(row.owner_request, wardrobe),
  };
}

/**
 * No body type means no rule has been judged, so nothing is a gap and every
 * stored miss is shown as it was recorded.
 */
function gapIds(
  wardrobe: ReadonlyMap<string, GarmentView>,
  profile: BodyProfile | null,
): ReadonlySet<string> {
  if (profile === null) return new Set();
  return new Set(wardrobeGaps([...wardrobe.values()], profile.bodyType).map((gap) => gap.id));
}

async function wardrobeById(db: D1Database): Promise<ReadonlyMap<string, GarmentView>> {
  const rows = await listGarments(db, {});
  return new Map(
    rows.map((row): [string, GarmentView] => [
      row.garment.id,
      { ...row.garment, photoVersion: row.photoVersion },
    ]),
  );
}

/** The corrections for a whole row set, read once and grouped, oldest first. */
async function correctionsFor(
  db: D1Database,
  ids: readonly string[],
): Promise<ReadonlyMap<string, readonly FeedbackRow[]>> {
  const result = await db
    .prepare(
      `SELECT outfit_id, slot, from_id, to_id, reason, created_at
         FROM outfit_feedback
        WHERE outfit_id IN (${ids.map(() => '?').join(', ')})
        ORDER BY created_at`,
    )
    .bind(...ids)
    .all<FeedbackRow>();

  const byOutfit = new Map<string, FeedbackRow[]>();
  for (const row of result.results) {
    const found = byOutfit.get(row.outfit_id) ?? [];
    found.push(row);
    byOutfit.set(row.outfit_id, found);
  }
  return byOutfit;
}

/** One read of everything a batch of rows needs, whatever days they fall on. */
async function hydrate(db: D1Database, rows: readonly OutfitRow[]): Promise<readonly SavedOutfit[]> {
  if (rows.length === 0) return [];

  const oldest = rows.reduce(
    (earliest, row) => (row.created_at < earliest ? row.created_at : earliest),
    rows[0]?.created_at ?? '',
  );
  const [wardrobe, wear, corrections, profile] = await Promise.all([
    wardrobeById(db),
    recentWear(db, dayOf(oldest)),
    correctionsFor(db, rows.map((row) => row.id)),
    getProfile(db),
  ]);

  const worn = wornLog(wear);
  const gaps = gapIds(wardrobe, profile);
  return rows.map((row) => toSaved(row, wardrobe, worn, corrections.get(row.id) ?? [], gaps));
}

const MS_PER_DAY = 86_400_000;

/** UTC midnight opening the day a moment falls on, spelled the way the column is. */
function dayStart(moment: Date): string {
  return `${day(moment)}T00:00:00.000Z`;
}

/**
 * Which day counts as today is the server's call, taken from the same UTC day
 * the wear log writes, so an outfit and its wear entry never disagree.
 *
 * The upper bound is what keeps a row dated ahead of the clock off this screen.
 * With the lower bound alone it would sit on Today every day after, and the cap
 * is what bounds the read now that nothing else does.
 */
export async function todayOutfits(db: D1Database, now: Date): Promise<readonly SavedOutfit[]> {
  const result = await db
    .prepare(
      'SELECT * FROM outfit WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?',
    )
    .bind(dayStart(now), dayStart(new Date(now.getTime() + MS_PER_DAY)), MAX_OUTFITS)
    .all<OutfitRow>();

  return hydrate(db, result.results);
}

/**
 * Which outfits to read. Days are `YYYY-MM-DD` and UTC, the same day the wear
 * log writes, and both ends are inclusive. Leaving both out reads the newest
 * `limit`.
 */
export interface OutfitQuery {
  readonly limit: number;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/**
 * `total` counts everything in the range and ignores `limit`, so a caller that
 * asked for three out of eight is told there are eight rather than left to
 * assume it saw all of them.
 */
export interface OutfitPage {
  readonly outfits: readonly SavedOutfit[];
  readonly total: number;
}

/**
 * The range is compared on the day rather than on the whole timestamp. It is
 * the same first ten characters `dayOf` reads, so a caller never has to know
 * that the column holds a time as well, and it cannot pick up an outfit saved
 * late on the day before the range starts.
 */
function rangeOf(query: OutfitQuery): { readonly where: string; readonly binds: readonly string[] } {
  const clauses: string[] = [];
  const binds: string[] = [];
  if (query.from !== undefined) {
    clauses.push('substr(created_at, 1, 10) >= ?');
    binds.push(query.from);
  }
  if (query.to !== undefined) {
    clauses.push('substr(created_at, 1, 10) <= ?');
    binds.push(query.to);
  }
  return { where: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, binds };
}

export async function readOutfits(db: D1Database, query: OutfitQuery): Promise<OutfitPage> {
  const { where, binds } = rangeOf(query);
  const limit = Math.min(Math.max(Math.trunc(query.limit), 1), MAX_OUTFITS);

  const page = await db
    .prepare(`SELECT * FROM outfit${where} ORDER BY created_at DESC LIMIT ?`)
    .bind(...binds, limit)
    .all<OutfitRow>();
  const outfits = await hydrate(db, page.results);

  // A short page is the whole of the range, so counting it again would be a
  // second read of the table to learn a number already in hand. The web app's
  // history screen asks for the maximum and takes this path every time.
  if (page.results.length < limit) return { outfits, total: outfits.length };

  const counted = await db
    .prepare(`SELECT count(*) AS total FROM outfit${where}`)
    .bind(...binds)
    .first<{ total: number }>();
  return { outfits, total: counted?.total ?? outfits.length };
}

async function outfitRow(db: D1Database, id: string): Promise<OutfitRow | null> {
  return db.prepare('SELECT * FROM outfit WHERE id = ?').bind(id).first<OutfitRow>();
}

/**
 * Whether an outfit with this id is stored. `outfitById` would answer the same
 * question by reading the whole wardrobe and every correction on the row, and
 * the caller that asks this only needs to know the id names something real.
 */
export async function outfitExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM outfit WHERE id = ?')
    .bind(id)
    .first<{ readonly id: string }>();
  return row !== null;
}

/** One outfit by id, hydrated the way Today and the history are. */
export async function outfitById(db: D1Database, id: string): Promise<SavedOutfit | null> {
  const row = await outfitRow(db, id);
  if (row === null) return null;
  return (await hydrate(db, [row]))[0] ?? null;
}

/** An edit turned away, which is both an answer and what planning one can end in. */
interface Refused {
  readonly kind: 'refused';
  readonly error: string;
}

export type EditResult =
  | { readonly kind: 'saved'; readonly outfit: SavedOutfit }
  | { readonly kind: 'missing' }
  | { readonly kind: 'worn' }
  | Refused;

const refused = (error: string): Refused => ({ kind: 'refused', error });

/**
 * The stored row as a `ResolvedOutfit`, which is what lets the book rules be
 * read against an outfit whose plan expired an hour after it was saved. Nothing
 * is invented: the proposal restates the row. A garment archived since drops out
 * of the check the same way `toSaved` drops it from the render.
 */
function resolvedFrom(
  stored: readonly OutfitPiece[],
  wardrobe: ReadonlyMap<string, Garment>,
  row: OutfitRow,
): ResolvedOutfit {
  const pieces: Partial<Record<Slot, Garment>> = {};
  const accessories: Garment[] = [];
  for (const piece of stored) {
    const garment = wardrobe.get(piece.id);
    if (garment === undefined) continue;
    if (piece.slot === 'accessory') accessories.push(garment);
    else pieces[piece.slot] = garment;
  }

  const idIn = (slot: Slot): string => stored.find((piece) => piece.slot === slot)?.id ?? '';
  return {
    pieces,
    accessories,
    proposal: {
      base: idIn('base'),
      bottom: idIn('bottom'),
      shoes: idIn('shoes'),
      rationale: row.rationale,
      citedRules: ruleIds(row.cited_rules),
    },
  };
}

/**
 * The stored request, minus whatever the edit just took off.
 *
 * `honored` means the requested garments this outfit is actually wearing, so a
 * piece swapped out has to leave it. Taking the last one out takes the whole
 * record with it: the words and the second opinion were about clothes, and with
 * none of them left on the outfit they would argue about something nobody is
 * wearing.
 *
 * An add never reaches this. `nextPieces` is a superset then, so nothing drops,
 * and the piece arriving never joins `honored` either: that list means the
 * garments the chat asked for by name, and it carries a `waived` list a change
 * made by hand has nothing to put in.
 */
function stillHonored(json: string | null, pieces: readonly OutfitPiece[]): string | null {
  if (json === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const row = parsed as Record<string, unknown>;
  const worn = new Set(pieces.map((piece) => piece.id));
  const honored = (Array.isArray(row.honored) ? row.honored : []).filter(
    (entry: unknown) =>
      entry !== null &&
      typeof entry === 'object' &&
      worn.has((entry as { id?: unknown }).id as string),
  );
  return honored.length === 0 ? null : JSON.stringify({ ...row, honored });
}

/**
 * An edit that met no refusal: the pieces to store, the slot the change
 * happened in, and the ids the correction records.
 */
interface PlannedEdit {
  readonly kind: 'planned';
  readonly slot: Slot;
  readonly fromId: string | null;
  readonly toId: string | null;
  /**
   * Kept apart from the outfit it is joining, so `editPiece` can judge it on its
   * own rather than judging the outfit as a whole.
   */
  readonly incoming: Garment | null;
  readonly pieces: readonly OutfitPiece[];
}

/**
 * Where a piece being added belongs in the stored array.
 *
 * `past_outfits` prints that array as it stands and sorts nothing, so a mid
 * appended to the end would reach the composer after the shoes. Inserting
 * rather than sorting the whole array leaves every piece already there exactly
 * where it is, and an accessory lands last either way.
 */
function withPiece(stored: readonly OutfitPiece[], added: OutfitPiece): readonly OutfitPiece[] {
  const rank = PIECE_ORDER.indexOf(added.slot);
  const at = stored.findIndex((piece) => PIECE_ORDER.indexOf(piece.slot) > rank);
  return at === -1 ? [...stored, added] : [...stored.slice(0, at), added, ...stored.slice(at)];
}

/**
 * Every refusal an edit can meet, and the row it becomes once it meets none.
 *
 * Formality, season, cooldown and the warmth bands are not among them, on an
 * add the same as on a swap. A layer arriving re-aims several book rules
 * through `onOutermostTorso`, so an outfit that broke nothing can gain a broken
 * rule: `recheck` reads it, the new split is stored, and the card says so.
 * Refusing would be the app telling the owner he cannot put his own jacket on,
 * at the moment he is telling the app its filters were wrong. A gap both halves
 * of one gesture share beats a new asymmetry between them.
 */
async function planEdit(
  db: D1Database,
  edit: OutfitEdit,
  stored: readonly OutfitPiece[],
  wardrobe: ReadonlyMap<string, Garment>,
): Promise<PlannedEdit | Refused> {
  if (edit.kind === 'add') {
    // The whole wardrobe and not the plan's menu, the same reading a swap
    // makes, which is what lets a change by hand reach a garment today filtered
    // out.
    const found = await getGarment(db, edit.toId);
    if (found === null) return refused('That garment is not in your wardrobe.');
    const arriving = found.garment;

    // Storage holds no clothing slot to one piece, so two rows naming one slot
    // round-trip and then collapse out of the warmth sum with nothing reporting
    // it. Accessories are a list and are never full, so only a clothing slot
    // can be taken. Read before the duplicate check below, so the owner is never
    // told something about the garment when the slot was the problem.
    const held =
      arriving.slot === 'accessory'
        ? undefined
        : stored.find((piece) => piece.slot === arriving.slot);
    if (held !== undefined) {
      // A garment archived since still holds its slot in storage while `toSaved`
      // drops it from the render, so the card can offer a slot that is taken.
      const name = wardrobe.get(held.id)?.subtype;
      return refused(
        name === undefined
          ? `The ${arriving.slot} already holds a garment that is gone from the wardrobe.`
          : `The ${arriving.slot} is already the ${name} in this outfit.`,
      );
    }
    if (stored.some((piece) => piece.id === arriving.id)) {
      return refused(`The ${arriving.subtype} is already in this outfit.`);
    }

    return {
      kind: 'planned',
      slot: arriving.slot,
      fromId: null,
      toId: arriving.id,
      incoming: arriving,
      pieces: withPiece(stored, { slot: arriving.slot, id: arriving.id }),
    };
  }

  const target = stored.find((piece) => piece.id === edit.fromId);
  if (target === undefined) return refused('That garment is not in this outfit.');

  if (edit.kind === 'drop') {
    if (REQUIRED_SLOTS.includes(target.slot)) {
      return refused(
        `An outfit needs a base, a bottom and shoes, so ${target.slot} cannot be left empty.`,
      );
    }
    return {
      kind: 'planned',
      slot: target.slot,
      fromId: target.id,
      toId: null,
      incoming: null,
      pieces: stored.filter((piece) => piece !== target),
    };
  }

  if (edit.toId === target.id) return refused(`That is already the ${target.slot} in this outfit.`);

  const found = await getGarment(db, edit.toId);
  if (found === null) return refused('That garment is not in your wardrobe.');
  const arriving = found.garment;
  // Before the duplicate check, because a garment in the wrong slot is the
  // more specific thing to say about it even when the outfit already wears it.
  if (arriving.slot !== target.slot) {
    return refused(`The ${arriving.subtype} is a ${arriving.slot}, not a ${target.slot}.`);
  }
  if (stored.some((piece) => piece.id === arriving.id)) {
    return refused(`The ${arriving.subtype} is already in this outfit.`);
  }

  return {
    kind: 'planned',
    slot: target.slot,
    fromId: target.id,
    toId: arriving.id,
    incoming: arriving,
    pieces: stored.map((piece) =>
      piece === target ? { slot: target.slot, id: arriving.id } : piece,
    ),
  };
}

/**
 * Fills, replaces or empties one slot of a saved outfit and records why in the
 * owner's own words.
 *
 * `created_at`, `plan_id`, `event` and `rationale` are never touched.
 * `created_at` in particular is the UTC day `wasWorn` reads the wear log
 * against, so moving it would detach the outfit from its own day.
 */
export async function editPiece(
  db: D1Database,
  id: string,
  edit: OutfitEdit,
  now: Date,
): Promise<EditResult> {
  const row = await outfitRow(db, id);
  if (row === null) return { kind: 'missing' };

  const current = (await hydrate(db, [row]))[0];
  if (current === undefined) return { kind: 'missing' };
  // `wasWorn` reads the stored ids against that day's wear log, so changing one
  // would quietly turn an outfit the owner wore back into an unworn one.
  if (current.worn) return { kind: 'worn' };

  const stored = parsePieces(row.pieces);
  const wardrobe = new Map<string, Garment>();
  for (const piece of current.pieces) wardrobe.set(piece.garment.id, piece.garment);
  for (const garment of current.accessories) wardrobe.set(garment.id, garment);

  const planned = await planEdit(db, edit, stored, wardrobe);
  if (planned.kind === 'refused') return planned;

  const incoming = planned.incoming;
  if (incoming !== null) wardrobe.set(incoming.id, incoming);

  const resolved = resolvedFrom(planned.pieces, wardrobe, row);
  // The same refusal `certify` makes before an outfit is saved, because a second
  // watch is a body with one wrist rather than a matter of taste.
  //
  // Judged on the garment coming in and not on the outfit as a whole. Retagging
  // a hat as a belt leaves a saved outfit already wearing two belts, and reading
  // the whole outfit would then refuse every edit on it, including the ones that
  // would fix it, and would say so while the owner was changing their shoes.
  if (incoming !== null) {
    const doubled = doubledAccessories(resolved.accessories).find((reason) =>
      reason.ids.includes(incoming.id),
    );
    if (doubled !== undefined) {
      return refused(`That would be the second ${doubled.accessoryKind} in this outfit.`);
    }
  }

  const profile = await getProfile(db);
  const checked = recheck(resolved, resolved.proposal.citedRules, profile?.bodyType ?? null);
  const request = stillHonored(row.owner_request, planned.pieces);

  // One batch, so an edit can never land with nothing saying why. The other
  // direction stopped being airtight when `removeOutfit` arrived: an outfit
  // deleted between the read above and this line leaves the UPDATE matching
  // nothing while the reason is still written, and no foreign key refuses it.
  // The owner is told the outfit is missing, so the cost is one stray
  // correction rather than a wrong answer.
  await db.batch([
    db
      .prepare(
        `UPDATE outfit
            SET pieces = ?, cited_rules = ?, missed_rules = ?, warmth_core = ?, warmth_with_outer = ?,
                owner_request = ?
          WHERE id = ?`,
      )
      .bind(
        JSON.stringify(planned.pieces),
        JSON.stringify(checked.cited.map((rule) => rule.id)),
        JSON.stringify(checked.missed.map((rule) => rule.id)),
        checked.warmthCore,
        checked.warmthWithOuter,
        request,
        id,
      ),
    db
      .prepare(
        `INSERT INTO outfit_feedback (id, outfit_id, slot, from_id, to_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        id,
        planned.slot,
        planned.fromId,
        planned.toId,
        edit.reason,
        now.toISOString(),
      ),
  ]);

  const saved = await outfitById(db, id);
  return saved === null ? { kind: 'missing' } : { kind: 'saved', outfit: saved };
}

/**
 * Removes an outfit and every wear that named it, in one batch, so no wear that
 * this could reach outlives the outfit it describes. Those garments come off
 * the cooldown that wear put them on, which is half of what removing one is
 * for. Only those: an outfit whose `worn` came from the reading below still
 * reports `worn` and still leaves its cooldown standing, so nothing shown to
 * the owner should promise otherwise.
 *
 * The `outfit_feedback` rows stay, and that is the point of keeping them: they
 * are the only record of what the owner does not want, `plan_outfit` reads them
 * for every later plan, and nothing here declares a foreign key. One left
 * behind reads as a thinner line rather than a broken one, because
 * `recentCorrections` LEFT JOINs the outfit and `parsePieces` answers a missing
 * `pieces` with no garments.
 *
 * A wear that names no outfit stays too. Finding it by its day and its garments
 * is the guess `outfit_id` was added to stop making, and getting it wrong here
 * would throw away the record of a day nobody asked about.
 */
export async function removeOutfit(db: D1Database, id: string): Promise<boolean> {
  const [removed] = await db.batch<{ readonly id: string }>([
    db.prepare('DELETE FROM outfit WHERE id = ? RETURNING id').bind(id),
    db.prepare('DELETE FROM wear_log WHERE outfit_id = ?').bind(id),
  ]);
  return removed !== undefined && removed.results.length > 0;
}

/** The newest corrections across every outfit, which is what `plan_outfit` reads. */
export async function recentCorrections(
  db: D1Database,
  limit: number,
): Promise<readonly Correction[]> {
  const result = await db
    .prepare(
      `SELECT f.outfit_id, f.slot, f.from_id, f.to_id, f.reason, f.created_at, o.event, o.pieces
         FROM outfit_feedback f
         LEFT JOIN outfit o ON o.id = f.outfit_id
        ORDER BY f.created_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<FeedbackRow & { readonly event: string | null; readonly pieces: string | null }>();

  if (result.results.length === 0) return [];

  const wardrobe = await wardrobeById(db);
  return result.results.map((row) =>
    toCorrection(
      row,
      row.event as EventKind | null,
      wardrobe,
      parsePieces(row.pieces),
    ),
  );
}

/** One name already in use, and the day it was used, as `plan_outfit` shows it. */
export interface UsedTitle {
  readonly title: string;
  readonly createdAt: string;
}

/** The newest names already on an outfit, which is what `plan_outfit` reads. */
export async function recentTitles(db: D1Database, limit: number): Promise<readonly UsedTitle[]> {
  const result = await db
    .prepare(
      `SELECT title, created_at
         FROM outfit
        WHERE title IS NOT NULL AND trim(title) <> ''
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ readonly title: string; readonly created_at: string }>();

  return result.results.map((row) => ({ title: row.title, createdAt: row.created_at }));
}

/**
 * How many outfits are saved against one plan, which is what `save_outfit` says
 * back. A tool result is text and nothing else, so a composer part way through a
 * set has no other way to learn that its earlier save landed.
 */
export async function outfitsInPlan(db: D1Database, planId: string): Promise<number> {
  const row = await db
    .prepare('SELECT count(*) AS total FROM outfit WHERE plan_id = ?')
    .bind(planId)
    .first<{ readonly total: number }>();

  return row?.total ?? 0;
}

/**
 * When an outfit already carries this name, the day it was saved on.
 *
 * The comparison ignores case and the spaces around a name and nothing else,
 * because two names that differ only in capitalization are one name to the
 * person reading them. SQLite's `lower` is ASCII only, so an accent still tells
 * two names apart. That is deliberate and not worth more machinery.
 */
export async function titleTaken(db: D1Database, title: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT created_at
         FROM outfit
        WHERE title IS NOT NULL AND lower(trim(title)) = lower(trim(?))
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .bind(title)
    .first<{ readonly created_at: string }>();

  return row === null ? null : row.created_at;
}
