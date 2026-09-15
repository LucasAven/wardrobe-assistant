/**
 * The book, transcribed. Nothing here is invented styling judgment: every rule
 * comes from a line in `docs/book/rules.md` and carries that line's own reason.
 *
 * `require` is used only for entries under the book's "Explicit donts" heading.
 * Everything else is `prefer`, because a preference promoted to a hard filter
 * empties a slot.
 *
 * A book rule may be a `require` GarmentRule only when no other garment in the
 * outfit can change its verdict. `bottom` and `outer` are always on show, so a
 * rule about them is safe as a hard filter on the menu. `base`, `top` and `mid`
 * can be covered by another layer, so a rule about how one of them LOOKS is a
 * `require` OutfitRule read against the assembled outfit, and `certify` is the
 * only place it is enforced.
 *
 * The book states some directives twice, once as a proportion rule and again in
 * the "Fit rules" or "Color rules" section. A repeated directive is transcribed
 * once, at the id noted beside it, so the prompt does not carry the same
 * sentence three times:
 *
 *   Fit, tops rectangle .............. rect-02, rect-03
 *   Fit, tops inverted triangle ...... inv-02, inv-03
 *   Fit, tops circular ............... circ-02
 *   Fit, trouser rise triangle ....... tri-02, tri-05
 *   Fit, trouser legs rectangle ...... rect-04
 *   Fit, trouser legs triangle ....... tri-02, tri-04
 *   Fit, trouser legs inv. triangle .. inv-01, inv-05
 *   Fit, trouser legs circular ....... circ-04
 *   Fit, belts ....................... tri-05, inv-06
 *   Color, triangle .................. tri-01, tri-03
 *   Color, circular .................. circ-01, circ-03
 *   Dont, inv. triangle thin legs .... inv-04
 */

import type {
  BodyType,
  BookRule,
  Garment,
  GarmentWant,
  OutfitRule,
  ResolvedOutfit,
  Slot,
} from './types';

export type Lightness = 'light' | 'dark' | 'mixed';

type ColorTone = 'light' | 'dark' | 'mid';

/**
 * `mid` is a color the book's light versus dark split does not decide, so it is
 * listed rather than left out: a reader should see that plain gray was weighed
 * and refused, not forgotten.
 */
const COLOR_TONES: Readonly<Record<string, ColorTone>> = {
  black: 'dark',
  negro: 'dark',
  navy: 'dark',
  'azul marino': 'dark',
  marino: 'dark',
  'dark blue': 'dark',
  'azul oscuro': 'dark',
  charcoal: 'dark',
  'dark grey': 'dark',
  'dark gray': 'dark',
  'gris oscuro': 'dark',
  brown: 'dark',
  marron: 'dark',
  cafe: 'dark',
  olive: 'dark',
  oliva: 'dark',
  'dark green': 'dark',
  'verde oscuro': 'dark',
  burgundy: 'dark',
  bordo: 'dark',
  vino: 'dark',

  white: 'light',
  blanco: 'light',
  cream: 'light',
  crema: 'light',
  ivory: 'light',
  marfil: 'light',
  beige: 'light',
  sand: 'light',
  arena: 'light',
  khaki: 'light',
  caqui: 'light',
  'light grey': 'light',
  'light gray': 'light',
  'gris claro': 'light',
  'light blue': 'light',
  celeste: 'light',

  grey: 'mid',
  gray: 'mid',
  gris: 'mid',
};

function normalizeWord(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ');
}

/** An unknown color reads as `mixed`, so a guess never drives a rule. */
export function lightness(colors: readonly string[]): Lightness {
  if (colors.length === 0) return 'mixed';
  const tones = colors.map((c) => COLOR_TONES[normalizeWord(c)]);
  if (tones.every((t) => t === 'light')) return 'light';
  if (tones.every((t) => t === 'dark')) return 'dark';
  return 'mixed';
}

const TORSO_SLOTS: readonly Slot[] = ['base', 'top', 'mid', 'outer'];
/**
 * How far the book's "tops" reach. A line that names a top, a tee or a tank top
 * stops before the coat, for the reason in `onOutermostTop`. A line about a
 * garment in general, or about volume, color placement, layering or one
 * palette, keeps `outer`, because there the coat is part of what the book is
 * talking about.
 */
