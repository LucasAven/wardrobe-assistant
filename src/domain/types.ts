/**
 * The contract. Every other module in the engine is written against this file.
 *
 * One idea carries it: a hard constraint either distributes over single
 * garments or it does not, and that decides where it is enforced.
 *
 *   formality   min(clothes) >= F  <=>  every one >= F    distributes, filter
 *   season      the piece must suit the season            distributes, filter
 *   book donts  about a garment nothing can cover         distributes, filter
 *   book donts  about how the dressed torso reads         does not, validate
 *   warmth      a sum across worn layers                  does not, validate
 *
 * Distributive constraints are removed from the Menu, so an outfit built from
 * Menu entries cannot violate them. That is why `resolveOutfit` looks ids up in
 * the Menu and never in the wardrobe.
 */

// ---------------------------------------------------------------------------
// Garment
// ---------------------------------------------------------------------------

/** Only mintable by resolving a string against a Menu. */
export type GarmentId = string & { readonly __brand: 'GarmentId' };

export type Slot = 'base' | 'top' | 'mid' | 'outer' | 'bottom' | 'shoes' | 'accessory';
export type RequiredSlot = Extract<Slot, 'base' | 'bottom' | 'shoes'>;
export type LayerSlot = Extract<Slot, 'base' | 'top' | 'mid' | 'outer'>;

/** 0 to 5. Sums across worn layers. */
export type Warmth = 0 | 1 | 2 | 3 | 4 | 5;
/** 1 gym to 5 black tie. Never sums. An outfit is its minimum. */
export type Formality = 1 | 2 | 3 | 4 | 5;

export type Pattern = 'solid' | 'stripe' | 'check' | 'print';
export type Fabric = 'cotton' | 'wool' | 'linen' | 'denim' | 'leather' | 'synthetic';
export type Season = 'spring' | 'summer' | 'autumn' | 'winter';

/**
 * What an accessory is, in a word the engine can act on. `subtype` is free text,
 * so it can say "beanie" and nothing downstream can tell that from a second hat.
 * Null on everything that is not an accessory.
 */
export type AccessoryKind =
  | 'ring' | 'chain' | 'bracelet' | 'earrings' | 'watch'
  | 'glasses' | 'hat' | 'scarf' | 'belt' | 'bag' | 'other';

/** The book's vocabulary. Every value here appears in a rule in docs/book/rules.md. */
export type Fit = 'tight' | 'fitted' | 'regular' | 'relaxed' | 'oversized';
export type Rise = 'low' | 'mid' | 'high';
export type Leg = 'skinny' | 'tapered' | 'straight' | 'relaxed' | 'wide';
export type Hem = 'above_waist' | 'at_waist' | 'past_waist' | 'hip' | 'below_hip';
export type Neckline = 'crew' | 'v' | 'open' | 'high' | 'none';
export type Sleeves = 'none' | 'short' | 'long';

export interface Garment {
  readonly id: GarmentId;
  readonly slot: Slot;
  readonly subtype: string;
  readonly imageOriginal: string;
  readonly imageCutout: string | null;
  readonly colors: readonly string[];
  readonly colorRole: 'neutral' | 'accent';
  readonly pattern: Pattern;
  readonly fabric: Fabric | null;
  readonly warmth: Warmth;
  readonly formality: Formality;
  readonly fit: Fit | null;
  /** The garment holds its own shape rather than draping. Book term. */
  readonly structured: boolean;
  readonly rise: Rise | null;
  readonly leg: Leg | null;
  readonly hem: Hem | null;
  readonly neckline: Neckline | null;
  readonly sleeves: Sleeves | null;
  readonly accessoryKind: AccessoryKind | null;
  /** Padding or shoulder pads. The inverted triangle rules ban these. */
  readonly shoulderBulk: boolean;
  readonly seasons: readonly Season[];
  readonly notes: string | null;
}

// ---------------------------------------------------------------------------
// Body, per the book. Mirror observations, not measurements.
// ---------------------------------------------------------------------------

export type BodyType = 'rectangle' | 'triangle' | 'inverted_triangle' | 'circular';

/**
 * The five observations the book's mirror protocol asks for, plus the type they
 * resolve to. The type is stored rather than always derived so a wrong
 * classification can be corrected by hand without faking the observations.
 */
export interface BodyProfile {
  readonly shouldersVsHips: 'wider' | 'narrower' | 'equal';
  readonly waistIsWidest: boolean;
  readonly volume: 'top' | 'bottom' | 'center' | 'even';
  readonly line: 'straight' | 'curved';
  readonly thinLegs: boolean;
  readonly bodyType: BodyType;
  /** 'es' or 'en'. Which language the rationale comes back in. */
  readonly language: 'es' | 'en';
}

// ---------------------------------------------------------------------------
// Book rules
// ---------------------------------------------------------------------------

/**
 * `require` is only ever one of the book's explicit donts. Everything else is
 * `prefer`, because a preference promoted to a hard filter empties the
 * wardrobe. Where a `require` is enforced is a separate question, answered by
 * the rule at the top of `bookRules.ts`.
 */
