/**
 * The book's body classification, client side.
 *
 * The book classifies by looking in a mirror, so nothing here takes a
 * measurement. The five observations are its own questions, in its own order,
 * and every description below is the book's sentence rather than a paraphrase.
 */

/** docs/book/rules.md, "Classification protocol the book prescribes". */
export const MIRROR_PROTOCOL = [
  'Stand front-on to a mirror, in shorts and a tank top, shoulders relaxed.',
  'Judge the overall silhouette and not the details.',
  'Then ask where the volume is: top, bottom, center, or evenly spread.',
];

export const NO_SHAPE_IS_BAD = 'No shape is good or bad, it is the structure you work with.';

export const BODY_TYPES = [
  {
    value: 'rectangle',
    label: 'Rectangle',
    description: 'Shoulders, waist and hips about the same width, straight lines, little marked volume.',
    aside: 'The book calls it the most common male type and the most ignored.',
  },
  {
    value: 'triangle',
    label: 'Triangle',
    description: 'Hips and thighs wider than shoulders, volume concentrated low.',
    aside: null,
  },
  {
    value: 'inverted_triangle',
    label: 'Inverted triangle',
    description: 'Shoulders notably wider than hips, much volume on top, little below.',
    aside: null,
  },
  {
    value: 'circular',
    label: 'Circular',
    description: 'The waist is the widest part of the body, volume concentrated in the center.',
    aside: null,
  },
];

export const BODY_TYPE_BY_VALUE = new Map(BODY_TYPES.map((type) => [type.value, type]));

export function bodyTypeLabel(value) {
  return BODY_TYPE_BY_VALUE.get(value)?.label ?? 'not set';
}

/** The five questions, in the book's order. Values match BodyObservations in the contract. */
export const MIRROR_QUESTIONS = [
  {
    name: 'shouldersVsHips',
    label: 'Shoulders compared to hips',
    type: 'enum',
    options: [
      { value: 'wider', label: 'wider' },
      { value: 'narrower', label: 'narrower' },
      { value: 'equal', label: 'about equal' },
    ],
  },
  {
    name: 'waistIsWidest',
    label: 'Is the waist the widest part of your body',
    type: 'boolean',
    options: [
      { value: 'true', label: 'yes' },
      { value: 'false', label: 'no' },
    ],
  },
  {
    name: 'volume',
    label: 'Where do you carry most volume',
    type: 'enum',
    options: [
      { value: 'top', label: 'top' },
      { value: 'bottom', label: 'bottom' },
      { value: 'center', label: 'center' },
      { value: 'even', label: 'evenly' },
    ],
  },
  {
    name: 'line',
    label: 'Your overall line',
    type: 'enum',
    options: [
      { value: 'straight', label: 'straight with little marked volume' },
      { value: 'curved', label: 'curved' },
    ],
  },
  {
    name: 'thinLegs',
    label: 'Thin legs',
    type: 'boolean',
    hint: 'The book uses this to harden one rule for the inverted triangle.',
    options: [
      { value: 'true', label: 'yes' },
      { value: 'false', label: 'no' },
    ],
  },
];

export const OBSERVATION_NAMES = MIRROR_QUESTIONS.map((question) => question.name);

export function emptyObservations() {
  return Object.fromEntries(OBSERVATION_NAMES.map((name) => [name, null]));
}

export function unanswered(observations) {
  return OBSERVATION_NAMES.filter((name) => observations?.[name] === null || observations?.[name] === undefined);
}

export function isComplete(observations) {
  return unanswered(observations).length === 0;
}

export function sameObservations(left, right) {
  if (left === null || right === null || left === undefined || right === undefined) return false;
  return OBSERVATION_NAMES.every((name) => left[name] === right[name]);
}

/**
 * The book's four types, decided in the order the book decides them.
 *
 * The waist question exists to catch the circular type, so it answers first and
 * outranks everything else. Shoulders against hips is the next comparison, and
 * volume only gets to speak when those two read equal. `line` and `thinLegs`
 * never move the type: `straight` is part of the rectangle description rather
 * than a separate axis, and the book uses thin legs only to harden one inverted
 * triangle rule.
 *
 * This is the same order as `classify` in the engine. It is duplicated here so
 * the type appears as the fifth question is answered, with no round trip, and
 * the server's `suggestedType` still wins once it has spoken.
 */
export function deriveBodyType(observations) {
  if (!isComplete(observations)) return null;
  if (observations.waistIsWidest === true) return 'circular';
  if (observations.shouldersVsHips === 'wider') return 'inverted_triangle';
  if (observations.shouldersVsHips === 'narrower') return 'triangle';
  if (observations.volume === 'center') return 'circular';
  if (observations.volume === 'top') return 'inverted_triangle';
  if (observations.volume === 'bottom') return 'triangle';
  return 'rectangle';
}

export const LANGUAGES = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'English' },
];

export const DEFAULT_LANGUAGE = 'es';

/** The body of `PUT /api/profile`: the five observations, the stored type, the language. */
export function profileBody(observations, bodyType, language) {
  return {
    shouldersVsHips: observations.shouldersVsHips,
    waistIsWidest: observations.waistIsWidest,
    volume: observations.volume,
    line: observations.line,
    thinLegs: observations.thinLegs,
    bodyType,
    language,
  };
}

/**
 * Reads a ProfileResponse. A PUT that answers with the stored profile alone
 * still has to land somewhere, and a suggestion the server left out is derived
 * here rather than shown as missing.
 */
export function readProfile(body) {
  if (body === null || typeof body !== 'object') return { profile: null, suggestedType: null };

  const profile = 'profile' in body ? (body.profile ?? null) : (typeof body.bodyType === 'string' ? body : null);
  if (profile === null) return { profile: null, suggestedType: body.suggestedType ?? null };

  return { profile, suggestedType: body.suggestedType ?? deriveBodyType(profile) };
}
