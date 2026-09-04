import { Hono } from 'hono';
import { z } from 'zod';
import type { EventKind, WearEvent } from '../../domain/types';
import type { WearRequest } from '../contract';
import type { Env } from '../env';

const MS_PER_DAY = 86_400_000;

/** Long enough to cover the slowest cooldown in `constraints.ts` with room to spare. */
export const WEAR_WINDOW_DAYS = 14;

const EVENTS = ['home', 'errands', 'work', 'social', 'dinner', 'formal', 'active'] as const;

const WearRequestSchema = z.object({
  garmentIds: z.array(z.string().min(1)).min(1),
  event: z.enum(EVENTS).optional(),
});

/** The return type is the compiler's check that the route still speaks the contract. */
function wearRequestFrom(input: z.infer<typeof WearRequestSchema>): WearRequest {
  return input.event === undefined
    ? { garmentIds: input.garmentIds }
    : { garmentIds: input.garmentIds, event: input.event };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const WearRowSchema = z.object({
  worn_on: z.string(),
  garment_ids: z.string(),
  event: z.enum(EVENTS).nullable(),
});

/** A `WearEvent` the cooldown can read, plus the column only the log view wants. */
export interface LoggedWear extends WearEvent {
  readonly event: EventKind | null;
}

export function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A bare `YYYY-MM-DD` parses as UTC midnight, which is what `buildMenu` counts
 * calendar days against. A full timestamp is left alone.
 */
function toDate(wornOn: string): Date {
  return new Date(DAY.test(wornOn) ? `${wornOn}T00:00:00Z` : wornOn);
}

export async function recentWear(db: D1Database, since: string): Promise<readonly LoggedWear[]> {
  const result = await db
    .prepare('SELECT worn_on, garment_ids, event FROM wear_log WHERE worn_on >= ? ORDER BY worn_on DESC')
    .bind(since)
    .all();

  return result.results.map((raw) => {
    const row = WearRowSchema.parse(raw);
    return {
      wornOn: toDate(row.worn_on),
      garmentIds: z.array(z.string()).parse(JSON.parse(row.garment_ids)),
      event: row.event,
    };
  });
}

export async function recordWear(
  db: D1Database,
  request: WearRequest,
  wornOn: Date,
): Promise<{ readonly id: string; readonly wornOn: string }> {
  const id = crypto.randomUUID();
  const on = day(wornOn);
  await db
    .prepare('INSERT INTO wear_log (id, worn_on, garment_ids, event) VALUES (?, ?, ?, ?)')
    .bind(id, on, JSON.stringify(request.garmentIds), request.event ?? null)
    .run();
  return { id, wornOn: on };
}

export const wear = new Hono<{ Bindings: Env }>();

wear.post('/', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = WearRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'send garmentIds and an optional event', issues: parsed.error.issues }, 400);
  }

  const logged = await recordWear(c.env.DB, wearRequestFrom(parsed.data), new Date());
  return c.json(logged, 201);
});

wear.get('/', async (c) => {
  const asked = c.req.query('since');
  if (asked !== undefined && !DAY.test(asked)) {
    return c.json({ error: 'since must be a YYYY-MM-DD date' }, 400);
  }

  const since = asked ?? day(new Date(Date.now() - WEAR_WINDOW_DAYS * MS_PER_DAY));
  const events = await recentWear(c.env.DB, since);
  return c.json(
    events.map((logged) => ({
      wornOn: day(logged.wornOn),
      garmentIds: logged.garmentIds,
      event: logged.event,
    })),
  );
});
