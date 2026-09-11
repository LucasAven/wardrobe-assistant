import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Env } from './env';
import type {
  AccessoryKind,
  Fabric,
  Fit,
  Formality,
  Garment,
  Hem,
  Leg,
  Neckline,
  Pattern,
  Rise,
  Season,
  Sleeves,
  Slot,
  Warmth,
} from '../domain/types';

/**
 * Everything the model is asked to decide. `Garment` minus the three fields the
 * pipeline owns, so adding a field to `Garment` breaks this file until the
 * prompt and the schema below learn about it.
 */
export type GarmentTags = Omit<Garment, 'id' | 'imageOriginal' | 'imageCutout'>;

type ColorRole = Garment['colorRole'];

/**
 * One field's vocabulary. `satisfies` on each table below is what stops a word
 * the domain does not have from being written here.
 */
interface Vocabulary<T extends string> {
  readonly values: readonly T[];
  /** Keyed by the normalized form, so "V-Neck" and "v neck" both find `v_neck`. */
  readonly synonyms: Readonly<Record<string, T>>;
}

const SLOT = {
  values: ['base', 'top', 'mid', 'outer', 'bottom', 'shoes', 'accessory'],
  synonyms: { shoe: 'shoes', footwear: 'shoes', outerwear: 'outer', accessories: 'accessory' },
} as const satisfies Vocabulary<Slot>;

const COLOR_ROLE = {
  values: ['neutral', 'accent'],
  synonyms: {},
} as const satisfies Vocabulary<ColorRole>;

const PATTERN = {
  values: ['solid', 'stripe', 'check', 'print'],
  synonyms: {
    plain: 'solid',
    striped: 'stripe',
    stripes: 'stripe',
    pinstripe: 'stripe',
    checked: 'check',
    checks: 'check',
    plaid: 'check',
    patterned: 'print',
    printed: 'print',
    graphic: 'print',
    floral: 'print',
  },
} as const satisfies Vocabulary<Pattern>;

const FABRIC = {
  values: ['cotton', 'wool', 'linen', 'denim', 'leather', 'synthetic'],
  synonyms: {
    polyester: 'synthetic',
    nylon: 'synthetic',
    acrylic: 'synthetic',
    suede: 'leather',
    merino: 'wool',
    cashmere: 'wool',
  },
} as const satisfies Vocabulary<Fabric>;

const SEASON = {
  values: ['spring', 'summer', 'autumn', 'winter'],
  synonyms: { fall: 'autumn' },
} as const satisfies Vocabulary<Season>;

const FIT = {
  values: ['tight', 'fitted', 'regular', 'relaxed', 'oversized'],
  synonyms: {
    skinny: 'tight',
    slim: 'fitted',
    slim_fit: 'fitted',
    standard: 'regular',
    classic: 'regular',
    loose: 'relaxed',
    baggy: 'relaxed',
    oversize: 'oversized',
  },
} as const satisfies Vocabulary<Fit>;

const RISE = {
  values: ['low', 'mid', 'high'],
  synonyms: {
    low_rise: 'low',
    mid_rise: 'mid',
    midi: 'mid',
    high_rise: 'high',
    high_waist: 'high',
    high_waisted: 'high',
  },
} as const satisfies Vocabulary<Rise>;

const LEG = {
  values: ['skinny', 'tapered', 'straight', 'relaxed', 'wide'],
  synonyms: {
    straight_leg: 'straight',
    loose: 'relaxed',
    baggy: 'relaxed',
    bootcut: 'wide',
    boot_cut: 'wide',
    flare: 'wide',
    flared: 'wide',
    wide_leg: 'wide',
  },
} as const satisfies Vocabulary<Leg>;

const HEM = {
  values: ['above_waist', 'at_waist', 'past_waist', 'hip', 'below_hip'],
  synonyms: {
    crop: 'above_waist',
    cropped: 'above_waist',
    waist: 'at_waist',
    waist_length: 'at_waist',
    at_hip: 'hip',
    hip_length: 'hip',
    longline: 'below_hip',
  },
} as const satisfies Vocabulary<Hem>;

/**
 * A collar maps to `open`, not to `crew`: the prompt defines `open` as a collar
 * or buttons worn open, and `crew` as a round neck with no collar, so sending
 * every collared shirt to `crew` would quietly feed the book's neckline rules
 * the opposite of what the photo shows.
 */