export type Severity = 'require' | 'prefer';

/** Testable against one garment, so a `require` one can be a menu filter. */
export interface GarmentRule {
  readonly kind: 'garment';
  readonly id: string;
  readonly appliesTo: BodyType | 'all';
  readonly severity: Severity;
  readonly slots: readonly Slot[];
  /** Verbatim from the book, shown to the user. Never paraphrased. */
  readonly because: string;
  /** `true` means the garment satisfies the rule. */
  readonly test: (g: Garment) => boolean;
}

/**
 * A garment a rule asks the outfit to contain.
 *
 * Written down instead of being sealed inside the rule's test, because asking
 * for a garment is the one outfit rule shape a wardrobe can make impossible to
 * satisfy, and `wardrobeGaps` has to be able to read what is being asked for.
 * The test is built from the want, so the two can never drift apart.
 */
export interface GarmentWant {
  readonly slots: readonly Slot[];
  /** Plain words for the thing itself, read by the owner when they own none. */
  readonly name: string;
  readonly test: (g: Garment) => boolean;
}

/** Needs the pieces seen together, so it can only be checked after composition. */
export interface OutfitRule {
  readonly kind: 'outfit';
  readonly id: string;
  readonly appliesTo: BodyType | 'all';
  /**
   * A `require` here is enforced by `certify` and never by the menu filter,
   * because the verdict needs the assembled outfit.
   */
  readonly severity: Severity;
  /**
   * Plain words for what the rule reads, written here because only the rule's
   * own test knows and a test cannot be read back out of a function. A garment
   * rule needs no such field: its `slots` already say it.
   */
  readonly scope: string;
  /**
   * Set only by a rule that asks the outfit to contain a garment of some kind,
   * which is the shape `wardrobeGaps` can answer exactly.
   *
   * A rule about how the pieces sit together leaves it out, and that is a real
   * limit rather than a claim that such a rule is always satisfiable. A wardrobe
   * with no dark trousers can block `tri-01` on every outfit, and nothing here
   * will notice: deciding it needs a search over the outfits the wardrobe can
   * build, not a predicate over one garment.
   */
  readonly wants?: GarmentWant;
  readonly because: string;
  /** `true` means the outfit satisfies the rule. */
  readonly test: (o: ResolvedOutfit) => boolean;
}

export type BookRule = GarmentRule | OutfitRule;

// ---------------------------------------------------------------------------
// Moment
// ---------------------------------------------------------------------------

export type EventKind = 'home' | 'errands' | 'work' | 'social' | 'dinner' | 'formal' | 'active';
export type TimeOfDay = 'morning' | 'afternoon' | 'evening';

/** Only produced by `momentFrom` in `worker/routes/recommend.ts`. Every field required and in range. */
export interface Moment {
  readonly tempC: number;
  readonly feelsLikeC: number;
  /** 0 to 1. */
  readonly precipProbability: number;
  readonly windKph: number;
  readonly event: EventKind;
  readonly timeOfDay: TimeOfDay;
  readonly hoursOutdoors: number;
  /** The instant the weather describes. The season is read from it, so the two cannot disagree. */
  readonly date: Date;
  /** Free text. Passed to the model verbatim, never parsed. */
  readonly mood?: string;
}

// ---------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------

/**
 * Two bands, not one. `core` is the outfit without its outer layer, which is
 * what you actually sit in all day. `withOuter` is everything. A single summed
 * band picks a heavy shirt for a cold day, when the right answer is a light
 * shirt under a warm coat.
 */
export interface WarmthBands {
  readonly core: { readonly min: number; readonly max: number };
  readonly withOuter: { readonly min: number; readonly max: number };
  /** Human label for the prompt and the UI. */
  readonly label: string;
}

/**
 * The entire tunable surface. One table, edited by hand when the suggestions
 * feel wrong. This is what having no scorer buys: numbers you can reason about
 * instead of weights in a sum with no ground truth.
 */
export interface Constraints {
  readonly warmth: WarmthBands;
  /** Outfit formality is min(clothes), so this is also a floor on every garment but an accessory. */
  readonly minFormality: Formality;
  readonly season: Season;
  /**
   * Days a garment stays out of the menu after being worn. Not uniform: nobody
   * notices the same jeans twice in a week, everybody notices the same jacket.
   */
  readonly cooldownDays: Readonly<Record<Slot, number>>;
}

// ---------------------------------------------------------------------------
// Wear log
// ---------------------------------------------------------------------------

