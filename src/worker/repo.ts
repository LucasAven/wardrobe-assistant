import { z } from 'zod';
import type { Garment, GarmentId } from '../domain/types';
import type { GarmentTags } from './vision';
import { GarmentDraftSchema, TAGGED_FIELDS } from './vision';

/** A row as it comes back, split into the domain garment and the review state around it. */
export interface StoredGarment {
  readonly garment: Garment;
  /**
   * How many times the stored photo has been rewritten. `/img/:kind/:id` answers
   * `immutable`, so this is what the app hangs off the URL to see a new cutout.
   */
  readonly photoVersion: number;
  readonly reviewed: boolean;
  readonly uncertain: readonly string[];
  readonly archived: boolean;
  readonly createdAt: string;
}

const jsonArrayOf = <T extends z.ZodType>(item: T) =>
  z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        ctx.addIssue({ code: 'custom', message: 'column does not hold valid JSON' });
        return z.NEVER;
      }
    })
    .pipe(z.array(item));

const boolColumn = z.number().int().transform((value) => value !== 0);

const shape = GarmentDraftSchema.shape;

/**
 * The only place a row becomes a `Garment`. `GarmentId` is otherwise minted by
 * resolving against a Menu, but an id read back out of its own primary key
 * column is by definition already a real one.
 */
export const GarmentRowSchema = z
  .object({
    id: z.string(),
    slot: shape.slot,
    subtype: shape.subtype,
    image_original: z.string(),
    image_cutout: z.string().nullable(),
    photo_version: z.number().int(),
    colors: jsonArrayOf(z.string()),
    color_role: shape.colorRole,
    pattern: shape.pattern,
    fabric: shape.fabric,
    warmth: shape.warmth,
    formality: shape.formality,
    fit: shape.fit,
    structured: boolColumn,
    rise: shape.rise,
    leg: shape.leg,
    hem: shape.hem,
    neckline: shape.neckline,
    sleeves: shape.sleeves,
    accessory_kind: shape.accessoryKind,
    shoulder_bulk: boolColumn,
    water_resistant: boolColumn,
    seasons: jsonArrayOf(z.enum(['spring', 'summer', 'autumn', 'winter'])),
    notes: z.string().nullable(),
    reviewed: boolColumn,
    uncertain: jsonArrayOf(z.string()),
    archived: boolColumn,
    created_at: z.string(),
  })
  .transform(
    (row): StoredGarment => ({
      garment: {
        id: row.id as GarmentId,
        slot: row.slot,
        subtype: row.subtype,
        imageOriginal: row.image_original,
        imageCutout: row.image_cutout,
        colors: row.colors,
        colorRole: row.color_role,
        pattern: row.pattern,
        fabric: row.fabric,
        warmth: row.warmth,
        formality: row.formality,
        fit: row.fit,
        structured: row.structured,
        rise: row.rise,
        leg: row.leg,
        hem: row.hem,
        neckline: row.neckline,
        sleeves: row.sleeves,
        accessoryKind: row.accessory_kind,
        shoulderBulk: row.shoulder_bulk,
        waterResistant: row.water_resistant,
        seasons: row.seasons,
        notes: row.notes,
      },
      photoVersion: row.photo_version,
      reviewed: row.reviewed,
      uncertain: row.uncertain,
      archived: row.archived,
      createdAt: row.created_at,
    }),
  );

export function parseGarmentRow(row: unknown): StoredGarment {
  return GarmentRowSchema.parse(row);
}

/** Flat shape for the API. The PWA wants one object, not a garment inside a wrapper. */
export function toJson(stored: StoredGarment): Record<string, unknown> {
  return {
    ...stored.garment,
    photoVersion: stored.photoVersion,
    reviewed: stored.reviewed,
    uncertain: stored.uncertain,
    archived: stored.archived,
    createdAt: stored.createdAt,
  };
}

const bit = (value: boolean): number => (value ? 1 : 0);

/**
 * Column name paired with its bound value, so an insert and an update can never
 * disagree about the order.
 */
function tagBindings(tags: GarmentTags): ReadonlyArray<readonly [string, unknown]> {
  return [
    ['slot', tags.slot],
    ['subtype', tags.subtype],
    ['colors', JSON.stringify(tags.colors)],
    ['color_role', tags.colorRole],
    ['pattern', tags.pattern],
    ['fabric', tags.fabric],
    ['warmth', tags.warmth],
    ['formality', tags.formality],
    ['fit', tags.fit],
    ['structured', bit(tags.structured)],
    ['rise', tags.rise],
    ['leg', tags.leg],
    ['hem', tags.hem],
    ['neckline', tags.neckline],
    ['sleeves', tags.sleeves],
    ['accessory_kind', tags.accessoryKind],
    ['shoulder_bulk', bit(tags.shoulderBulk)],
    ['water_resistant', bit(tags.waterResistant)],
    ['seasons', JSON.stringify(tags.seasons)],
    ['notes', tags.notes],
  ];
}

export interface NewGarment {
  readonly id: string;
  readonly imageOriginal: string;
  readonly imageCutout: string | null;
  readonly tags: GarmentTags;
  readonly uncertain: readonly string[];
}

export async function insertGarment(db: D1Database, input: NewGarment): Promise<StoredGarment> {
  const tags = tagBindings(input.tags);
  const columns = [
    'id',
    'image_original',
    'image_cutout',
    ...tags.map(([column]) => column),
    'uncertain',
    'reviewed',
  ];
  const values = [
    input.id,
    input.imageOriginal,
    input.imageCutout,
    ...tags.map(([, value]) => value),
    JSON.stringify(input.uncertain),
    0,
  ];

  const sql = `INSERT INTO garment (${columns.join(', ')}) VALUES (${columns
    .map(() => '?')
    .join(', ')}) RETURNING *`;
  const row = await db.prepare(sql).bind(...values).first();
  if (row === null) throw new Error('insert returned no row');
  return parseGarmentRow(row);
}

