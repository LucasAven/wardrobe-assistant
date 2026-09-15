/**
 * The wire contract between the Worker and the web app. Both sides are written
 * against this file, so neither gets to invent a shape.
 *
 * Domain types are re-parsed into these at the boundary. Nothing here leaks a
 * D1 row or an Anthropic response.
 */
import type {
  BodyProfile, BodyType, EventKind, Garment, Season, Slot, TimeOfDay,
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
