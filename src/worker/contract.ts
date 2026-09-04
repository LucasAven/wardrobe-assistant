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
 */
export interface RuleView {
  readonly id: string;
  readonly because: string;
}

export interface OutfitView {
  /** Ordered base, top, mid, outer, bottom, shoes. Absent slots omitted. */
  readonly pieces: readonly { readonly slot: Slot; readonly garment: Garment }[];
  readonly accessories: readonly Garment[];
  readonly rationale: string;
  readonly cited: readonly RuleView[];
  /** Preference rules this outfit knowingly misses. Shown, never hidden. */
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
}
