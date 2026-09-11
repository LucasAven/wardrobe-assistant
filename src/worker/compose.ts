/**
 * The one call that composes. Code has already removed every garment that
 * breaks a distributive constraint, so the model chooses from a menu where a
 * wrong answer is only ever a matter of taste, warmth, or a book dont that needs
 * the pieces seen together.
 *
 * Rejection, never repair. A returned outfit that fails certification is thrown
 * away whole, and a second call composes from scratch. Patching the clothes and
 * keeping the rationale would ship a sentence about an outfit nobody is wearing.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { BODY_TYPE_MEANING } from '../domain/bodyType';
import { rulesFor } from '../domain/bookRules';
import { certify, resolveOutfit } from '../domain/certify';
import type {
  BodyProfile,
  BodyType,
  BookRule,
  CertifiedOutfit,
  Constraints,
  Menu,
  MenuEntry,
  Moment,
  OutfitProposal,
  RejectionReason,
  Slot,
} from '../domain/types';
import type { OutfitView, RuleView } from './contract';
import type { Env } from './env';
import { VISION_SYSTEM_PROMPT } from './vision';

const COMPOSE_MODEL = 'claude-opus-5';

/** Two, ever. The second one is the resample, and there is no third. */
const MAX_CALLS = 2;
const OUTFITS_ASKED_FOR = 3;
const ENOUGH_OUTFITS = 2;

export interface ComposeInput {
  readonly profile: BodyProfile;
  readonly constraints: Constraints;
  readonly menu: Menu;
  readonly moment: Moment;
}

export interface ComposeResult {
  readonly outfits: readonly OutfitView[];
  readonly rejected: readonly string[];
}

/**
 * Plain strings rather than enums, for the reason `RawGarmentDraftSchema` gives
 * in `vision.ts`: the SDK's JSON schema transform turns everything but `type`,
 * `description` and structure into prose in the description, so a constraint
 * declared here would only move the rejection to our side of the wire.
 */
const ProposalSchema = z.object({
  base: z.string().describe('Garment id from the base menu.'),
  top: z.string().nullable().describe('Garment id from the top menu, or null for no top layer.'),
  mid: z.string().nullable().describe('Garment id from the mid menu, or null for no mid layer.'),
  outer: z.string().nullable().describe('Garment id from the outer menu, or null for no outer layer.'),
  bottom: z.string().describe('Garment id from the bottom menu.'),
  shoes: z.string().describe('Garment id from the shoes menu.'),
  accessories: z.array(z.string()).describe('Garment ids from the accessory menu. Empty array for none.'),
  rationale: z
    .string()
    .describe('Two or three sentences to the wearer about why these pieces work together today.'),
  citedRules: z.array(z.string()).describe('Ids of the guide rules this outfit follows.'),
});

const CompositionSchema = z.object({
  outfits: z.array(ProposalSchema).describe(`Exactly ${OUTFITS_ASKED_FOR} outfits.`),
});

export type RawProposal = z.infer<typeof ProposalSchema>;

