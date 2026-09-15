const options = (...values) => values.map((value) => ({ value, label: value }));

const YES_NO = [
  { value: 'true', label: 'yes' },
  { value: 'false', label: 'no' },
];

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

const SLOT_OPTIONS = [
  { value: 'base', label: 'base, against the skin' },
  { value: 'top', label: 'top, worn over a base' },
  { value: 'mid', label: 'mid, sweater or blazer' },
  { value: 'outer', label: 'outer, coat or heavy jacket' },
  { value: 'bottom', label: 'bottom' },
  { value: 'shoes', label: 'shoes' },
  { value: 'accessory', label: 'accessory' },
];

export const SLOTS = SLOT_OPTIONS.map((option) => option.value);

/**
 * Copied from VISION_SYSTEM_PROMPT in src/worker/vision.ts. The point of showing
 * them is that the user grades against the same scale the tagger used, so any
 * rewording here would quietly break that.
 */
export const ANCHORS = {
  warmth: {
    scale:
      'How much this one piece adds to how warm the wearer is. The app sums warmth across the layers of an outfit, so score the piece by itself.',
    steps: [
      { value: 0, text: 'tank top, sandals, thin shorts' },
      { value: 1, text: 't-shirt, linen shirt, chino shorts, low sneakers' },
      { value: 2, text: 'long sleeve shirt, jeans, chinos, light knit polo' },
      { value: 3, text: 'sweater, hoodie, denim jacket, light jacket, blazer' },
      { value: 4, text: 'wool coat, thick puffer, heavy knit' },
      { value: 5, text: 'heavy parka, expedition coat' },
    ],
  },
  formality: {
    scale:
      "The least formal room this piece belongs in. The app takes an outfit's formality as the minimum across its pieces, so a piece that drags the outfit down has to score low.",
    steps: [
      { value: 1, text: 'gym and loungewear: sweatpants, running shoes, tech tees' },
      { value: 2, text: 'casual: tee, jeans, sneakers, hoodie' },
      {
        value: 3,
        text: 'smart casual: chinos and a polo, clean dark denim, unstructured blazer, leather sneakers, loafers',
      },
      { value: 4, text: 'dressy: blazer, dress shirt, wool trousers, leather dress shoes' },
      { value: 5, text: 'formal: suit, tuxedo, oxfords, black tie and up' },
    ],
  },
};

const anchorOptions = (field) =>
  ANCHORS[field].steps.map((step) => ({ value: String(step.value), label: `${step.value}  ${step.text}` }));

export const FIELDS = [
  { name: 'slot', label: 'Slot', type: 'enum', control: 'select', options: SLOT_OPTIONS },
  {
    name: 'subtype',
    label: 'Subtype',
    type: 'string',
    control: 'text',
    placeholder: 'oxford shirt',
    hint: 'Two or three lowercase words, the words a person would say out loud.',
  },
  {
    name: 'warmth',
    label: 'Warmth',
    type: 'number',
    control: 'select',
    options: anchorOptions('warmth'),
    anchors: 'warmth',
  },
  {
    name: 'formality',
    label: 'Formality',
    type: 'number',
    control: 'select',
    options: anchorOptions('formality'),
    anchors: 'formality',
  },
  {
    name: 'colors',
    label: 'Colors',
    type: 'colors',
    control: 'text',
    placeholder: 'navy, off white',
    hint: 'One to three plain color words, the largest area of the garment first.',
  },
  {
    name: 'colorRole',
    label: 'Color role',
    type: 'enum',
    control: 'select',
    options: options('neutral', 'accent'),
    hint: 'Neutral for black, white, gray, navy, beige, brown, olive and denim blue.',
  },
  { name: 'pattern', label: 'Pattern', type: 'enum', control: 'select', options: options('solid', 'stripe', 'check', 'print') },
  {
    name: 'fabric',
    label: 'Fabric',
    type: 'enum',
    control: 'select',
    nullable: true,
    options: options('cotton', 'wool', 'linen', 'denim', 'leather', 'synthetic'),
  },
  {
    name: 'fit',
    label: 'Fit',
    type: 'enum',
    control: 'select',
    nullable: true,
    options: options('tight', 'fitted', 'regular', 'relaxed', 'oversized'),
    hint: 'How close the cut sits to the body it was made for.',
  },
  {
    name: 'structured',
    label: 'Structured',
    type: 'boolean',
    control: 'select',
    options: YES_NO,
    hint: 'Yes when the garment holds its own shape instead of draping.',
  },
  {
    name: 'rise',
    label: 'Rise',
    type: 'enum',
    control: 'select',
    nullable: true,
    options: options('low', 'mid', 'high'),
    hint: 'Where the waistband sits.',
  },
  {
    name: 'leg',
    label: 'Leg',
    type: 'enum',
    control: 'select',
    nullable: true,
    options: options('skinny', 'tapered', 'straight', 'relaxed', 'wide'),
    hint: 'The line from the knee to the hem.',
  },
  {
    name: 'neckline',
    label: 'Neckline',
    type: 'enum',
    control: 'select',
    nullable: true,
    options: [
      { value: 'crew', label: 'crew' },
      { value: 'v', label: 'v' },
      { value: 'open', label: 'open, a collar or buttons worn open' },
      { value: 'high', label: 'high, mock neck or turtleneck' },
      { value: 'none', label: 'none' },
    ],
  },
  { name: 'sleeves', label: 'Sleeves', type: 'enum', control: 'select', nullable: true, options: options('none', 'short', 'long') },
  {
    name: 'hem',
    label: 'Hem',
    type: 'enum',
    control: 'select',
    nullable: true,
    options: options('above_waist', 'at_waist', 'past_waist', 'hip', 'below_hip'),
    hint: 'Where the bottom edge falls on the torso.',
  },
  {
    name: 'accessoryKind',
    label: 'Kind',
    type: 'enum',
    control: 'select',
    nullable: true,
    options: options(
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
    ),
  },
  {
    name: 'shoulderBulk',
    label: 'Shoulder bulk',
    type: 'boolean',
    control: 'select',
    options: YES_NO,
    hint: 'Yes only when the shoulders are padded or built up.',
  },
  {
    name: 'seasons',
    label: 'Seasons',
    type: 'seasons',
    control: 'chips',
    options: SEASONS,
    hint: 'Every season the piece is comfortable in. Most pieces suit two or three.',
  },
  {
    name: 'notes',
    label: 'Notes',
    type: 'string',
    control: 'textarea',
    nullable: true,
    hint: 'Only when something matters and no other field carries it.',
  },
];

export const FIELD_BY_NAME = new Map(FIELDS.map((field) => [field.name, field]));

export function fieldLabel(name) {
  return FIELD_BY_NAME.get(name)?.label ?? name;
}

const BOTTOM_ONLY = ['rise', 'leg'];
const TOP_ONLY = ['neckline', 'sleeves', 'hem'];
const ACCESSORY_ONLY = ['accessoryKind'];
const TOP_SLOTS = new Set(['base', 'top', 'mid', 'outer']);

export function isRelevant(field, slot) {
  if (BOTTOM_ONLY.includes(field)) return slot === 'bottom';
  if (TOP_ONLY.includes(field)) return TOP_SLOTS.has(slot);
  if (ACCESSORY_ONLY.includes(field)) return slot === 'accessory';
  return true;
}

export function relevantFields(slot) {
  return FIELDS.filter((field) => isRelevant(field.name, slot)).map((field) => field.name);
}
