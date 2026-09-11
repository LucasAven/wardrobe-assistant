import { describe, expect, it } from 'vitest';
import { GarmentPatchSchema, parseGarmentRow, toJson } from '../src/worker/repo';

type Row = Record<string, unknown>;

const ROW: Row = {
  id: '4a1f2c66-0000-4000-8000-000000000001',
  slot: 'mid',
  subtype: 'wool sweater',
  image_original: 'orig/4a1f2c66-0000-4000-8000-000000000001',
  image_cutout: 'cut/4a1f2c66-0000-4000-8000-000000000001.png',
  photo_version: 2,
  colors: '["charcoal","navy"]',
  color_role: 'neutral',
  pattern: 'solid',
  fabric: 'wool',
  warmth: 3,
  formality: 3,
  fit: 'regular',
  structured: 0,
  rise: null,
  leg: null,
  hem: 'hip',
  neckline: 'crew',
  sleeves: 'long',
  accessory_kind: null,
  shoulder_bulk: 0,
  water_resistant: 0,
  seasons: '["autumn","winter"]',
  notes: 'small hole on the left cuff',
  reviewed: 1,
  uncertain: '["fit"]',
  archived: 0,
  created_at: '2026-09-01 08:30:00',
};

const row = (overrides: Row = {}): Row => ({ ...ROW, ...overrides });

describe('parseGarmentRow', () => {
  it('parses a complete row into a Garment plus its review state', () => {
    const stored = parseGarmentRow(ROW);

    expect(stored.garment).toEqual({
      id: ROW['id'],
      slot: 'mid',
      subtype: 'wool sweater',
      imageOriginal: ROW['image_original'],
      imageCutout: ROW['image_cutout'],
      colors: ['charcoal', 'navy'],
      colorRole: 'neutral',
      pattern: 'solid',
      fabric: 'wool',
      warmth: 3,
      formality: 3,
      fit: 'regular',
      structured: false,
      rise: null,
      leg: null,
      hem: 'hip',
      neckline: 'crew',
      sleeves: 'long',
      accessoryKind: null,
      shoulderBulk: false,
      waterResistant: false,
      seasons: ['autumn', 'winter'],
      notes: 'small hole on the left cuff',
    });
    expect(stored.photoVersion).toBe(2);
    expect(stored.reviewed).toBe(true);
    expect(stored.uncertain).toEqual(['fit']);
    expect(stored.archived).toBe(false);
    expect(stored.createdAt).toBe('2026-09-01 08:30:00');
  });

  it('keeps every nullable column null', () => {
    const stored = parseGarmentRow(
      row({
        image_cutout: null,
        fabric: null,
        fit: null,
        rise: null,
        leg: null,
        hem: null,
        neckline: null,
        sleeves: null,
        accessory_kind: null,
        notes: null,
      }),
    );

    expect(stored.garment.imageCutout).toBeNull();
    expect(stored.garment.fabric).toBeNull();
    expect(stored.garment.fit).toBeNull();
    expect(stored.garment.rise).toBeNull();
    expect(stored.garment.leg).toBeNull();
    expect(stored.garment.hem).toBeNull();
    expect(stored.garment.neckline).toBeNull();
    expect(stored.garment.sleeves).toBeNull();
    expect(stored.garment.accessoryKind).toBeNull();
    expect(stored.garment.notes).toBeNull();
  });

  it('turns the empty JSON arrays the schema defaults to into empty arrays', () => {
    const stored = parseGarmentRow(row({ colors: '[]', seasons: '[]', uncertain: '[]' }));
    expect(stored.garment.colors).toEqual([]);
    expect(stored.garment.seasons).toEqual([]);
    expect(stored.uncertain).toEqual([]);
  });

  it('reads every integer column as a boolean', () => {
    const off = parseGarmentRow(
      row({ structured: 0, shoulder_bulk: 0, water_resistant: 0, reviewed: 0, archived: 0 }),
    );
    expect(off.garment.structured).toBe(false);
    expect(off.garment.shoulderBulk).toBe(false);
    expect(off.garment.waterResistant).toBe(false);
    expect(off.reviewed).toBe(false);
    expect(off.archived).toBe(false);

    const on = parseGarmentRow(
      row({ structured: 1, shoulder_bulk: 1, water_resistant: 1, reviewed: 1, archived: 1 }),
    );
    expect(on.garment.structured).toBe(true);
    expect(on.garment.shoulderBulk).toBe(true);
    expect(on.garment.waterResistant).toBe(true);
    expect(on.reviewed).toBe(true);
    expect(on.archived).toBe(true);
  });

  it('treats any non-zero integer as true', () => {
    expect(parseGarmentRow(row({ structured: 2 })).garment.structured).toBe(true);
  });

  it('refuses a boolean column that is not an integer', () => {
    expect(() => parseGarmentRow(row({ structured: 'yes' }))).toThrow();
    expect(() => parseGarmentRow(row({ reviewed: null }))).toThrow();
  });

  it('refuses a JSON column that does not hold JSON', () => {
    expect(() => parseGarmentRow(row({ colors: 'charcoal, navy' }))).toThrow();
    expect(() => parseGarmentRow(row({ seasons: '' }))).toThrow();
  });

  it('refuses a JSON column holding the wrong kind of JSON', () => {
    expect(() => parseGarmentRow(row({ colors: '{"main":"navy"}' }))).toThrow();
    expect(() => parseGarmentRow(row({ seasons: '["monsoon"]' }))).toThrow();
    expect(() => parseGarmentRow(row({ colors: '[1,2]' }))).toThrow();
  });

  it('refuses a value the domain has no name for', () => {
    expect(() => parseGarmentRow(row({ slot: 'jacket' }))).toThrow();
    expect(() => parseGarmentRow(row({ warmth: 6 }))).toThrow();
    expect(() => parseGarmentRow(row({ formality: 0 }))).toThrow();
    expect(() => parseGarmentRow(row({ pattern: 'paisley' }))).toThrow();
  });

  it('refuses a row that is missing a column', () => {
    const { warmth: _dropped, ...incomplete } = ROW;
    expect(() => parseGarmentRow(incomplete)).toThrow();

    // What a database that never ran 003_photo_version.sql hands back.
    const { photo_version: _unmigrated, ...unmigrated } = ROW;
    expect(() => parseGarmentRow(unmigrated)).toThrow();

    // And what one that never ran 005_accessory_kind.sql hands back.
    const { accessory_kind: _noKind, ...withoutKind } = ROW;
    expect(() => parseGarmentRow(withoutKind)).toThrow();
  });
});