const NECKLINE = {
  values: ['crew', 'v', 'open', 'high', 'none'],
  synonyms: {
    crewneck: 'crew',
    crew_neck: 'crew',
    round: 'crew',
    round_neck: 'crew',
    vneck: 'v',
    v_neck: 'v',
    deep_v: 'v',
    collar: 'open',
    collared: 'open',
    open_collar: 'open',
    button_down: 'open',
    button_up: 'open',
    polo: 'open',
    turtleneck: 'high',
    turtle_neck: 'high',
    mockneck: 'high',
    mock_neck: 'high',
    funnel_neck: 'high',
    high_neck: 'high',
  },
} as const satisfies Vocabulary<Neckline>;

const SLEEVES = {
  values: ['none', 'short', 'long'],
  synonyms: {
    sleeveless: 'none',
    no_sleeves: 'none',
    short_sleeve: 'short',
    short_sleeves: 'short',
    short_sleeved: 'short',
    long_sleeve: 'long',
    long_sleeves: 'long',
    long_sleeved: 'long',
  },
} as const satisfies Vocabulary<Sleeves>;

const ACCESSORY_KIND = {
  values: [
    'ring',
    'chain',
    'bracelet',
    'earrings',
    'watch',
    'glasses',
    'hat',
    'scarf',
    'belt',
    'bag',
    'other',
  ],
  synonyms: {
    necklace: 'chain',
    sunglasses: 'glasses',
    spectacles: 'glasses',
    cap: 'hat',
    beanie: 'hat',
    purse: 'bag',
    handbag: 'bag',
    earring: 'earrings',
  },
} as const satisfies Vocabulary<AccessoryKind>;

const WARMTH_SCALE = [0, 1, 2, 3, 4, 5] as const satisfies readonly Warmth[];
const FORMALITY_SCALE = [1, 2, 3, 4, 5] as const satisfies readonly Formality[];

/** Every vocabulary the coercion below can consult, for the tests to walk. */
export const VOCABULARIES = {
  slot: SLOT,
  colorRole: COLOR_ROLE,
  pattern: PATTERN,
  fabric: FABRIC,
  seasons: SEASON,
  fit: FIT,
  rise: RISE,
  leg: LEG,
  hem: HEM,
  neckline: NECKLINE,
  sleeves: SLEEVES,
  accessoryKind: ACCESSORY_KIND,
} as const;

/**
 * The domain shape of a draft. Warmth and formality are literal unions rather
 * than `int().min().max()`, because these are the two fields whose inferred type
 * has to come out as the domain's `Warmth` and `Formality`. A plain number would
 * typecheck and then put a 7 in the row.
 */
export const GarmentDraftSchema = z.object({
  slot: z.enum(SLOT.values),
  subtype: z.string(),
  colors: z.array(z.string()),
  colorRole: z.enum(COLOR_ROLE.values),
  pattern: z.enum(PATTERN.values),
  fabric: z.enum(FABRIC.values).nullable(),
  warmth: z.literal(WARMTH_SCALE),
  formality: z.literal(FORMALITY_SCALE),
  fit: z.enum(FIT.values).nullable(),
  structured: z.boolean(),
  rise: z.enum(RISE.values).nullable(),
  leg: z.enum(LEG.values).nullable(),
  hem: z.enum(HEM.values).nullable(),
  neckline: z.enum(NECKLINE.values).nullable(),
  sleeves: z.enum(SLEEVES.values).nullable(),
  accessoryKind: z.enum(ACCESSORY_KIND.values).nullable(),
  shoulderBulk: z.boolean(),
  waterResistant: z.boolean(),
  seasons: z.array(z.enum(SEASON.values)),
  notes: z.string().nullable(),
  uncertain: z.array(z.string()),
});

export type GarmentDraft = z.infer<typeof GarmentDraftSchema>;

/** Every field the model decides, so "uncertain about all of them" cannot drift. */
export const TAGGED_FIELDS: readonly string[] = Object.keys(GarmentDraftSchema.shape).filter(
  (key) => key !== 'uncertain',
);

const oneOf = (values: readonly string[]): string => `Exactly one of: ${values.join(', ')}.`;