/** One row of the wear log. Cooldown is measured from it. */
export interface WearEvent {
  readonly wornOn: Date;
  readonly garmentIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/**
 * A filter an owner's request is allowed to override, and nothing else. Every
 * one of these is a fact about today: what season it is, what the day asks for,
 * how recently the garment was worn. A book dont is a fact about the owner's
 * body, it does not change between Tuesday and Friday, and it is the one filter
 * no request waives.
 */
export type Waived = 'season' | 'formality' | 'cooldown';

/**
 * Why a garment is in the menu. `rested` is the ordinary answer and is what the
 * menu's guarantee is about. The other two are the two exceptions, and each one
 * is told to the model rather than hidden, because a garment that is here by
 * exception is a garment the model should have an opinion about.
 */
export type Admission =
  | { readonly by: 'rested' }
  /** Cooldown waived because a required slot would otherwise have emptied. */
  | { readonly by: 'starved_slot' }
  /** The owner named this garment, so the filters it fails were waived for it. */
  | { readonly by: 'owner_asked'; readonly waived: readonly Waived[] };

export interface MenuEntry {
  readonly garment: Garment;
  /** `Infinity` when never worn, so it sorts first with no special case. */
  readonly daysSince: number;
  readonly admittedBy: Admission;
}

/**
 * A garment a filter removed, and what removed it. The menu's shadow.
 *
 * It exists so an owner can ask for a garment by name at all. Nothing outside
 * the menu has a visible id, so without this the override could only reach
 * garments it did not need to reach. Held back is not admitted: `resolveOutfit`
 * reads `bySlot` and never this, so naming one of these in an outfit fails the
 * same way naming a garment that does not exist fails.
 */
export interface HeldBack {
  readonly garment: Garment;
  /** Every filter this garment fails, so the owner is told the whole cost of asking. */
  readonly why: readonly Waived[];
  /** Book donts it fails, by rule id. These are the ones a request cannot waive. */
  readonly bookDonts: readonly string[];
}

/** A garment the owner asked for that the menu would not admit even so. */
export type RefusedRequest =
  | { readonly kind: 'not_in_wardrobe'; readonly id: string }
  | {
      readonly kind: 'book_dont';
      readonly id: string;
      readonly subtype: string;
      readonly ruleId: string;
    };

/**
 * The invariant everything rests on. Every entry already satisfies every
 * distributive constraint, so an outfit built only from menu entries cannot be
 * under-formal, out of season, or against a book dont that no
 * other garment could cover. The donts about how a covered layer looks are
 * `require` OutfitRules, checked by `certify`.
 *
 * The one hole in that is deliberate and is named in every entry: a garment the
 * owner asked for by name carries `admittedBy.by === 'owner_asked'` and the list
 * of filters it failed. Book donts are never on that list, so `certify` still
 * enforces every `require` rule without a waiver to know about.
 */
export interface Menu {
  /** The guarantee above is about these entries and about nothing else in here. */
  readonly bySlot: Readonly<Record<Slot, readonly MenuEntry[]>>;
  readonly starved: readonly RequiredSlot[];
  /** What the filters removed. Shown to the model, never resolvable against. */
  readonly heldBack: readonly HeldBack[];
  /** Requests that were not honored, so a dropped one is never silent. */
  readonly refused: readonly RefusedRequest[];
}

/**
 * The half of a Menu an outfit is resolved against, which is the half that
 * carries the guarantee. `heldBack` and `refused` are the plan call's report to
 * the composer and nothing resolves against them, so a stored plan keeps this
 * much and lets the rest go.
 */
export type MenuChoices = Pick<Menu, 'bySlot'>;

// ---------------------------------------------------------------------------
// Outfits
// ---------------------------------------------------------------------------

/** What the model returns. Garment ids are still bare strings here. */
export interface OutfitProposal {
  readonly base: string;
  readonly bottom: string;
  readonly shoes: string;
  readonly top?: string;
  readonly mid?: string;
  readonly outer?: string;
  readonly accessories?: readonly string[];
  readonly rationale: string;
  /** Book rule ids the model claims this outfit follows. Validated. */
  readonly citedRules: readonly string[];
}

/** Ids resolved against the Menu. Distributive constraints inherited. */
export interface ResolvedOutfit {
  readonly pieces: Readonly<Partial<Record<Slot, Garment>>>;
  readonly accessories: readonly Garment[];
  readonly proposal: OutfitProposal;
}

declare const CERTIFIED: unique symbol;

/**
 * Warmth checked, every `require` rule checked, citations resolved. The only
 * constructor is `certify`, so a function taking this cannot be handed an
 * unchecked outfit.
 */
export interface CertifiedOutfit extends ResolvedOutfit {
  readonly [CERTIFIED]: true;
  readonly cited: readonly BookRule[];
  readonly missed: readonly BookRule[];
  readonly warmthCore: number;
  readonly warmthWithOuter: number;
}

export type RejectionReason =
  | { readonly kind: 'unknown_garment'; readonly slot: Slot; readonly id: string }
  | { readonly kind: 'duplicate_garment'; readonly id: string; readonly slots: readonly Slot[] }
  | { readonly kind: 'missing_required_slot'; readonly slot: RequiredSlot }
  | { readonly kind: 'doubled_accessory'; readonly accessoryKind: AccessoryKind; readonly ids: readonly string[] }
  | { readonly kind: 'warmth_out_of_band'; readonly band: 'core' | 'withOuter'; readonly got: number }
  | { readonly kind: 'unknown_rule'; readonly id: string }
  | { readonly kind: 'rule_not_for_this_body'; readonly id: string }
  | { readonly kind: 'cited_violated_rule'; readonly id: string }
  | { readonly kind: 'broke_required_rule'; readonly id: string };
