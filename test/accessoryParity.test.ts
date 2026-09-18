/**
 * One list, two copies.
 *
 * `ONE_PER_OUTFIT` in `src/domain/certify.ts` is the list `certify` and
 * `swapPiece` both refuse a second of. `ONE_PER_OUTFIT` in
 * `client/lib/outfitcard.js` is a client copy, so the swap picker can stop
 * offering a garment the server will turn down without making a call for it.
 *
 * Nothing but this file stops the two from drifting, and the symptom is quiet
 * either way: a kind added only to the server is offered and then refused after
 * the owner has typed their reason, and a kind added only to the client is
 * hidden from the picker for no reason the owner can see.
 */

import { describe, expect, it } from 'vitest';
// `client/lib` is plain JS outside the tsconfig `include`, so it ships no
// declaration file. The shape is stated once here and the rest is typed.
// @ts-expect-error TS7016: untyped ES module.
import { ONE_PER_OUTFIT as untypedClientKinds } from '../client/lib/outfitcard.js';
import { ONE_PER_OUTFIT as serverKinds } from '../src/domain/certify';
import type { AccessoryKind } from '../src/domain/types';

const clientKinds: readonly string[] = untypedClientKinds;

/** `true` only when the list names every value of the type. Otherwise `never`. */
type Covers<Field, Listed> = [Exclude<Field, Listed>] extends [never] ? true : never;

const EVERY_KIND = [
  'ring', 'chain', 'bracelet', 'earrings', 'watch',
  'glasses', 'hat', 'scarf', 'belt', 'bag', 'other',
] as const;

/**
 * A kind added to `AccessoryKind` breaks the build here rather than slipping
 * past the sweep below in silence.
 */
const EVERY_VALUE_LISTED: Covers<AccessoryKind, (typeof EVERY_KIND)[number]> = true;

describe('the server and client one-per-outfit lists', () => {
  it('hold the same kinds', () => {
    expect([...clientKinds].sort()).toEqual([...serverKinds].sort());
  });

  it('name only real accessory kinds, and not all of them', () => {
    expect(EVERY_VALUE_LISTED).toBe(true);
    expect(EVERY_KIND.filter((kind) => !clientKinds.includes(kind))).not.toHaveLength(0);
    for (const kind of clientKinds) expect(EVERY_KIND).toContain(kind);
  });
});