/**
 * The wire shape, deliberately not the domain shape. The SDK's JSON schema
 * transform keeps `type`, `description` and object or array structure, and
 * stringifies every other keyword into the description, so `enum`, `minimum` and
 * `maximum` reach the model as a hint and never as a constraint. Declaring an
 * enum here would only move the rejection to our side of the wire, where one
 * word outside the vocabulary throws away eighteen good fields with it. So the
 * wire asks for a string, the vocabulary rides in `describe` where it was always
 * headed anyway, and `coerceDraft` does the matching.
 */
export const RawGarmentDraftSchema = z.object({
  slot: z.string().describe(oneOf(SLOT.values)),
  subtype: z.string().describe('Two or three lowercase words a person would say out loud.'),
  colors: z.array(z.string()).describe('One to three plain color words, largest area first.'),
  colorRole: z.string().describe(oneOf(COLOR_ROLE.values)),
  pattern: z.string().describe(oneOf(PATTERN.values)),
  fabric: z.string().nullable().describe(`${oneOf(FABRIC.values)} null when the photo does not say.`),
  warmth: z.number().describe('A whole number from 0 to 5.'),
  formality: z.number().describe('A whole number from 1 to 5.'),
  fit: z.string().nullable().describe(`${oneOf(FIT.values)} null when the photo does not say.`),
  structured: z.boolean(),
  rise: z.string().nullable().describe(`${oneOf(RISE.values)} null unless the slot is bottom.`),
  leg: z.string().nullable().describe(`${oneOf(LEG.values)} null unless the slot is bottom.`),
  hem: z
    .string()
    .nullable()
    .describe(`${oneOf(HEM.values)} null unless the slot is base, top, mid or outer.`),
  neckline: z
    .string()
    .nullable()
    .describe(`${oneOf(NECKLINE.values)} null unless the slot is base, top, mid or outer.`),
  sleeves: z
    .string()
    .nullable()
    .describe(`${oneOf(SLEEVES.values)} null unless the slot is base, top, mid or outer.`),
  accessoryKind: z
    .string()
    .nullable()
    .describe(`${oneOf(ACCESSORY_KIND.values)} null unless the slot is accessory, and never null on one.`),
  shoulderBulk: z.boolean(),
  waterResistant: z.boolean(),
  seasons: z.array(z.string()).describe(`Every season the piece suits. ${oneOf(SEASON.values)}`),
  notes: z.string().nullable(),
  uncertain: z
    .array(z.string())
    .describe('The field names you were not confident about, spelled as this schema spells them.'),
} satisfies Record<keyof GarmentDraft, z.ZodType>);

export type RawGarmentDraft = z.infer<typeof RawGarmentDraftSchema>;