describe('toJson', () => {
  it('flattens the garment and its review state into one object', () => {
    const json = toJson(parseGarmentRow(ROW));
    expect(json['id']).toBe(ROW['id']);
    expect(json['imageCutout']).toBe(ROW['image_cutout']);
    expect(json['photoVersion']).toBe(2);
    expect(json['seasons']).toEqual(['autumn', 'winter']);
    expect(json['reviewed']).toBe(true);
    expect(json['uncertain']).toEqual(['fit']);
    expect(json['archived']).toBe(false);
    expect(json['createdAt']).toBe('2026-09-01 08:30:00');
    expect(json['image_cutout']).toBeUndefined();
  });
});

describe('GarmentPatchSchema', () => {
  it('accepts one field on its own', () => {
    const parsed = GarmentPatchSchema.parse({ warmth: 4 });
    expect(parsed).toEqual({ warmth: 4 });
  });

  it('accepts several fields together', () => {
    const parsed = GarmentPatchSchema.parse({ formality: 2, seasons: ['summer'], notes: null });
    expect(parsed).toEqual({ formality: 2, seasons: ['summer'], notes: null });
  });

  it('still holds the ranges and the vocabulary', () => {
    expect(GarmentPatchSchema.safeParse({ warmth: 9 }).success).toBe(false);
    expect(GarmentPatchSchema.safeParse({ slot: 'coat' }).success).toBe(false);
    expect(GarmentPatchSchema.safeParse({ leg: 'bootcut' }).success).toBe(false);
  });

  it('parses an empty patch, which the route rejects instead', () => {
    expect(GarmentPatchSchema.parse({})).toEqual({});
  });
});
