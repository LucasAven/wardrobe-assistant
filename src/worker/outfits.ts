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
import { recheck } from '../domain/certify';
import { wardrobeGaps } from '../domain/gaps';
import type {
  BodyProfile,
  EventKind,
  Garment,
  ResolvedOutfit,
  Slot,
  Waived,
} from '../domain/types';
import { ruleView } from './compose';
import type { GarmentView, OutfitView, RuleView } from './contract';
import { getProfile } from './profile';
import { getGarment, listGarments } from './repo';
import type { LoggedWear } from './routes/wear';
import { day, recentWear } from './routes/wear';

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

export interface OutfitPiece {
  readonly slot: Slot;
  readonly id: string;
}

/** One garment the owner asked for, and the filters admitting it turned off. */
export interface Waiver {
  readonly id: string;
  /** Empty when the garment passed today's filters anyway and the request changed nothing. */
  readonly waived: readonly Waived[];
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

/** The same, as the app reads it. `subtype` is null for a garment archived since. */
export interface HonoredRequest extends Waiver {
  readonly subtype: string | null;
}

export interface OwnerRequest {
  readonly words: string;
  readonly disagreement: string | null;
  readonly honored: readonly HonoredRequest[];
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

/** One piece of a saved outfit changed by hand, as the owner asked for it. */
export interface OutfitEdit {
  readonly slot: Slot;
  /** Null empties the slot rather than filling it. */
  readonly toId: string | null;
  readonly reason: string;
}

/** One correction, hydrated. `subtype` is null for a garment archived since. */
export interface Correction {
  readonly at: string;
  readonly event: EventKind | null;
  readonly slot: Slot;
  readonly from: { readonly id: string; readonly subtype: string | null };
  readonly to: { readonly id: string; readonly subtype: string | null } | null;
  readonly reason: string;
  /**
   * The rest of the outfit the rejected garment was standing in, newest state.
   *
   * Without it a reason like "too many layers" names no layers and cannot be
   * acted on: the reader is told a garment was taken out and never told what it
   * was taken out of. Derived rather than stored, by dropping the incoming
   * garment from the outfit as it stands, which is exact for one correction and
   * approximate once an outfit has been corrected twice.
   */
  readonly alongside: readonly { readonly slot: Slot; readonly subtype: string }[];
}

/** What the web app reads. `OutfitView` plus the state only a stored outfit has. */
export interface SavedOutfit extends OutfitView {
  /**
   * Narrowed to the view garment, because these are the ones the card draws and
   * a cutout the owner edited only reaches them through `photoVersion`.
   */
  readonly pieces: readonly { readonly slot: Slot; readonly garment: GarmentView }[];
  readonly accessories: readonly GarmentView[];
  readonly id: string;
  readonly event: EventKind | null;
  /**
   * What the assistant called this outfit, its own words the way the rationale
   * is. Null on anything saved before the column existed.
   */
  readonly title: string | null;
  readonly createdAt: string;
  /** Every garment in it was logged as worn on the day it was saved. */
  readonly worn: boolean;
  /**
   * What the owner changed by hand, oldest first. Empty for an untouched
   * outfit, which is also what says the outfit was never corrected: the rows
   * are the record, so no column repeats it.
   */
  readonly corrections: readonly Correction[];
  /**
   * Pieces whose garment has been archived since. The card cannot draw one, it
   * has no photo left, but leaving them out of a reader's count would show an
   * outfit missing a slot every outfit is required to have.
   */
  readonly gone: readonly OutfitPiece[];
  /**
   * What the owner asked for by name on the day this was planned, and what
   * admitting it turned off. Null for every outfit nobody overrode a filter for,
   * which is almost all of them.
   */
  readonly ownerRequest: OwnerRequest | null;
}

interface OutfitRow {
  readonly id: string;
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
  readonly from_id: string;
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

const WAIVED: readonly Waived[] = ['season', 'formality', 'rain', 'cooldown'];

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
  // public/lib/outfits.js, and the two have to agree or the card and the API
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
    from: named(row.from_id, wardrobe),
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

function loggedByDay(events: readonly LoggedWear[]): ReadonlyMap<string, ReadonlySet<string>> {
  const byDay = new Map<string, Set<string>>();
  for (const event of events) {
    const key = day(event.wornOn);
    const logged = byDay.get(key) ?? new Set<string>();
    for (const id of event.garmentIds) logged.add(id);
    byDay.set(key, logged);
  }
  return byDay;
}

/**
 * Read against the stored ids rather than the hydrated garments, so archiving a
 * garment after the fact cannot turn a worn outfit back into an unworn one.
 */
function wasWorn(
  pieces: readonly OutfitPiece[],
  createdAt: string,
  byDay: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (pieces.length === 0) return false;
  const logged = byDay.get(dayOf(createdAt));
  if (logged === undefined) return false;
  return pieces.every((piece) => logged.has(piece.id));
}

function toSaved(
  row: OutfitRow,
  wardrobe: ReadonlyMap<string, GarmentView>,
  byDay: ReadonlyMap<string, ReadonlySet<string>>,
  feedback: readonly FeedbackRow[],
  gaps: ReadonlySet<string>,
): SavedOutfit {
  const event = row.event as EventKind | null;
  const stored = parsePieces(row.pieces);
  const hydrated = stored.flatMap((piece) => {
    const garment = wardrobe.get(piece.id);
    // A garment archived after the outfit was saved drops out of the render
    // rather than taking the whole outfit down with it. It is still named in
    // `gone`, so a reader is not shown an outfit that is short a slot.
    return garment === undefined ? [] : [{ slot: piece.slot, garment }];
  });

  return {
    id: row.id,
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
    missed: ruleViews(ruleIds(row.missed_rules).filter((id) => !gaps.has(id))),
    warmthCore: row.warmth_core,
    warmthWithOuter: row.warmth_with_outer,
    gone: stored.filter((piece) => !wardrobe.has(piece.id)),
    worn: wasWorn(stored, row.created_at, byDay),
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

  const byDay = loggedByDay(wear);
  const gaps = gapIds(wardrobe, profile);
  return rows.map((row) => toSaved(row, wardrobe, byDay, corrections.get(row.id) ?? [], gaps));
}

/**
 * Which day counts as today is the server's call, taken from the same UTC day
 * the wear log writes, so an outfit and its wear entry never disagree.
 */
export async function todayOutfit(db: D1Database, now: Date): Promise<SavedOutfit | null> {
  const result = await db
    .prepare('SELECT * FROM outfit WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1')
    .bind(`${day(now)}T00:00:00.000Z`)
    .all<OutfitRow>();

  const hydrated = await hydrate(db, result.results);
  return hydrated[0] ?? null;
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

/** One outfit by id, hydrated the way Today and the history are. */
export async function outfitById(db: D1Database, id: string): Promise<SavedOutfit | null> {
  const row = await outfitRow(db, id);
  if (row === null) return null;
  return (await hydrate(db, [row]))[0] ?? null;
}

export type SwapResult =
  | { readonly kind: 'saved'; readonly outfit: SavedOutfit }
  | { readonly kind: 'missing' }
  | { readonly kind: 'worn' }
  | { readonly kind: 'refused'; readonly error: string };

const refused = (error: string): SwapResult => ({ kind: 'refused', error });

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
 * Replaces or empties one slot of a saved outfit and records why in the owner's
 * own words.
 *
 * `created_at`, `plan_id`, `event` and `rationale` are never touched.
 * `created_at` in particular is the UTC day `wasWorn` reads the wear log
 * against, so moving it would detach the outfit from its own day.
 */
/**
 * The stored request, minus whatever the swap just took off.
 *
 * `honored` means the requested garments this outfit is actually wearing, so a
 * piece swapped out has to leave it. Taking the last one out takes the whole
 * record with it: the words and the second opinion were about clothes, and with
 * none of them left on the outfit they would argue about something nobody is
 * wearing.
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

export async function swapPiece(
  db: D1Database,
  id: string,
  edit: OutfitEdit,
  now: Date,
): Promise<SwapResult> {
  const row = await outfitRow(db, id);
  if (row === null) return { kind: 'missing' };

  const current = (await hydrate(db, [row]))[0];
  if (current === undefined) return { kind: 'missing' };
  // `wasWorn` reads the stored ids against that day's wear log, so changing one
  // would quietly turn an outfit the owner wore back into an unworn one.
  if (current.worn) return { kind: 'worn' };

  const stored = parsePieces(row.pieces);
  // One match for every slot the card can tap: an outfit holds one garment per
  // slot, and the exception, accessories, is not drawn as a tile.
  const target = stored.find((piece) => piece.slot === edit.slot);
  if (target === undefined) return refused(`There is nothing in ${edit.slot} to change.`);

  if (edit.toId === null && REQUIRED_SLOTS.includes(edit.slot)) {
    return refused(
      `An outfit needs a base, a bottom and shoes, so ${edit.slot} cannot be left empty.`,
    );
  }
  if (edit.toId === target.id) return refused(`That is already the ${edit.slot} in this outfit.`);

  let incoming: Garment | null = null;
  if (edit.toId !== null) {
    const found = await getGarment(db, edit.toId);
    if (found === null) return refused('That garment is not in your wardrobe.');
    // Before the duplicate check, because a garment in the wrong slot is the
    // more specific thing to say about it even when the outfit already wears it.
    if (found.garment.slot !== edit.slot) {
      return refused(`The ${found.garment.subtype} is a ${found.garment.slot}, not a ${edit.slot}.`);
    }
    if (stored.some((piece) => piece.id === edit.toId)) {
      return refused(`The ${found.garment.subtype} is already in this outfit.`);
    }
    incoming = found.garment;
  }

  const nextPieces = stored.flatMap((piece): OutfitPiece[] => {
    if (piece !== target) return [piece];
    return edit.toId === null ? [] : [{ slot: piece.slot, id: edit.toId }];
  });

  const wardrobe = new Map<string, Garment>();
  for (const piece of current.pieces) wardrobe.set(piece.garment.id, piece.garment);
  for (const garment of current.accessories) wardrobe.set(garment.id, garment);
  if (incoming !== null) wardrobe.set(incoming.id, incoming);

  const resolved = resolvedFrom(nextPieces, wardrobe, row);
  const profile = await getProfile(db);
  const checked = recheck(resolved, resolved.proposal.citedRules, profile?.bodyType ?? null);
  const request = stillHonored(row.owner_request, nextPieces);

  // One batch, so a reason can never be recorded for a swap that did not land,
  // and a swap can never land with nothing saying why.
  await db.batch([
    db
      .prepare(
        `UPDATE outfit
            SET pieces = ?, cited_rules = ?, missed_rules = ?, warmth_core = ?, warmth_with_outer = ?,
                owner_request = ?
          WHERE id = ?`,
      )
      .bind(
        JSON.stringify(nextPieces),
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
      .bind(crypto.randomUUID(), id, edit.slot, target.id, edit.toId, edit.reason, now.toISOString()),
  ]);

  const saved = await outfitById(db, id);
  return saved === null ? { kind: 'missing' } : { kind: 'saved', outfit: saved };
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