function idOrNothing(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function toProposal(raw: RawProposal): OutfitProposal {
  const layers: { top?: string; mid?: string; outer?: string } = {};
  const top = idOrNothing(raw.top);
  const mid = idOrNothing(raw.mid);
  const outer = idOrNothing(raw.outer);
  if (top !== undefined) layers.top = top;
  if (mid !== undefined) layers.mid = mid;
  if (outer !== undefined) layers.outer = outer;

  return {
    base: raw.base,
    bottom: raw.bottom,
    shoes: raw.shoes,
    ...layers,
    accessories: raw.accessories ?? [],
    rationale: raw.rationale,
    citedRules: raw.citedRules ?? [],
  };
}

const ANCHORS_START = 'WARMTH, 0 to 5.';
const ANCHORS_END = '\n\nWarmth and formality are';

/**
 * Lifted out of the vision prompt rather than rewritten. These two numbers were
 * scored against those anchors when the photo was tagged, so a composer reading
 * a different scale would be reasoning about numbers that do not mean what it
 * thinks they mean.
 */
export function calibrationAnchors(): string {
  const from = VISION_SYSTEM_PROMPT.indexOf(ANCHORS_START);
  const to = VISION_SYSTEM_PROMPT.indexOf(ANCHORS_END, from);
  if (from < 0 || to < 0) {
    throw new Error('the vision prompt no longer carries the warmth and formality anchors');
  }
  return VISION_SYSTEM_PROMPT.slice(from, to).trimEnd();
}

const TYPE_NAMES: Readonly<Record<BodyType, string>> = {
  rectangle: 'rectangle',
  triangle: 'triangle',
  inverted_triangle: 'inverted triangle',
  circular: 'circular',
};

export const LANGUAGE_NAMES: Readonly<Record<BodyProfile['language'], string>> = {
  es: 'Spanish',
  en: 'English',
};

const SLOT_WORDS: Readonly<Record<Slot, string>> = {
  base: 'tops',
  top: 'tops',
  mid: 'tops',
  outer: 'coats',
  bottom: 'trousers',
  shoes: 'shoes',
  accessory: 'accessories',
};

/**
 * On its own `outer` can carry its longer name. Inside a list it stays one
 * word, so `and` keeps separating the groups instead of joining two of them.
 */
const OUTER_ALONE = 'coats and jackets';
const WHOLE_OUTFIT = 'the whole outfit';

/**
 * `all-01` and `all-02` hold `test: () => true`, because which zone gains and
 * which one loses is per body type. Naming a scope for them would promise a
 * verdict that never comes.
 */
const PRINCIPLE = 'a principle to work from, not a check';

/**
 * What each outfit rule reads. Only the rule's own test knows, and a test is
 * not readable back out of a function, so each one is written down here against
 * an id the book rules never renumber.
 */
const OUTFIT_SCOPES: Readonly<Record<string, string>> = {
  'all-01': PRINCIPLE,
  'all-02': PRINCIPLE,
  'rect-01': 'every torso layer',
  'rect-05b': 'the layer on show',
  'rect-06b': 'the layer on show',
  'rect-07': 'the tops with the trousers',
  'tri-01': 'the torso layers with the trousers',
  'tri-03': 'the layers and accessories at the shoulders',
  'tri-05': 'the accessories',
  'tri-07': 'the tops with the trousers',
  'tri-08': 'every torso layer',
  'inv-03': 'the tops with the trousers',
  'inv-04': 'the tops with the trousers',
  'inv-06': 'the accessories',
  'inv-08b': 'the layer on show',
  'circ-03': 'the tops, coats and trousers together',
  'circ-05': 'the top on show when no coat is worn',
  'circ-06': 'the top on show when no coat is worn',
  'circ-07': 'the top on show when no coat is worn',
  'circ-09': 'the tops with the trousers',
};

function joinScope(words: readonly string[]): string {
  const last = words[words.length - 1];
  if (last === undefined) return WHOLE_OUTFIT;
  if (words.length === 1) return last === SLOT_WORDS.outer ? OUTER_ALONE : last;
  return `${words.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * Plain words for what the rule is judged over. Some book lines are split into
 * a garment half and an outfit half that share the book's sentence, so without
 * this the prompt carries the same line twice and the model cannot tell which
 * id to cite.
 */
export function ruleScope(rule: BookRule): string {
  if (rule.kind === 'outfit') return OUTFIT_SCOPES[rule.id] ?? WHOLE_OUTFIT;
  return joinScope([...new Set(rule.slots.map((slot) => SLOT_WORDS[slot]))]);
}

export function ruleLine(rule: BookRule): string {
  return `  ${rule.id} (${ruleScope(rule)}): ${rule.because}`;
}

const SHOULDERS_SEEN: Readonly<Record<BodyProfile['shouldersVsHips'], string>> = {
  wider: 'the shoulders are wider than the hips',
  narrower: 'the shoulders are narrower than the hips',
  equal: 'the shoulders and the hips are about the same width',
};

const VOLUME_SEEN: Readonly<Record<BodyProfile['volume'], string>> = {
  top: 'the volume sits up top',
  bottom: 'the volume sits low',
  center: 'the volume sits in the center',
  even: 'the volume is spread evenly',
};

const LINE_SEEN: Readonly<Record<BodyProfile['line'], string>> = {
  straight: 'The line of the body is straight, with little marked volume.',
  curved: 'The line of the body is curved.',
};

/**
 * All five mirror answers, because a rule test is handed an outfit and never the
 * profile. `line` and `thinLegs` reach no predicate at all, so the model reading
 * this is the only place they can change an outfit.
 */
export function bodyText(profile: BodyProfile): string {
  const waist = profile.waistIsWidest
    ? 'the waist is the widest part of the body'
    : 'the waist is not the widest part of the body';
  const legs = profile.thinLegs ? 'The legs are thin.' : 'The legs are not thin.';

  const lines = [
    `${TYPE_NAMES[profile.bodyType]}. ${BODY_TYPE_MEANING[profile.bodyType]}`,
    `This person saw in the mirror that ${SHOULDERS_SEEN[profile.shouldersVsHips]}, that ${waist}, and that ${VOLUME_SEEN[profile.volume]}.`,
    `${LINE_SEEN[profile.line]} ${legs}`,
    'The line and the legs describe the body but did not decide the type, so do not read them as evidence for it.',
  ];

  if (profile.bodyType === 'inverted_triangle' && profile.thinLegs) {
    lines.push(
      'Thin legs are the case where the guide asks for more volume in the trousers, and inv-04 is the rule that says so.',
    );
  }

  return lines.join('\n');
}

export function systemPrompt(profile: BodyProfile): string {
  const bodyType = profile.bodyType;
  const rules = rulesFor(bodyType).map(ruleLine).join('\n');

  return `You dress one person from the clothes they already own. A men's styling guide supplies every claim you make about their body shape, and you supply the taste.

THE BODY
${bodyText(profile)}

THE GUIDE
These are the guide's rules for this body, and the only rules that exist. Each line is an id, what the rule covers, and then the guide's own reason for it.

${rules}

${calibrationAnchors()}

THE RULE THAT MATTERS MOST
Every garment id you write must be one you can see in the menu in the next message. Not one you remember, not one you build out of a color and a garment name, not a plausible id for something this person probably owns. An id that is not in the menu throws away the whole outfit it appears in, and the person is shown nothing.

SOURCE HONESTY
Your own styling knowledge is welcome and wanted. It is not the guide. A sentence only speaks for the guide when you cite the id of the rule it comes from, so write everything else as your own read. Never put an idea in the guide's mouth to make it sound settled.

WHAT TO SEND BACK
${OUTFITS_ASKED_FOR} outfits, different from each other in more than one piece. Every one fills base, bottom and shoes, and adds top, mid, outer and accessories when the day calls for them.

"rationale" is two or three sentences written to the wearer in ${LANGUAGE_NAMES[profile.language]}, saying what this outfit is doing for them today.
"citedRules" holds the ids above that this outfit actually follows. Rule ids are ids in every language, so never translate one and never invent one.`;
}

const MENU_ORDER: readonly Slot[] = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes', 'accessory'];
const VIEW_ORDER: readonly Slot[] = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes'];

function lastWorn(entry: MenuEntry): string {
  const when =
    entry.daysSince === Infinity
      ? 'not worn recently'
      : entry.daysSince === 0
        ? 'worn today'
        : entry.daysSince === 1
          ? 'worn yesterday'
          : `worn ${entry.daysSince} days ago`;
  return entry.reAdmitted ? `${when}, back early because the slot would be empty` : when;
}

function garmentLine(entry: MenuEntry): string {
  const g = entry.garment;
  const parts: string[] = [g.id, g.subtype];
  if (g.colors.length > 0) parts.push(g.colors.join(' and '));
  if (g.fit !== null) parts.push(`fit ${g.fit}`);
  if (g.rise !== null) parts.push(`rise ${g.rise}`);
  if (g.leg !== null) parts.push(`leg ${g.leg}`);
  if (g.hem !== null) parts.push(`hem ${g.hem}`);
  if (g.neckline !== null) parts.push(`neck ${g.neckline}`);
  if (g.sleeves !== null) parts.push(`sleeves ${g.sleeves}`);
  if (g.accessoryKind !== null) parts.push(`kind ${g.accessoryKind}`);
  parts.push(g.pattern);
  if (g.structured) parts.push('structured');
  if (g.shoulderBulk) parts.push('shoulder bulk');
  parts.push(`warmth ${g.warmth}`, `formality ${g.formality}`, lastWorn(entry));
  return `  ${parts.join(' | ')}`;
}

function menuText(menu: Menu): string {
  const filled = MENU_ORDER.filter((slot) => menu.bySlot[slot].length > 0).map(
    (slot) => `${slot}\n${menu.bySlot[slot].map(garmentLine).join('\n')}`,
  );
  return filled.join('\n\n');
}

function emptySlots(menu: Menu): readonly Slot[] {
  return MENU_ORDER.filter((slot) => menu.bySlot[slot].length === 0);
}

function momentText(moment: Moment): string {
  const lines = [
    `  weather      ${Math.round(moment.tempC)} degrees, feels like ${Math.round(moment.feelsLikeC)}, wind ${Math.round(moment.windKph)} kph, ${Math.round(moment.precipProbability * 100)}% chance of rain`,
    `  event        ${moment.event}`,
    `  time of day  ${moment.timeOfDay}`,
    `  outdoors     ${moment.hoursOutdoors} hours of the day spent outside`,
  ];
  if (moment.mood !== undefined && moment.mood.trim() !== '') {
    lines.push(`  mood         ${moment.mood.trim()}`);
  }
  return lines.join('\n');
}

function constraintsText(constraints: Constraints): string {
  const { core, withOuter } = constraints.warmth;
  return [
    `  core warmth      base plus top plus mid has to sum to between ${core.min} and ${core.max}. This is what is worn once the coat comes off, and it is most of the day.`,
    `  total warmth     with the outer layer added, between ${withOuter.min} and ${withOuter.max}.`,
    `  the day reads    ${constraints.warmth.label}`,
    `  formality floor  ${constraints.minFormality} and up, already true of everything in the menu.`,
    `  season           ${constraints.season}, already true of everything in the menu.`,
    constraints.rainProof
      ? '  rain             counts today, so the menu already holds only water resistant outerwear and shoes.'
      : '  rain             not a factor today.',
  ].join('\n');
}

export function userMessage(input: ComposeInput): string {
  const empty = emptySlots(input.menu);
  const sections = [
    `TODAY\n${momentText(input.moment)}`,
    `WHAT THE OUTFIT HAS TO SATISFY\n${constraintsText(input.constraints)}`,
  ];

  if (empty.length > 0) {
    sections.push(
      `SLOTS WITH NOTHING IN THEM\n  ${empty.join(', ')}. Nothing this person owns is available there today, so compose without them and do not mention the gap.`,
    );
  }

  sections.push(`THE MENU\nEvery garment you may name, and nothing else.\n\n${menuText(input.menu)}`);
  return sections.join('\n\n');
}

function resampleNote(failures: readonly string[]): string {
  return `THE SET YOU JUST SENT CANNOT BE SHOWN
${failures.map((failure) => `  ${failure}`).join('\n')}

Compose ${OUTFITS_ASKED_FOR} outfits again from the menu above, and write new rationales for them. Do not hand back a corrected version of what you just sent: a rationale written about different clothes describes something this person is not wearing.`;
}

export function reasonText(reason: RejectionReason, constraints: Constraints): string {
  switch (reason.kind) {
    case 'unknown_garment':
      return `${reason.id} is not in the ${reason.slot} menu`;
    case 'duplicate_garment':
      return `${reason.id} was used twice, as ${reason.slots.join(' and ')}`;
    case 'missing_required_slot':
      return `no ${reason.slot} was named`;
    case 'doubled_accessory':
      return `${reason.ids.join(' and ')} are the same kind of accessory, ${reason.accessoryKind}, and only one can be worn`;
    case 'warmth_out_of_band': {
      const band = constraints.warmth[reason.band];
      const named = reason.band === 'core' ? 'core warmth' : 'warmth with the outer layer';
      return `${named} came to ${reason.got}, outside the ${band.min} to ${band.max} the day needs`;
    }
    case 'unknown_rule':
      return `it cited ${reason.id}, which is not a rule`;
    case 'rule_not_for_this_body':
      return `it cited ${reason.id}, which is not a rule for this body`;
    case 'cited_violated_rule':
      return `it cited ${reason.id} while breaking it`;
    case 'broke_required_rule':
      return `it breaks ${reason.id}, which the guide states as a dont`;
  }
}

export const ruleView = (rule: BookRule): RuleView => ({ id: rule.id, because: rule.because });

function toView(outfit: CertifiedOutfit): OutfitView {
  return {
    pieces: VIEW_ORDER.flatMap((slot) => {
      const garment = outfit.pieces[slot];
      return garment === undefined ? [] : [{ slot, garment }];
    }),
    accessories: outfit.accessories,
    rationale: outfit.proposal.rationale,
    cited: outfit.cited.map(ruleView),
    missed: outfit.missed.map(ruleView),
    warmthCore: outfit.warmthCore,
    warmthWithOuter: outfit.warmthWithOuter,
  };
}

function check(
  raw: RawProposal,
  menu: Menu,
  constraints: Constraints,
  bodyType: BodyType,
): OutfitView | string {
  const say = (reasons: readonly RejectionReason[]): string =>
    reasons.map((reason) => reasonText(reason, constraints)).join(', and ');

  const resolved = resolveOutfit(toProposal(raw), menu);
  if (Array.isArray(resolved)) return say(resolved);

  const certified = certify(resolved, constraints, bodyType);
  if (Array.isArray(certified)) return say(certified);

  return toView(certified);
}

async function propose(
  client: Anthropic,
  system: string,
  message: string,
): Promise<readonly RawProposal[]> {
  const response = await client.messages.parse({
    model: COMPOSE_MODEL,
    max_tokens: 16000,
    output_config: { format: zodOutputFormat(CompositionSchema), effort: 'high' },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: message }],
  });

  return response.parsed_output?.outfits ?? [];
}

export async function compose(env: Env, input: ComposeInput): Promise<ComposeResult> {
  const { constraints, menu, profile } = input;
  const outfits: OutfitView[] = [];
  const rejected: string[] = [];

  // A required slot with nothing in it makes every possible outfit unresolvable,
  // so the two calls would burn on a guaranteed empty answer.
  if (menu.starved.length > 0) {
    return {
      outfits,
      rejected: [
        `nothing in this wardrobe can fill ${menu.starved.join(' or ')} today, so no complete outfit exists`,
      ],
    };
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const system = systemPrompt(profile);
  const opening = userMessage(input);

  let failures: readonly string[] = [];
  for (let call = 1; call <= MAX_CALLS; call += 1) {
    const message = call === 1 ? opening : `${opening}\n\n${resampleNote(failures)}`;
    const proposals = await propose(client, system, message);

    const round: string[] = [];
    if (proposals.length === 0) round.push('the composer sent back nothing in the shape asked for');
    proposals.forEach((raw, index) => {
      const verdict = check(raw, menu, constraints, profile.bodyType);
      if (typeof verdict === 'string') round.push(`outfit ${index + 1}: ${verdict}`);
      else outfits.push(verdict);
    });

    rejected.push(...round);
    failures = round;
    if (outfits.length >= ENOUGH_OUTFITS) break;
  }

  return { outfits: outfits.slice(0, OUTFITS_ASKED_FOR), rejected };
}
