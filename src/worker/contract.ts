/**
 * The wire contract between the Worker and the web app. Both sides are written
 * against this file, so neither gets to invent a shape.
 *
 * Domain types are re-parsed into these at the boundary. Nothing here leaks a
 * D1 row or an Anthropic response.
 */
import type {
  BodyProfile, BodyType, EventKind, Garment, Season, Slot, TimeOfDay, Waived,
} from '../domain/types';

/** The five mirror observations the book classifies from, before a type is derived. */
export interface BodyObservations {
  readonly shouldersVsHips: 'wider' | 'narrower' | 'equal';
  readonly waistIsWidest: boolean;
  readonly volume: 'top' | 'bottom' | 'center' | 'even';
  readonly line: 'straight' | 'curved';
  readonly thinLegs: boolean;
}

/** `bodyType` is derived from the observations but stored, so a bad call can be corrected by hand. */
export interface ProfileResponse {
  readonly profile: BodyProfile | null;
  /** What the observations imply, so the UI can show it and offer to accept it. */
  readonly suggestedType: BodyType | null;
  /** Where a plan reads its weather from when the caller sends none. */
  readonly home: { readonly lat: number; readonly lon: number } | null;
}

export interface WeatherResponse {
  readonly tempC: number;
  readonly feelsLikeC: number;
  /** 0 to 1. */
  readonly precipProbability: number;
  readonly windKph: number;
  readonly label: string;
}

/** Weather fields are optional: send them, or send a location and let the Worker fetch. */
export interface RecommendRequest {
  readonly event: EventKind;
  readonly timeOfDay: TimeOfDay;
  readonly hoursOutdoors: number;
  readonly mood?: string;
  readonly tempC?: number;
  readonly feelsLikeC?: number;
  readonly precipProbability?: number;
  readonly windKph?: number;
  readonly lat?: number;
  readonly lon?: number;
}

/**
 * A rule as the user sees it. `because` is the book's own sentence, never a
 * paraphrase, because the whole promise is that the advice traces to the book.
 * `short` is the same line's THEN half in a few of the book's words, for the
 * pill that stands in front of the sentence, and it is never a paraphrase
 * either.
 */
export interface RuleView {
  readonly id: string;
  readonly short: string;
  readonly because: string;
}

/**
 * A guide rule this wardrobe cannot satisfy, as the wardrobe screen draws it.
 * The wire shape of a `WardrobeGap`, which needs no reshaping to travel.
 *
 * `slots` are the exact slots that fall short and are never widened into a
 * group word here. `base`, `top` and `mid` all read as "tops" to the styling
 * book, so a gap in `base` alone would be drawn as "nothing you own in tops"
 * while a shirt that passes sits in the same wardrobe. The screen names these
 * with the same words its own filter chips use, so the owner can go and look.
 */
export interface GapView {
  readonly id: string;
  readonly because: string;
  readonly needs: string | null;
  readonly slots: readonly Slot[];
}

/**
 * A garment as a screen draws it.
 *
 * `photoVersion` is not a fact about clothes, so it has no place on the domain
 * `Garment` and lives beside it on `StoredGarment` instead. A view still has to
 * carry it: `/img/:kind/:id` answers `immutable`, and the version is the only
 * thing in the URL that changes when the owner edits a cutout. Leave it out and
 * the screen keeps drawing the photo the phone cached before the edit.
 */
export interface GarmentView extends Garment {
  readonly photoVersion: number;
}

/**
 * What `/api/garments` answers with: the domain garment flattened, plus the
 * stored facts the screens read. `toJson` in repo.ts builds it and the web
 * app's `api.js` is written against it, so neither side gets to invent a shape.
 *
 * `taggingError` and `missing` ride along only on a 201 from an upload, where
 * they say the photo is stored and nothing looked at it yet.
 */
export interface StoredGarmentView extends GarmentView {
  readonly reviewed: boolean;
  readonly uncertain: readonly string[];
  readonly archived: boolean;
  readonly createdAt: string;
  readonly taggingError?: string;
  readonly missing?: readonly string[];
}

export interface OutfitView {
  /** Ordered base, top, mid, outer, bottom, shoes. Absent slots omitted. */
  readonly pieces: readonly { readonly slot: Slot; readonly garment: Garment }[];
  readonly accessories: readonly Garment[];
  readonly rationale: string;
  readonly cited: readonly RuleView[];
  /**
   * Preference rules this outfit knowingly misses. Shown, never hidden.
   *
   * A saved outfit read back through `toSaved` drops the ones no outfit could
   * have met, which reach the owner as a `GapView` on the wardrobe screen
   * instead. The deterministic composer behind `/recommend` does not, because
   * it never sees the wardrobe, only the menu built from it.
   */
  readonly missed: readonly RuleView[];
  readonly warmthCore: number;
  readonly warmthWithOuter: number;
}