const TOP_SLOTS: readonly Slot[] = ['base', 'top', 'mid'];
const BOTTOM_SLOT: readonly Slot[] = ['bottom'];
const CLOTHING_SLOTS: readonly Slot[] = ['base', 'top', 'mid', 'outer', 'bottom'];

/** Never covered by another garment, so a `require` about one stays a filter. */
const OUTER_SLOT: readonly Slot[] = ['outer'];
const ON_SHOW_SLOTS: readonly Slot[] = ['bottom', 'outer'];
const TORSO_BY_VISIBILITY: readonly Slot[] = ['outer', 'mid', 'top', 'base'];

/**
 * The scope of `all-01` and `all-02`, which hold `test: () => true` because
 * which zone gains and which one loses is per body type. Naming anything
 * narrower would promise a verdict that never comes.
 */
export const PRINCIPLE = 'a principle to work from, not a check';

function torsoLayers(o: ResolvedOutfit): readonly Garment[] {
  return TORSO_SLOTS.map((s) => o.pieces[s]).filter((g): g is Garment => g !== undefined);
}

function topLayers(o: ResolvedOutfit): readonly Garment[] {
  return TOP_SLOTS.map((s) => o.pieces[s]).filter((g): g is Garment => g !== undefined);
}

/** Outer, then mid, then top, then base. The layer that actually reads to someone looking at you. */
export function outermostTorso(o: ResolvedOutfit): Garment | null {
  // An open shirt over a base leaves the base partly visible, and only the
  // outer layer is read here.
  for (const slot of TORSO_BY_VISIBILITY) {
    const piece = o.pieces[slot];
    if (piece !== undefined) return piece;
  }
  return null;
}

/**
 * A bare torso satisfies the rule, because an outfit with nothing on the torso
 * is a missing required slot rather than a book violation.
 */
function onOutermostTorso(test: (g: Garment) => boolean): (o: ResolvedOutfit) => boolean {
  return (o) => {
    const visible = outermostTorso(o);
    return visible === null || test(visible);
  };
}

/**
 * The same reading as `onOutermostTorso`, minus the coat. The book's "tops" are
 * the tee, shirt and sweater layers, and it never asks anyone to avoid
 * outerwear, so a coat on top means the rule is not talking about what is being
 * worn.
 */
function onOutermostTop(test: (g: Garment) => boolean): (o: ResolvedOutfit) => boolean {
  return (o) => {
    if (o.pieces.outer !== undefined) return true;
    const visible = outermostTorso(o);
    return visible === null || test(visible);
  };
}

function clothing(o: ResolvedOutfit): readonly Garment[] {
  return CLOTHING_SLOTS.map((s) => o.pieces[s]).filter((g): g is Garment => g !== undefined);
}

const BELT: GarmentWant = {
  slots: ['accessory'],
  name: 'a belt',
  test: (g) => {
    const subtype = normalizeWord(g.subtype);
    return subtype.includes('belt') || subtype.includes('cinturon');
  },
};

/**
 * A rule that is satisfied by wearing one garment of the wanted kind. The test
 * is derived from the want rather than written beside it, so a wardrobe gap is
 * always read off the same predicate the outfit is judged by.
 */
function contains(want: GarmentWant): Pick<OutfitRule, 'wants' | 'test'> {
  return {
    wants: want,
    test: (o) =>
      want.slots.some((slot) =>
        slot === 'accessory'
          ? o.accessories.some((g) => want.test(g))
          : matches(o.pieces[slot], want),
      ),
  };
}

function matches(garment: Garment | undefined, want: GarmentWant): boolean {
  return garment !== undefined && want.test(garment);
}

function hasVolumeBelow(o: ResolvedOutfit): boolean {
  const bottom = o.pieces.bottom;
  if (bottom === undefined) return false;
  return bottom.fit === 'relaxed' || bottom.leg === 'relaxed' || bottom.leg === 'wide';
}