function normalize(word: string): string {
  return word.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Every domain word is already in normalized form, so one normalized lookup
 * covers both an exact hit and a spacing or casing slip.
 */
function matchWord<T extends string>(word: string, vocab: Vocabulary<T>): T | null {
  const key = normalize(word);
  return vocab.values.find((value) => value === key) ?? vocab.synonyms[key] ?? null;
}

function nearest<T extends number>(scale: readonly T[], value: number, fallback: T): T {
  let best = fallback;
  let smallest = Number.POSITIVE_INFINITY;
  for (const step of scale) {
    const gap = Math.abs(step - value);
    if (gap < smallest) {
      best = step;
      smallest = gap;
    }
  }
  return best;
}

/**
 * Turns what the model actually wrote into domain data. A word the vocabulary
 * does not have costs its own field and nothing else: the field falls back and
 * joins `uncertain`, which is the list the user reviews by hand. A field the
 * model was sure about but spelled in its own vocabulary is still a field the
 * user has to check, so the two lists are merged rather than one replacing the
 * other.
 */
export function coerceDraft(raw: RawGarmentDraft): GarmentDraft {
  const uncertain = new Set<string>(raw.uncertain);

  const word = <T extends string>(field: string, value: string, vocab: Vocabulary<T>, fallback: T): T => {
    const matched = matchWord(value, vocab);
    if (matched !== null) return matched;
    uncertain.add(field);
    return fallback;
  };

  const wordOrNull = <T extends string>(
    field: string,
    value: string | null,
    vocab: Vocabulary<T>,
  ): T | null => {
    if (value === null) return null;
    const matched = matchWord(value, vocab);
    if (matched !== null) return matched;
    uncertain.add(field);
    return null;
  };

  const step = <T extends number>(field: string, value: number, scale: readonly T[], fallback: T): T => {
    if (!Number.isFinite(value)) {
      uncertain.add(field);
      return fallback;
    }
    const snapped = nearest(scale, value, fallback);
    if (snapped !== value) uncertain.add(field);
    return snapped;
  };

  const seasons = (values: readonly string[]): Season[] => {
    const kept: Season[] = [];
    for (const value of values) {
      const matched = matchWord(value, SEASON);
      if (matched === null) uncertain.add('seasons');
      else if (!kept.includes(matched)) kept.push(matched);
    }
    return kept;
  };

  return {
    slot: word('slot', raw.slot, SLOT, 'accessory'),
    subtype: raw.subtype,
    colors: raw.colors,
    colorRole: word('colorRole', raw.colorRole, COLOR_ROLE, 'neutral'),
    pattern: word('pattern', raw.pattern, PATTERN, 'solid'),
    fabric: wordOrNull('fabric', raw.fabric, FABRIC),
    warmth: step('warmth', raw.warmth, WARMTH_SCALE, 2),
    formality: step('formality', raw.formality, FORMALITY_SCALE, 3),
    fit: wordOrNull('fit', raw.fit, FIT),
    structured: raw.structured,
    rise: wordOrNull('rise', raw.rise, RISE),
    leg: wordOrNull('leg', raw.leg, LEG),
    hem: wordOrNull('hem', raw.hem, HEM),
    neckline: wordOrNull('neckline', raw.neckline, NECKLINE),
    sleeves: wordOrNull('sleeves', raw.sleeves, SLEEVES),
    accessoryKind: wordOrNull('accessoryKind', raw.accessoryKind, ACCESSORY_KIND),
    shoulderBulk: raw.shoulderBulk,
    waterResistant: raw.waterResistant,
    seasons: seasons(raw.seasons),
    notes: raw.notes,
    uncertain: [...uncertain],
  };
}

/**
 * The one place the draft becomes domain data. The return type is the compiler's
 * check that the schema still covers every `Garment` field.
 */
export function draftToTags(draft: GarmentDraft): GarmentTags {
  return draft;
}

/**
 * What goes in the row when the vision call failed. Slot is `accessory` because
 * every other slot can be required by an outfit, so a wrong guess there puts an
 * unknown item on the body, while a wrong accessory is only ever optional.
 * Empty `seasons` keeps the piece out of every menu until a human reviews it.
 */
export function blankDraft(): GarmentDraft {
  return {
    slot: 'accessory',
    subtype: 'untagged item',
    colors: [],
    colorRole: 'neutral',
    pattern: 'solid',
    fabric: null,
    warmth: 2,
    formality: 3,
    fit: null,
    structured: false,
    rise: null,
    leg: null,
    hem: null,
    neckline: null,
    sleeves: null,
    accessoryKind: null,
    shoulderBulk: false,
    waterResistant: false,
    seasons: [],
    notes: null,
    uncertain: [...TAGGED_FIELDS],
  };
}

export const VISION_SYSTEM_PROMPT = `You tag one clothing item for a single person's wardrobe app. The photo shows the garment alone, laid flat or on a hanger, usually with the background removed. Nobody is wearing it. Judge the garment, never an outfit.

Answer with the JSON object the schema asks for and nothing else.

SLOT, where the piece sits in an outfit.
  base       worn against the skin on the torso: t-shirt, tank top, dress shirt, polo
  top        a shirt worn over a base: overshirt, shacket, an open button-down used as a layer
  mid        sweater, hoodie, cardigan, vest, blazer
  outer      coat, parka, rain shell, heavy jacket
  bottom     trousers, jeans, chinos, shorts, joggers
  shoes      any footwear
  accessory  belt, hat, scarf, bag, watch, sunglasses
  A shirt that could be base or top is base, because it is normally worn next to the skin.

SUBTYPE: two or three lowercase words, the words a person would say out loud.
  "oxford shirt", "slim jeans", "white sneakers". No brand, no color word unless the color is the name of the thing.

WARMTH, 0 to 5. How much this one piece adds to how warm the wearer is. The app sums warmth across the layers of an outfit, so score the piece by itself.
  0  tank top, sandals, thin shorts
  1  t-shirt, linen shirt, chino shorts, low sneakers
  2  long sleeve shirt, jeans, chinos, light knit polo
  3  sweater, hoodie, denim jacket, light jacket, blazer
  4  wool coat, thick puffer, heavy knit
  5  heavy parka, expedition coat

FORMALITY, 1 to 5. The least formal room this piece belongs in. The app takes an outfit's formality as the minimum across its pieces, so a piece that drags the outfit down has to score low.
  1  gym and loungewear: sweatpants, running shoes, tech tees
  2  casual: tee, jeans, sneakers, hoodie
  3  smart casual: chinos and a polo, clean dark denim, unstructured blazer, leather sneakers, loafers
  4  dressy: blazer, dress shirt, wool trousers, leather dress shoes
  5  formal: suit, tuxedo, oxfords, black tie and up

Warmth and formality are the two numbers the app cannot recover from. Every future recommendation reads them, and a wrong one corrupts all of those quietly, without anyone noticing which garment did it. So when the photo does not settle the value, pick the middle of the range you are choosing between AND add the field name to "uncertain". The user reviews every flagged field by hand, so doubt costs nothing and a confident guess costs a lot. Guessing well is not the goal here.

The remaining fields feed a men's styling book whose rules read the silhouette of each piece. Read them off the garment lying on its own.

  fit             how close the cut sits to the body it was made for: tight, fitted, regular, relaxed, oversized. Read the width of the panels and the shape of the cut, not how the photo is styled.
  structured      true when the garment holds its own shape instead of draping: blazer, denim jacket, stiff oxford, structured coat. false for jersey, knitwear, and anything that collapses when you set it down.
  shoulderBulk    true only when the shoulders are padded or built up: suit and blazer shoulders, padded jackets, heavy raglan bulk. false for a plain tee, a shirt, a thin knit.
  waterResistant  true only when the surface is plainly made to shed water: rain shell, waxed or coated jacket, rubber boots. Not wool, not a denim jacket.
  seasons         every season the piece is comfortable in. Most pieces suit two or three. Do not return one season out of caution.
  colors          one to three plain color words, the largest area of the garment first: "navy", "off white", "olive". No brand names, no fashion names.
  colorRole       neutral for black, white, gray, navy, beige, brown, olive and denim blue. accent for anything that would be the loudest piece in an outfit.
  pattern         solid, stripe, check, print.
  fabric          cotton, wool, linen, denim, leather, synthetic, or null when the photo does not tell you. Do not infer a fiber from color alone.
  notes           one short line, only when something matters and no other field carries it: visible damage, a large logo, a cropped length. null otherwise.

BOTTOMS ONLY. Return null for both on anything whose slot is not "bottom".
  rise  where the waistband sits: low, mid, high.
  leg   skinny, tapered, straight, relaxed, wide. Judge the line from the knee to the hem, which is the part the book's rules read.

TOPS ONLY. Return null for all three on anything whose slot is not base, top, mid or outer.
  neckline  crew, v, open (a collar or buttons worn open), high (mock neck or turtleneck), none (no neck opening worth naming).
  sleeves   none, short, long.
  hem       where the bottom edge falls on the torso: above_waist, at_waist, past_waist, hip, below_hip.

Shoes and accessories get null for every field in both groups above.

Every field above takes one of the listed words and nothing else. A word of your own costs that field, so use theirs.

"uncertain": the exact field names you were not confident about, camelCase, spelled as the schema spells them. An empty array is a claim that you were sure of all of them, so only send an empty array when that is true.`;

const VISION_MODEL = 'claude-opus-5';

export interface SmallImage {
  readonly base64: string;
  readonly mediaType: 'image/jpeg';
}

/**
 * Throws when the call fails or the model returns nothing that parses at all.
 * A word outside the vocabulary is not that: it costs its own field and comes
 * back flagged. Callers decide what a real failure means, because it means
 * different things at upload time and at retag time.
 */
export async function tagGarment(env: Env, image: SmallImage): Promise<GarmentDraft> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const response = await client.messages.parse({
    model: VISION_MODEL,
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(RawGarmentDraftSchema), effort: 'medium' },
    system: [
      {
        type: 'text',
        text: VISION_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
          },
          { type: 'text', text: 'Tag this garment.' },
        ],
      },
    ],
  });

  if (response.parsed_output === null) {
    throw new Error(`vision returned no parsable output (stop_reason ${response.stop_reason})`);
  }
  return coerceDraft(response.parsed_output);
}