/**
 * `starved` and `rejected` are surfaced rather than swallowed. An empty answer
 * with no explanation is the one outcome that makes the app feel broken.
 */
export interface RecommendResponse {
  readonly outfits: readonly OutfitView[];
  readonly weather: WeatherResponse;
  readonly season: Season;
  readonly minFormality: number;
  readonly warmthLabel: string;
  readonly starved: readonly Slot[];
  /** How many compositions failed certification, and why. Diagnostic, shown small. */
  readonly rejected: readonly string[];
}

export interface WearRequest {
  readonly garmentIds: readonly string[];
  readonly event?: EventKind;
  /**
   * The saved outfit this wear was. Optional because a wear can name none:
   * clothes put on without an outfit saved for them are still worn, and every
   * row written before the column existed names none. Where it is named, it is
   * the only thing that tells two outfits worn on the same day apart.
   */
  readonly outfitId?: string;
}

/** One piece of an outfit, named by the garment rather than by the slot alone. */
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

/** The same, as the app reads it. `subtype` is null for a garment archived since. */
export interface HonoredRequest extends Waiver {
  readonly subtype: string | null;
}

export interface OwnerRequest {
  readonly words: string;
  readonly disagreement: string | null;
  readonly honored: readonly HonoredRequest[];
}

/** One correction, hydrated. `subtype` is null for a garment archived since. */
export interface Correction {
  readonly at: string;
  readonly event: EventKind | null;
  readonly slot: Slot;
  /** Null when the owner added a piece the outfit never had. */
  readonly from: { readonly id: string; readonly subtype: string | null } | null;
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

/**
 * What the web app reads. `OutfitView` plus the state only a stored outfit has.
 *
 * This is the largest shape that crosses the wire, and it lives here for the
 * reason the file says: written down once, so neither side invents it. The
 * client re-parses it through `readOutfit` rather than trusting it, and the
 * parse is written against this.
 */
export interface SavedOutfit extends OutfitView {
  /**
   * Narrowed to the view garment, because these are the ones the card draws and
   * a cutout the owner edited only reaches them through `photoVersion`.
   */
  readonly pieces: readonly { readonly slot: Slot; readonly garment: GarmentView }[];
  readonly accessories: readonly GarmentView[];
  readonly id: string;
  /**
   * The plan this outfit was composed against. Outfits sharing one were composed
   * as options for a single request, and this is the only thing that says two
   * cards are two answers to one question.
   *
   * Not a key a reader can follow. The plan itself lives in KV for an hour and
   * is gone long before a card is drawn, so the id groups the outfits and
   * nothing else.
   */
  readonly planId: string;
  readonly event: EventKind | null;
  /**
   * What the assistant called this outfit, its own words the way the rationale
   * is. Null on anything saved before the column existed.
   */
  readonly title: string | null;
  readonly createdAt: string;
  /**
   * The book's donts this outfit breaks, which `missed` never holds: that list
   * is the preferences it set aside, and the two read as different things.
   *
   * Almost always the work of a change made by hand, because `certify` refuses
   * `broke_required_rule` before an outfit is saved and `editPiece` records what
   * the owner did rather than turning them away. Not a claim that the owner
   * caused it, and nothing here should say so. A garment retagged after the
   * outfit was saved, or a rule the book has since made a dont, both land a
   * `require` id here having broken nothing at the time.
   */
  readonly broke: readonly RuleView[];
  /**
   * Worn on either reading: a wear row that names this outfit, or, for a row
   * that names none, the day and the garments.
   */
  readonly worn: boolean;
  /**
   * Whether a wear row names this outfit, which `worn` does not say. Removing
   * an outfit takes only the rows that name it, so this is what answers whether
   * removing it hands the garments their cooldown back. Every row written
   * before migration 009 names none, so an outfit worn before this shipped
   * reads `worn` and not this.
   */
  readonly wearNamed: boolean;
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

/**
 * The envelopes the outfit routes answer with. Only the 2xx shapes are here:
 * every other status carries `{ error }` and the client turns it into a thrown
 * `ApiError` before a screen sees it.
 */
export interface OutfitsResponse {
  readonly outfits: readonly SavedOutfit[];
}

export interface EditPieceResponse {
  readonly outfit: SavedOutfit;
}

export interface RemoveOutfitResponse {
  readonly ok: true;
}

export interface GapsResponse {
  readonly gaps: readonly GapView[];
}
