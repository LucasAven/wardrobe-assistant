/**
 * A D1 and a KV that answer the exact statements this app runs, so the
 * connector can be driven end to end without a network or a container.
 *
 * Any statement not listed throws rather than returning nothing, because a
 * silent empty result reads as a passing test.
 */

import type { Garment } from '../../src/domain/types';
import { TAGGED_FIELDS } from '../../src/worker/vision';

export type Row = Record<string, unknown>;

const bit = (value: boolean): number => (value ? 1 : 0);

export interface RowOptions {
  readonly reviewed?: boolean;
  readonly photoVersion?: number;
  readonly uncertain?: readonly string[];
  readonly archived?: boolean;
  readonly createdAt?: string;
  /**
   * A photo nobody has described yet. Flags every tagged field the way
   * `blankDraft` does at upload, which is the only thing that marks the row
   * untagged, and implies not reviewed.
   */
  readonly untagged?: boolean;
}

/** A domain garment as the column shape `repo.ts` reads back. */
export function garmentRow(garment: Garment, options: RowOptions = {}): Row {
  return {
    id: garment.id,
    slot: garment.slot,
    subtype: garment.subtype,
    image_original: garment.imageOriginal,
    image_cutout: garment.imageCutout,
    photo_version: options.photoVersion ?? 0,
    colors: JSON.stringify(garment.colors),
    color_role: garment.colorRole,
    pattern: garment.pattern,
    fabric: garment.fabric,
    warmth: garment.warmth,
    formality: garment.formality,
    fit: garment.fit,
    structured: bit(garment.structured),
    rise: garment.rise,
    leg: garment.leg,
    hem: garment.hem,
    neckline: garment.neckline,
    sleeves: garment.sleeves,
    accessory_kind: garment.accessoryKind,
    shoulder_bulk: bit(garment.shoulderBulk),
    water_resistant: bit(garment.waterResistant),
    seasons: JSON.stringify(garment.seasons),
    notes: garment.notes,
    reviewed: bit(options.reviewed ?? options.untagged !== true),
    uncertain: JSON.stringify(
      options.uncertain ?? (options.untagged === true ? TAGGED_FIELDS : []),
    ),
    archived: bit(options.archived ?? false),
    created_at: options.createdAt ?? '2026-05-01 09:00:00',
  };
}

function columnsOf(sql: string, table: string): readonly string[] {
  const match = new RegExp(`INSERT INTO ${table}\\s*\\(([^)]+)\\)`).exec(sql);
  if (match?.[1] === undefined) throw new Error(`cannot read the column list of: ${sql}`);
  return match[1].split(',').map((name) => name.trim());
}

function rowFrom(columns: readonly string[], args: readonly unknown[]): Row {
  const row: Row = {};
  columns.forEach((column, index) => {
    row[column] = args[index] ?? null;
  });
  return row;
}

/** A row the title queries can see: both of them skip a null and a blank name. */
function named(row: Row): boolean {
  return typeof row.title === 'string' && row.title.trim() !== '';
}