/**
 * What every photo write ends with. The cutout key rides along because a garment
 * whose first cutout failed has none stored, and an edit or a fresh segment pass
 * is where it gets one. Touches no tag column, so a garment the owner already
 * confirmed keeps its answers when its photo changes.
 */
export async function bumpPhotoVersion(
  db: D1Database,
  id: string,
  cutoutKey: string | null,
): Promise<StoredGarment | null> {
  const row = await db
    .prepare(
      'UPDATE garment SET photo_version = photo_version + 1, image_cutout = ? WHERE id = ? AND archived = 0 RETURNING *',
    )
    .bind(cutoutKey, id)
    .first();
  return row === null ? null : parseGarmentRow(row);
}

/**
 * Retag writes machine tags, so it drops the row back to unreviewed even if a
 * human had confirmed the old ones.
 */
export async function replaceTags(
  db: D1Database,
  id: string,
  tags: GarmentTags,
  uncertain: readonly string[],
): Promise<StoredGarment | null> {
  const bindings = tagBindings(tags);
  const sets = [...bindings.map(([column]) => `${column} = ?`), 'uncertain = ?', 'reviewed = 0'];
  const values = [...bindings.map(([, value]) => value), JSON.stringify(uncertain), id];

  const sql = `UPDATE garment SET ${sets.join(', ')} WHERE id = ? AND archived = 0 RETURNING *`;
  const row = await db.prepare(sql).bind(...values).first();
  return row === null ? null : parseGarmentRow(row);
}

export const GarmentPatchSchema = GarmentDraftSchema.partial();
export type GarmentPatch = z.infer<typeof GarmentPatchSchema>;

const PATCH_COLUMN: Readonly<Record<keyof GarmentPatch, string>> = {
  slot: 'slot',
  subtype: 'subtype',
  colors: 'colors',
  colorRole: 'color_role',
  pattern: 'pattern',
  fabric: 'fabric',
  warmth: 'warmth',
  formality: 'formality',
  fit: 'fit',
  structured: 'structured',
  rise: 'rise',
  leg: 'leg',
  hem: 'hem',
  neckline: 'neckline',
  sleeves: 'sleeves',
  accessoryKind: 'accessory_kind',
  shoulderBulk: 'shoulder_bulk',
  waterResistant: 'water_resistant',
  seasons: 'seasons',
  notes: 'notes',
  uncertain: 'uncertain',
};

function encodeColumn(value: unknown): unknown {
  if (typeof value === 'boolean') return bit(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
}

/**
 * `reviewed` records that the owner has looked at the row, so only a write the
 * owner made may set it. Both writers clear the doubt list unless the caller
 * sent a new one, which is what moves a row out of the untagged state.
 */
async function writeTags(
  db: D1Database,
  id: string,
  patch: GarmentPatch,
  confirmed: boolean,
): Promise<StoredGarment | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    sets.push(`${PATCH_COLUMN[field as keyof GarmentPatch]} = ?`);
    values.push(encodeColumn(value));
  }
  if (patch.uncertain === undefined) {
    sets.push('uncertain = ?');
    values.push('[]');
  }
  if (confirmed) sets.push('reviewed = 1');

  const sql = `UPDATE garment SET ${sets.join(', ')} WHERE id = ? AND archived = 0 RETURNING *`;
  const row = await db.prepare(sql).bind(...values, id).first();
  return row === null ? null : parseGarmentRow(row);
}

/** A hand correction settles the row, so it also marks it reviewed. */
export function patchGarment(
  db: D1Database,
  id: string,
  patch: GarmentPatch,
): Promise<StoredGarment | null> {
  return writeTags(db, id, patch, true);
}

/**
 * What the connector writes after looking at a photo. It leaves `reviewed`
 * alone, so a garment nobody has confirmed lands in the Review screen with
 * these values already filled in and the owner only corrects what is wrong. A
 * garment the owner already confirmed stays confirmed, which is what makes this
 * safe to call on a correction too.
 */
export function describeGarment(
  db: D1Database,
  id: string,
  patch: GarmentPatch,
): Promise<StoredGarment | null> {
  return writeTags(db, id, patch, false);
}

/**
 * Nothing has ever looked at this photo. `blankDraft` flags every tagged field,
 * so a row still flagging all of them is a row holding placeholders. Mirrors
 * `isUntagged` in public/lib/garments.js.
 */
export function isUntagged(stored: StoredGarment): boolean {
  const flagged = new Set(stored.uncertain);
  return TAGGED_FIELDS.every((name) => flagged.has(name));
}

export async function getGarment(db: D1Database, id: string): Promise<StoredGarment | null> {
  const row = await db.prepare('SELECT * FROM garment WHERE id = ? AND archived = 0').bind(id).first();
  return row === null ? null : parseGarmentRow(row);
}

export async function listGarments(
  db: D1Database,
  filter: { readonly reviewed?: boolean },
): Promise<readonly StoredGarment[]> {
  const statement =
    filter.reviewed === undefined
      ? db.prepare('SELECT * FROM garment WHERE archived = 0 ORDER BY created_at DESC')
      : db
          .prepare('SELECT * FROM garment WHERE archived = 0 AND reviewed = ? ORDER BY created_at DESC')
          .bind(bit(filter.reviewed));

  const result = await statement.all();
  return result.results.map(parseGarmentRow);
}

export async function archiveGarment(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare('UPDATE garment SET archived = 1 WHERE id = ? AND archived = 0 RETURNING id')
    .bind(id)
    .first();
  return row !== null;
}
