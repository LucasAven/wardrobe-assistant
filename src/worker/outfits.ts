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
import type { EventKind, Garment, Slot } from '../domain/types';
import { ruleView } from './compose';
import type { OutfitView, RuleView } from './contract';
import { listGarments } from './repo';
import type { LoggedWear } from './routes/wear';
import { day, recentWear } from './routes/wear';

/** Base to shoes, then accessories. The order an outfit is read in. */
const PIECE_ORDER: readonly Slot[] = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes', 'accessory'];

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

export interface OutfitPiece {
  readonly slot: Slot;
  readonly id: string;
}

export interface NewOutfit {
  readonly planId: string;
  readonly event: EventKind;
  readonly pieces: readonly OutfitPiece[];
  readonly rationale: string;
  readonly citedRules: readonly string[];
  readonly missedRules: readonly string[];
  readonly warmthCore: number;
  readonly warmthWithOuter: number;
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
         (id, plan_id, event, pieces, rationale, cited_rules, missed_rules, warmth_core, warmth_with_outer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      outfit.planId,
      outfit.event,
      JSON.stringify(outfit.pieces),
      outfit.rationale,
      JSON.stringify(outfit.citedRules),
      JSON.stringify(outfit.missedRules),
      outfit.warmthCore,
      outfit.warmthWithOuter,
      // ISO rather than SQLite's `datetime('now')`, so the first ten characters
      // are the same UTC day the wear log writes and the two can be compared.
      savedAt.toISOString(),
    )
    .run();
  return id;
}

/** What the web app reads. `OutfitView` plus the state only a stored outfit has. */
export interface SavedOutfit extends OutfitView {
  readonly id: string;
  readonly event: EventKind | null;
  readonly createdAt: string;
  /** Every garment in it was logged as worn on the day it was saved. */
  readonly worn: boolean;
}

interface OutfitRow {
  readonly id: string;
  readonly event: string | null;
  readonly pieces: string;
  readonly rationale: string;
  readonly cited_rules: string;
  readonly missed_rules: string;
  readonly warmth_core: number;
  readonly warmth_with_outer: number;
  readonly created_at: string;
}

function parsePieces(json: string): readonly OutfitPiece[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (piece): piece is OutfitPiece =>
      typeof piece === 'object' &&
      piece !== null &&
      typeof (piece as OutfitPiece).id === 'string' &&
      PIECE_ORDER.includes((piece as OutfitPiece).slot),
  );
}

function ruleViews(json: string): readonly RuleView[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((id: unknown): RuleView[] => {
    const rule = typeof id === 'string' ? RULES_BY_ID.get(id) : undefined;
    return rule === undefined ? [] : [ruleView(rule)];
  });
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
  wardrobe: ReadonlyMap<string, Garment>,
  byDay: ReadonlyMap<string, ReadonlySet<string>>,
): SavedOutfit {
  const stored = parsePieces(row.pieces);
  const hydrated = stored.flatMap((piece) => {
    const garment = wardrobe.get(piece.id);
    // A garment archived after the outfit was saved drops out of the render
    // rather than taking the whole outfit down with it.
    return garment === undefined ? [] : [{ slot: piece.slot, garment }];
  });

  return {
    id: row.id,
    event: row.event as EventKind | null,
    createdAt: row.created_at,
    pieces: hydrated.filter((piece) => piece.slot !== 'accessory'),
    accessories: hydrated.filter((piece) => piece.slot === 'accessory').map((piece) => piece.garment),
    rationale: row.rationale,
    cited: ruleViews(row.cited_rules),
    missed: ruleViews(row.missed_rules),
    warmthCore: row.warmth_core,
    warmthWithOuter: row.warmth_with_outer,
    worn: wasWorn(stored, row.created_at, byDay),
  };
}

async function wardrobeById(db: D1Database): Promise<ReadonlyMap<string, Garment>> {
  const rows = await listGarments(db, {});
  return new Map(rows.map((row): [string, Garment] => [row.garment.id, row.garment]));
}

/** One read of everything a batch of rows needs, whatever days they fall on. */
async function hydrate(db: D1Database, rows: readonly OutfitRow[]): Promise<readonly SavedOutfit[]> {
  if (rows.length === 0) return [];

  const oldest = rows.reduce(
    (earliest, row) => (row.created_at < earliest ? row.created_at : earliest),
    rows[0]?.created_at ?? '',
  );
  const [wardrobe, wear] = await Promise.all([
    wardrobeById(db),
    recentWear(db, dayOf(oldest)),
  ]);

  const byDay = loggedByDay(wear);
  return rows.map((row) => toSaved(row, wardrobe, byDay));
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

export async function recentOutfits(db: D1Database, limit: number): Promise<readonly SavedOutfit[]> {
  const result = await db
    .prepare('SELECT * FROM outfit ORDER BY created_at DESC LIMIT ?')
    .bind(Math.min(Math.max(Math.trunc(limit), 1), MAX_OUTFITS))
    .all<OutfitRow>();
  return hydrate(db, result.results);
}