function hasTightTankTop(o: ResolvedOutfit): boolean {
  return topLayers(o).some((g) => g.fit === 'tight' && g.sleeves === 'none');
}

function hasStraightLegBottom(o: ResolvedOutfit): boolean {
  return o.pieces.bottom?.leg === 'straight';
}

export const BOOK_RULES: readonly BookRule[] = [
  {
    kind: 'outfit',
    id: 'all-01',
    appliesTo: 'all',
    severity: 'prefer',
    scope: PRINCIPLE,
    because:
      'Every per-type goal in the book is to balance the silhouette, so add visual volume where the body has little and lower the visual prominence of the zone where the body concentrates volume.',
    // Prompt only. Which zone gains and which one loses depends on the body
    // type, so there is nothing here to decide from the garments alone.
    test: () => true,
  },
  {
    kind: 'outfit',
    id: 'all-02',
    appliesTo: 'all',
    severity: 'prefer',
    scope: PRINCIPLE,
    because:
      "Light attracts the eye and dark lowers a zone's visual prominence, so light tones go on the zone that should gain attention and dark tones on the zone to lower.",
    // Prompt only, for the same reason as all-01: the placement is per type.
    test: () => true,
  },

  {
    kind: 'outfit',
    id: 'rect-01',
    appliesTo: 'rectangle',
    severity: 'prefer',
    scope: 'every torso layer',
    because: 'Layers and V-necks add depth and volume so the torso reads as having shape.',
    test: (o) => {
      const torso = torsoLayers(o);
      return torso.length > 1 || torso.some((g) => g.neckline === 'v' || g.neckline === 'open');
    },
  },
  {
    kind: 'garment',
    id: 'rect-02',
    appliesTo: 'rectangle',
    severity: 'prefer',
    slots: CLOTHING_SLOTS,
    because:
      'With no curve to mark, tight fabric only highlights the flatness and loose fabric amplifies it.',
    test: (g) => g.structured && g.fit !== 'tight' && g.fit !== 'oversized',
  },
  {
    kind: 'garment',
    id: 'rect-03',
    appliesTo: 'rectangle',
    severity: 'prefer',
    slots: TOP_SLOTS,
    because: 'Wider shoulders plus hem volume near the hip read as a marked waist and a dynamic figure.',
    test: (g) => g.shoulderBulk || g.neckline === 'v' || g.hem === 'hip',
  },
  {
    kind: 'garment',
    id: 'rect-04',
    appliesTo: 'rectangle',
    severity: 'prefer',
    slots: BOTTOM_SLOT,
    because: 'Straight fitted legs add no volume at the hip and leave the body without curves or angles.',
    test: (g) => g.leg === 'wide',
  },
  // Every `a`/`b` pair below is one book line split in two: the `a` half filters
  // the slots nothing can cover, the `b` half judges the layer that ends up
  // visible. Both halves carry the book's sentence, because both are shown.
  // circ-05, circ-06, circ-07 and tri-08 were split this way and have been
  // rejoined, so a stored citation of `circ-05a` or `tri-08b` resolves to
  // nothing.
  {
    kind: 'garment',
    id: 'rect-05a',
    appliesTo: 'rectangle',
    severity: 'require',
    slots: ON_SHOW_SLOTS,
    because: 'Very tight garments highlight the flatness.',
    test: (g) => g.fit !== 'tight',
  },
  {
    kind: 'outfit',
    id: 'rect-05b',
    appliesTo: 'rectangle',
    severity: 'require',
    scope: 'the layer on show',
    because: 'Very tight garments highlight the flatness.',
    test: onOutermostTorso((g) => g.fit !== 'tight'),
  },
  {
    kind: 'garment',
    id: 'rect-06a',
    appliesTo: 'rectangle',
    severity: 'require',
    slots: ON_SHOW_SLOTS,
    because: 'Very loose garments amplify the flatness.',
    test: (g) => g.fit !== 'oversized',
  },
  {
    kind: 'outfit',
    id: 'rect-06b',
    appliesTo: 'rectangle',
    severity: 'require',
    scope: 'the layer on show',
    because: 'Very loose garments amplify the flatness.',
    test: onOutermostTorso((g) => g.fit !== 'oversized'),
  },
  {
    kind: 'outfit',
    id: 'rect-07',
    appliesTo: 'rectangle',
    severity: 'prefer',
    scope: 'the tops with the trousers',
    because:
      'A tight tank top with slightly fitted straight jeans leaves the figure uniform, without curves or angles.',
    test: (o) => !(hasTightTankTop(o) && hasStraightLegBottom(o)),
  },

  {
    kind: 'outfit',
    id: 'tri-01',
    appliesTo: 'triangle',
    severity: 'prefer',
    scope: 'the torso layers with the trousers',
    because: 'The eye goes to the light, so the shoulders gain the visual weight the type lacks.',
    test: (o) => {
      const bottom = o.pieces.bottom;
      if (bottom === undefined) return false;
      return (
        torsoLayers(o).some((g) => lightness(g.colors) === 'light') && lightness(bottom.colors) === 'dark'
      );
    },
  },
  {
    kind: 'garment',
    id: 'tri-02',
    appliesTo: 'triangle',
    severity: 'prefer',
    slots: BOTTOM_SLOT,
    because:
      'A wide dark leg lowers the visual prominence of the lower body without adding bulk, and the belt raises the perceived waistline.',
    // The belt half of this line is carried by tri-05, which can see the
    // accessories. Here only the trouser is in scope.
    test: (g) => g.rise === 'high' && g.leg === 'wide' && lightness(g.colors) === 'dark',
  },
  {
    kind: 'outfit',
    id: 'tri-03',
    appliesTo: 'triangle',
    severity: 'prefer',
    scope: 'the layers and accessories at the shoulders',
    because:
      'A dark layer around the neck and shoulders builds volume exactly in the zone where the figure lacks it.',
    test: (o) => {
      const aroundTheShoulders = [o.pieces.top, o.pieces.mid, o.pieces.outer, ...o.accessories];
      return aroundTheShoulders.some((g) => g !== undefined && lightness(g.colors) === 'dark');
    },
  },
  {
    kind: 'garment',
    id: 'tri-04',
    appliesTo: 'triangle',
    severity: 'prefer',
    slots: BOTTOM_SLOT,
    because: 'Wide ankles match the hip volume and rebalance the figure.',
    test: (g) => g.leg === 'wide',
  },
  {
    kind: 'outfit',
    id: 'tri-05',
    appliesTo: 'triangle',
    severity: 'prefer',
    scope: 'the accessories',
    because: 'The belt helps a lot for this type because it raises the visual waistline.',
    ...contains(BELT),
  },
  {
    kind: 'garment',
    id: 'tri-06',
    appliesTo: 'triangle',
    severity: 'require',
    slots: BOTTOM_SLOT,
    because:
      'The lower body is the zone to lower in visual prominence, so nothing tight or clingy belongs there.',
    test: (g) => g.fit !== 'tight',
  },
  {
    kind: 'outfit',
    id: 'tri-07',
    appliesTo: 'triangle',
    severity: 'prefer',
    scope: 'the tops with the trousers',
    because: 'A tight top tucked into tight trousers highlights hip width.',
    // Tucking is a way of wearing a garment and no field records it, so the
    // pairing of the two tight pieces is what gets tested.
    test: (o) => !(topLayers(o).some((g) => g.fit === 'tight') && o.pieces.bottom?.fit === 'tight'),
  },
  {
    kind: 'outfit',
    id: 'tri-08',
    appliesTo: 'triangle',
    severity: 'require',
    scope: 'every torso layer',
    because: 'Sleeveless tops leave the shoulders bare and unbalance the figure further.',
    // `sleeves: 'none'` cannot tell a tank top apart from a gilet, so only a
    // sleeved layer counts as cover: a gilet over a long sleeve tee passes on
    // the tee, and a gilet over a tank is refused even though the gilet covers
    // the shoulders.
    test: (o) => {
      const torso = torsoLayers(o);
      return torso.length === 0 || torso.some((g) => g.sleeves !== 'none');
    },
  },
  {
    kind: 'garment',
    id: 'tri-09',
    appliesTo: 'triangle',
    severity: 'require',
    slots: BOTTOM_SLOT,
    because: 'Tight ankles work against the wide ankle that matches the hip volume.',
    // Only `skinny` is read as a tight ankle. This is a hard filter, and a
    // tapered leg is narrower at the ankle without being tight.
    test: (g) => g.leg !== 'skinny',
  },

  {
    kind: 'garment',
    id: 'inv-01',
    appliesTo: 'inverted_triangle',
    severity: 'prefer',
    slots: BOTTOM_SLOT,
    because:
      'Volume below balances the silhouette and tight legs accentuate the top-heavy contrast even more.',
    test: (g) => g.fit === 'relaxed' || g.leg === 'relaxed' || g.leg === 'wide',
  },
  {
    kind: 'garment',
    id: 'inv-02',
    appliesTo: 'inverted_triangle',
    severity: 'prefer',
    slots: TOP_SLOTS,
    because:
      'The top already has plenty of volume, and padded jackets, bulky sweaters and shoulder pads amplify what is already there.',
    // The avoid half of this line does name a jacket, and inv-08a and inv-08b
    // carry that half over the outer slot as a dont. What stops at `mid` is the
    // prefer half, which asks a shirt or a tee to be structured and plain.
    test: (g) => g.structured && g.pattern === 'solid' && !g.shoulderBulk,
  },
  {
    kind: 'outfit',
    id: 'inv-03',
    appliesTo: 'inverted_triangle',
    severity: 'prefer',
    scope: 'the tops with the trousers',
    because:
      'The fitted top flatters this type only when the lower half compensates, and the open neckline adds verticality.',
    test: (o) => {
      const fitted = topLayers(o).filter((g) => g.fit === 'fitted');
      if (fitted.length === 0) return true;
      return hasVolumeBelow(o) && fitted.every((g) => g.neckline === 'open');
    },
  },
  {
    kind: 'outfit',
    id: 'inv-04',
    appliesTo: 'inverted_triangle',
    severity: 'prefer',
    scope: 'the tops with the trousers',
    because:
      'A fitted tee with tight trousers emphasizes the size difference between upper and lower body the most, and thin legs make the trouser volume stricter still.',
    // `thinLegs` lives on the body profile, which a rule test never sees. The
    // predicate holds for every inverted triangle, which is where inv-03
    // already puts it, so nothing here is stricter than the book.
    test: (o) => !(topLayers(o).some((g) => g.fit === 'fitted') && o.pieces.bottom?.fit === 'tight'),
  },
  {
    kind: 'garment',
    id: 'inv-05',
    appliesTo: 'inverted_triangle',
    severity: 'prefer',
    slots: BOTTOM_SLOT,
    because: 'Wide ankles balance the shoulders and the belt marks the waist, giving a more dynamic figure.',
    test: (g) => g.leg === 'wide',
  },
  {
    kind: 'outfit',
    id: 'inv-06',
    appliesTo: 'inverted_triangle',
    severity: 'prefer',
    scope: 'the accessories',
    because: 'The belt marks the waist over relaxed trousers, giving a more dynamic figure.',
    ...contains(BELT),
  },
  {
    kind: 'garment',
    id: 'inv-07',
    appliesTo: 'inverted_triangle',
    severity: 'require',
    slots: BOTTOM_SLOT,
    because: 'Very tight trousers accentuate the contrast.',
    test: (g) => g.fit !== 'tight',
  },
  {
    kind: 'garment',
    id: 'inv-08a',
    appliesTo: 'inverted_triangle',
    severity: 'require',
    slots: OUTER_SLOT,
    because: 'Padded jackets, bulky sweaters and shoulder pads add volume where the top already has plenty.',
    // Bulk has no field of its own, so only the padding part of this dont can
    // be checked. The sweater half stays in the prompt through the reason.
    test: (g) => !g.shoulderBulk,
  },
  {
    kind: 'outfit',
    id: 'inv-08b',
    appliesTo: 'inverted_triangle',
    severity: 'require',
    scope: 'the layer on show',
    because: 'Padded jackets, bulky sweaters and shoulder pads add volume where the top already has plenty.',
    test: onOutermostTorso((g) => !g.shoulderBulk),
  },

  {
    kind: 'garment',
    id: 'circ-01',
    appliesTo: 'circular',
    severity: 'prefer',
    slots: TORSO_SLOTS,
    because: 'The eye follows the vertical line and does not stop at the center.',
    // `pattern` records that a garment is striped but not which way the stripes
    // run, so a stripe counts as the vertical line the book asks for.
    test: (g) => lightness(g.colors) === 'dark' && (g.pattern === 'stripe' || g.neckline === 'open'),
  },
  {
    kind: 'garment',
    id: 'circ-02',
    appliesTo: 'circular',
    severity: 'prefer',
    slots: TOP_SLOTS,
    because:
      'Tops that cling to the torso or fall past the waistline wrap the midsection and make the body look wider than it is.',
    test: (g) =>
      (g.fit === 'regular' || g.fit === 'relaxed') &&
      (g.hem === null || g.hem === 'above_waist' || g.hem === 'at_waist'),
  },
  {
    kind: 'outfit',
    id: 'circ-03',
    appliesTo: 'circular',
    severity: 'prefer',
    scope: 'the tops, coats and trousers together',
    because: 'One color unifies and balances all the body zones.',
    // Shoes and accessories are left out because the book's reason is about the
    // body zones, which are the clothing slots.
    test: (o) => {
      const worn = clothing(o);
      const palettes = worn.map((g) => new Set(g.colors.map(normalizeWord)));
      const first = palettes[0];
      if (first === undefined) return true;
      return [...first].some((color) => palettes.every((p) => p.has(color)));
    },
  },
  {
    kind: 'garment',
    id: 'circ-04',
    appliesTo: 'circular',
    severity: 'prefer',
    slots: BOTTOM_SLOT,
    because:
      'Widening legs distribute visual weight along the body, while straight legs add no volume to compensate the midsection.',
    test: (g) => g.leg === 'wide',
  },
  {
    kind: 'outfit',
    id: 'circ-05',
    appliesTo: 'circular',
    severity: 'require',
    scope: 'the top on show when no coat is worn',
    because: 'Tops that cling to the torso wrap the midsection and make the body look wider than it is.',
    test: onOutermostTop((g) => g.fit !== 'tight'),
  },
  {
    kind: 'outfit',
    id: 'circ-06',
    appliesTo: 'circular',
    severity: 'require',
    scope: 'the top on show when no coat is worn',
    because: 'Tops that fall past the waistline wrap the midsection and make the body look wider than it is.',
    test: onOutermostTop((g) => g.hem !== 'past_waist' && g.hem !== 'hip' && g.hem !== 'below_hip'),
  },
  {
    kind: 'outfit',
    id: 'circ-07',
    appliesTo: 'circular',
    severity: 'require',
    scope: 'the top on show when no coat is worn',
    because: 'Tight tank tops shrink the shoulders and emphasize the abdomen.',
    test: onOutermostTop((g) => !(g.fit === 'tight' && g.sleeves === 'none')),
  },
  {
    kind: 'garment',
    id: 'circ-08',
    appliesTo: 'circular',
    severity: 'require',
    slots: BOTTOM_SLOT,
    because: 'Straight-leg trousers add no leg volume to compensate the midsection.',
    test: (g) => g.leg !== 'straight',
  },
  {
    kind: 'outfit',
    id: 'circ-09',
    appliesTo: 'circular',
    severity: 'prefer',
    scope: 'the tops with the trousers',
    because:
      'A tight tank top with straight jeans emphasizes the abdominal zone and shortens the legs, which the book calls the worst combination for this type.',
    test: (o) => !(hasTightTankTop(o) && hasStraightLegBottom(o)),
  },
];

export function rulesFor(bodyType: BodyType): BookRule[] {
  return BOOK_RULES.filter((r) => r.appliesTo === bodyType || r.appliesTo === 'all');
}

export const RULES_BY_ID: ReadonlyMap<string, BookRule> = new Map(
  BOOK_RULES.map((r): [string, BookRule] => [r.id, r]),
);
