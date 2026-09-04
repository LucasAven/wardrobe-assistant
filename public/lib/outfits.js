/**
 * Reading a RecommendResponse.
 *
 * Two promises live here. Book rules are shown with the book's own `because`
 * sentence and never mixed with the model's prose, and an answer with no
 * outfits still says something, because a blank screen is the one outcome that
 * makes the app feel broken.
 */
import { formalityLabel } from './vocab.js';

/** Base to shoes, the order the pieces are worn in. */
export const LAYER_ORDER = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes'];

const WINDY_KPH = 25;

/** The contract already orders the pieces. Sorting again costs nothing and the screen stops depending on it. */
export function orderPieces(pieces) {
  const rank = (piece) => {
    const at = LAYER_ORDER.indexOf(piece.slot);
    return at < 0 ? LAYER_ORDER.length : at;
  };
  return [...(pieces ?? [])].sort((left, right) => rank(left) - rank(right));
}

function dedupeById(rules) {
  const seen = new Set();
  const kept = [];
  for (const rule of rules ?? []) {
    if (rule === null || rule === undefined || seen.has(rule.id)) continue;
    seen.add(rule.id);
    kept.push(rule);
  }
  return kept;
}

/**
 * Cited and missed are two lists the user reads as opposites, so a rule in both
 * would say the outfit follows a rule it breaks. Cited wins.
 */
export function splitRules(outfit) {
  const cited = dedupeById(outfit?.cited);
  const citedIds = new Set(cited.map((rule) => rule.id));
  return { cited, missed: dedupeById(outfit?.missed).filter((rule) => !citedIds.has(rule.id)) };
}

export function garmentIds(outfit) {
  const pieces = (outfit?.pieces ?? []).map((piece) => piece.garment.id);
  const accessories = (outfit?.accessories ?? []).map((garment) => garment.id);
  return [...pieces, ...accessories];
}

export function warmthLine(outfit) {
  if (outfit.warmthWithOuter > outfit.warmthCore) {
    return `warmth ${outfit.warmthCore}, ${outfit.warmthWithOuter} with the outer layer`;
  }
  return `warmth ${outfit.warmthCore}`;
}

/** What the moment resolved to, small, so the user can see why the answer looks the way it does. */
export function momentChips(response) {
  const chips = [];
  const weather = response?.weather ?? null;

  if (weather !== null) {
    // `label` is skipped: it spells the temperature out in words, and the chip beside it is the same fact.
    chips.push(`${Math.round(weather.tempC)}°, feels like ${Math.round(weather.feelsLikeC)}°`);
    if (weather.precipProbability > 0) chips.push(`${Math.round(weather.precipProbability * 100)}% rain`);
    if (weather.windKph >= WINDY_KPH) chips.push(`wind ${Math.round(weather.windKph)} km/h`);
  }

  if (typeof response?.warmthLabel === 'string' && response.warmthLabel !== '') chips.push(response.warmthLabel);
  if (typeof response?.season === 'string') chips.push(response.season);
  if (Number.isFinite(response?.minFormality)) chips.push(`${formalityLabel(response.minFormality)} and up`);
  return chips;
}

function joinWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * An empty answer, explained. "Nothing you own is formal enough for this" is a
 * useful screen. A blank one is not.
 */
export function emptyReport(response) {
  const starved = [...(response?.starved ?? [])];
  const reasons = [...(response?.rejected ?? [])];
  const floor = Number.isFinite(response?.minFormality) ? formalityLabel(response.minFormality) : 'formal enough';
  const season = typeof response?.season === 'string' ? response.season : 'the season';

  if (starved.length > 0) {
    return {
      title: `Nothing you own fits the ${joinWords(starved)} slot${starved.length === 1 ? '' : 's'}.`,
      detail: `Every piece has to be ${floor} or dressier and right for ${season}. Nothing there clears both.`,
      reasons,
    };
  }

  if (reasons.length > 0) {
    return {
      title: 'Outfits were put together, then dropped.',
      detail:
        reasons.length === 1
          ? 'One did not pass. Here is what went wrong.'
          : `${reasons.length} did not pass. Here is what went wrong.`,
      reasons,
    };
  }

  return {
    title: 'No outfits came back.',
    detail: 'The server sent no reason with it. Ask again, or change the moment.',
    reasons: [],
  };
}