function descending(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function ascending(left: string, right: string): number {
  return descending(right, left);
}

export class FakeDb {
  public profile: Row | null = null;
  public garments: Row[] = [];
  public wear: Row[] = [];
  public outfits: Row[] = [];
  public feedback: Row[] = [];

  /** Sequential, so a batch lands in the order it was written. */
  async batch(
    statements: readonly { readonly run: () => Promise<{ success: true }> }[],
  ): Promise<{ success: true }[]> {
    const results: { success: true }[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql: string): {
    bind: (...args: unknown[]) => ReturnType<FakeDb['prepare']>;
    first: <T>() => Promise<T | null>;
    all: <T>() => Promise<{ results: T[] }>;
    run: () => Promise<{ success: true }>;
  } {
    const make = (args: readonly unknown[]): ReturnType<FakeDb['prepare']> => ({
      bind: (...next: unknown[]) => make(next),
      first: async <T,>() => (this.exec(sql, args)[0] ?? null) as T | null,
      all: async <T,>() => ({ results: this.exec(sql, args) as T[] }),
      run: async () => {
        this.exec(sql, args);
        return { success: true } as const;
      },
    });
    return make([]);
  }

  private exec(sql: string, args: readonly unknown[]): Row[] {
    if (sql.includes('INSERT INTO profile')) {
      this.profile = { ...this.profile, data: args[0] };
      return [];
    }
    if (sql.includes('FROM profile')) return this.profile === null ? [] : [this.profile];
    if (sql.startsWith('UPDATE profile')) {
      // Both home statements land here, and the clearing one binds nothing. No
      // row means no write, the way an UPDATE that matches nothing behaves.
      if (this.profile !== null) {
        this.profile = { ...this.profile, home_lat: args[0] ?? null, home_lon: args[1] ?? null };
      }
      return [];
    }

    if (sql.includes('INSERT INTO wear_log')) {
      this.wear.unshift({ worn_on: args[1], garment_ids: args[2], event: args[3] ?? null });
      return [];
    }
    if (sql.includes('FROM wear_log')) {
      const since = String(args[0]);
      return this.wear
        .filter((row) => String(row.worn_on) >= since)
        .sort((left, right) => descending(String(left.worn_on), String(right.worn_on)));
    }

    if (sql.includes('INSERT INTO outfit_feedback')) {
      this.feedback.push(rowFrom(columnsOf(sql, 'outfit_feedback'), args));
      return [];
    }
    if (sql.includes('FROM outfit_feedback')) return this.selectFeedback(sql, args);

    if (sql.includes('INSERT INTO outfit')) {
      this.outfits.push(rowFrom(columnsOf(sql, 'outfit'), args));
      return [];
    }
    if (sql.startsWith('UPDATE outfit')) return this.updateOutfit(sql, args);
    if (sql.includes('FROM outfit')) {
      if (sql.includes('WHERE id = ?')) {
        return this.outfits.filter((row) => String(row.id) === String(args[0]));
      }

      const ordered = [...this.outfits].sort((left, right) =>
        descending(String(left.created_at), String(right.created_at)),
      );
      // todayOutfit, which compares the whole timestamp rather than the day.
      if (sql.includes('created_at >= ?')) {
        const since = String(args[0]);
        return ordered.filter((row) => String(row.created_at) >= since).slice(0, 1);
      }

      // recentTitles, which reads the names rather than the outfits carrying them.
      if (sql.includes("WHERE title IS NOT NULL AND trim(title) <> ''")) {
        return ordered.filter((row) => named(row)).slice(0, Number(args[0]));
      }
      // titleTaken, whose comparison ignores case and the spaces around a name.
      if (sql.includes('lower(trim(title)) = lower(trim(?))')) {
        const wanted = String(args[0]).trim().toLowerCase();
        return ordered
          .filter((row) => named(row) && String(row.title).trim().toLowerCase() === wanted)
          .slice(0, 1);
      }

      const rest = [...args];
      let rows = ordered;
      let read = 0;
      if (sql.includes('substr(created_at, 1, 10) >= ?')) {
        const from = String(rest.shift());
        rows = rows.filter((row) => String(row.created_at).slice(0, 10) >= from);
        read += 1;
      }
      if (sql.includes('substr(created_at, 1, 10) <= ?')) {
        const to = String(rest.shift());
        rows = rows.filter((row) => String(row.created_at).slice(0, 10) <= to);
        read += 1;
      }
      // The clauses are matched by their exact spelling, so reformatting one in
      // the real query would leave this stub quietly returning the whole table
      // and every range test passing on a filter that never ran.
      if (sql.includes('WHERE') && read === 0) {
        throw new Error(`unrecognised outfit filter, so this stub would not have filtered: ${sql}`);
      }
      if (sql.includes('count(*)')) return [{ total: rows.length }];
      return rows.slice(0, Number(rest[0]));
    }

    if (sql.startsWith('UPDATE garment SET')) return this.updateGarment(sql, args);
    if (sql.includes('FROM garment')) return this.selectGarments(sql, args);

    throw new Error(`unstubbed sql: ${sql}`);
  }

  /** Oldest first for one outfit's own corrections, newest first for the join. */
  private selectFeedback(sql: string, args: readonly unknown[]): Row[] {
    const ordered = [...this.feedback].sort((left, right) =>
      ascending(String(left.created_at), String(right.created_at)),
    );

    if (sql.includes('LEFT JOIN outfit')) {
      // The join carries the outfit's own columns, and a miss yields null for
      // each of them the way a real LEFT JOIN does.
      return ordered
        .reverse()
        .slice(0, Number(args[0]))
        .map((row) => {
          const outfit = this.outfits.find((one) => one.id === row.outfit_id);
          return { ...row, event: outfit?.event ?? null, pieces: outfit?.pieces ?? null };
        });
    }

    const wanted = new Set(args.map(String));
    return ordered.filter((row) => wanted.has(String(row.outfit_id)));
  }

  /** Every assignment in the one UPDATE this app runs against `outfit` is a bound value. */
  private updateOutfit(sql: string, args: readonly unknown[]): Row[] {
    const sets = /SET ([\s\S]+?)\s+WHERE id = \?/.exec(sql)?.[1];
    if (sets === undefined) throw new Error(`cannot read the SET list of: ${sql}`);

    const row = this.outfits.find((outfit) => String(outfit.id) === String(args[args.length - 1]));
    if (row === undefined) return [];

    sets.split(',').forEach((assignment, index) => {
      const column = assignment.split('=')[0]?.trim();
      if (column !== undefined) row[column] = args[index] ?? null;
    });
    return [row];
  }

  private live(): Row[] {
    return this.garments.filter((row) => row.archived !== 1);
  }

  private selectGarments(sql: string, args: readonly unknown[]): Row[] {
    if (sql.includes('WHERE id = ?')) return this.live().filter((row) => row.id === args[0]);
    if (sql.includes('reviewed = ?')) {
      return this.live().filter((row) => row.reviewed === args[0]);
    }
    return this.live();
  }

  /** Applies the `SET` list `patchGarment` builds, which mixes bound and literal values. */
  private updateGarment(sql: string, args: readonly unknown[]): Row[] {
    const sets = /UPDATE garment SET (.+) WHERE id = \?/.exec(sql)?.[1];
    if (sets === undefined) throw new Error(`cannot read the SET list of: ${sql}`);

    const id = args[args.length - 1];
    const row = this.live().find((candidate) => candidate.id === id);
    if (row === undefined) return [];

    let bound = 0;
    for (const assignment of sets.split(', ')) {
      const [column, value] = assignment.split(' = ');
      if (column === undefined || value === undefined) continue;
      if (value === '?') row[column] = args[bound++];
      else if (value === `${column} + 1`) row[column] = Number(row[column] ?? 0) + 1;
      else row[column] = Number(value);
    }
    return [row];
  }
}

export class FakeKv {
  public readonly store = new Map<string, string>();

  async put(key: string, value: string, _options?: { readonly expirationTtl?: number }): Promise<void> {
    this.store.set(key, value);
  }

  async get(key: string, options?: { readonly type?: string }): Promise<unknown> {
    const raw = this.store.get(key);
    if (raw === undefined) return null;
    return options?.type === 'json' ? JSON.parse(raw) : raw;
  }
}

/** What `smallImageFor` needs: an R2 body and an Images binding that hands one back. */
export const FAKE_PHOTOS = {
  get: async (key: string) => (key === '' ? null : { body: key }),
};

export const FAKE_IMAGES = {
  input: () => ({
    transform: () => ({
      output: async () => ({ image: () => 'aGVsbG8=' }),
    }),
  }),
};
