/**
 * The seven tools the connector exposes, and their descriptions.
 *
 * The descriptions are the interface. Almost nothing else reaches the model: the
 * one other channel is `INSTRUCTIONS` in `server.ts`, which is handed over once
 * at initialize and decides whether a tool is reached for at all. A tool added
 * here and left out of there is a tool the model may never look for. Everything
 * past that first look is these descriptions, so a fact left out of one, or out
 * of a result, is a fact the composer does not have.
 *
 * Every renderer here is borrowed from `compose.ts`, which already writes the
 * menu, the constraints, the body and the book rules for the model that used to
 * do this work behind an API key. A second renderer would be a second thing to
 * keep true.
 */

import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { certify, resolveOutfit } from '../../domain/certify';
import { RULES_BY_ID, rulesFor } from '../../domain/bookRules';
import type {
  BookRule,
  CertifiedOutfit,
  HeldBack,
  MenuChoices,
  OutfitProposal,
  RefusedRequest,
  RejectionReason,
  Slot,
  Waived,
} from '../../domain/types';
import {
  LANGUAGE_NAMES,
  bodyText,
  calibrationAnchors,
  reasonText,
  ruleLine,
  userMessage,
  waivedText,
} from '../compose';
import type { Env } from '../env';
import type {
  Correction,
  HonoredRequest,
  NewOwnerRequest,
  OutfitPiece,
  OwnerRequest,
  SavedOutfit,
  Waiver,
} from '../outfits';
import { MAX_OUTFITS, homeLocation, insertOutfit, readOutfits, recentCorrections } from '../outfits';
import { ImagesUnusableError, smallImageFor } from '../photos';
import type { SmallImage } from '../vision';
import { getProfile } from '../profile';
import {
  GarmentPatchSchema,
  describeGarment,
  getGarment,
  isUntagged,
  listGarments,
} from '../repo';
import type { StoredGarment } from '../repo';
import { recordWear } from '../routes/wear';
import { VOCABULARIES } from '../vision';
import { EVENTS, TIMES_OF_DAY, buildPlan, planFailed, readPlan, savePlan } from './plan';
import type { Plan, PlanRequest } from './plan';

export interface ToolContext {
  readonly env: Env;
  /** Scopes the KV plan keys. One grant can never read another grant's plan. */
  readonly userId: string;
  /** Where the link handed back by `save_outfit` points. */
  readonly origin: string;
  readonly now: () => Date;
}

export interface ToolSpec {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  /** Parses the arguments the way the transport does, then runs the tool. */
  readonly call: (args: unknown) => Promise<CallToolResult>;
  readonly register: (server: McpServer) => void;
}

function defineTool<Shape extends z.ZodRawShape>(
  spec: {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly inputSchema: z.ZodObject<Shape>;
  },
  run: (args: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
): ToolSpec {
  const config = {
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
  };
  return {
    ...spec,
    call: async (args) => {
      const parsed = spec.inputSchema.safeParse(args);
      if (!parsed.success) {
        return said(
          true,
          `${spec.name} was called with arguments it cannot read.`,
          ...parsed.error.issues.map((issue) => `- ${issue.path.join('.')}: ${issue.message}`),
        );
      }
      return run(parsed.data);
    },
    register: (server) => {
      server.registerTool(spec.name, config, (args) => run(args));
    },
  };
}

function said(isError: boolean, ...lines: readonly string[]): CallToolResult {
  return { content: [{ type: 'text', text: lines.join('\n') }], isError };
}

const ok = (...lines: readonly string[]): CallToolResult => said(false, ...lines);
const failed = (...lines: readonly string[]): CallToolResult => said(true, ...lines);

const words = (vocabulary: { readonly values: readonly string[] }): string =>
  vocabulary.values.join(', ');

// ---------------------------------------------------------------------------
// wardrobe_status
// ---------------------------------------------------------------------------

const SLOT_ORDER: readonly Slot[] = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes', 'accessory'];

const STATUS_DESCRIPTION = `Orientation for one person's wardrobe. Call it first: it takes no arguments, it is cheap, and it tells you whether the other six tools can do anything yet.

It answers five questions.
  - How many garments are stored, and how they split across the slots an outfit is built from.
  - How many are still untagged. An untagged garment is a photo nobody has described yet, so it cannot appear in any outfit. next_untagged works through them.
  - How many you have described that the owner has not confirmed yet. They are usable already, and the owner clears them on the Review screen.
  - Whether a body profile exists and which of the four body types it holds. Every styling rule this app knows is written against a body type, so plan_outfit cannot run without one.
  - Whether a home location is stored, which is what lets plan_outfit look up the weather by itself instead of being handed it.`;

function statusTool(context: ToolContext): ToolSpec {
  return defineTool(
    {
      name: 'wardrobe_status',
      title: 'Wardrobe status',
      description: STATUS_DESCRIPTION,
      inputSchema: z.object({}),
    },
    async () => {
      const [stored, profile, home] = await Promise.all([
        listGarments(context.env.DB, {}),
        getProfile(context.env.DB),
        homeLocation(context.env.DB),
      ]);

      const untagged = stored.filter(isUntagged).length;
      const unconfirmed = stored.filter((row) => !row.reviewed && !isUntagged(row)).length;
      const counts = SLOT_ORDER.map(
        (slot) => `${slot} ${stored.filter((row) => row.garment.slot === slot).length}`,
      ).join(' | ');

      const lines = [
        stored.length === 0
          ? 'Wardrobe: empty. Photos are added from the web app, not from here.'
          : `Wardrobe: ${stored.length} garments.\n  ${counts}`,
        untagged === 0
          ? 'Untagged: none. Every garment has been described.'
          : `Untagged: ${untagged}. Call next_untagged to look at the first one.`,
        unconfirmed === 0
          ? 'Waiting for the owner: none.'
          : `Waiting for the owner: ${unconfirmed}. Described, and the owner has not confirmed them on the Review screen yet. They are already usable in an outfit, so this is theirs to clear, not yours.`,
        profile === null
          ? 'Body profile: not set. The owner answers five mirror questions on the Profile screen of the web app. plan_outfit refuses to run until then, because a body type is what every rule keys on.'
          : `Body profile: set. Body type ${profile.bodyType}. Rationales are written in ${LANGUAGE_NAMES[profile.language]}.`,
        home === null
          ? 'Home location: not set, so plan_outfit needs the weather passed to it.'
          : 'Home location: set, so plan_outfit reads the weather by itself.',
      ];
      return ok(...lines);
    },
  );
}

// ---------------------------------------------------------------------------
// next_untagged
// ---------------------------------------------------------------------------

const NEXT_DESCRIPTION = `Hands you the photo of one garment nobody has described yet, so you can look at it and say what it is. This is how the wardrobe gets catalogued: the app stores photos, you supply the words.

Takes no arguments. Returns the garment's id, the placeholder fields the app is currently holding for it, and the photo itself as an image.

Look at the photo, then call set_garment_tags with that same id. The loop is: next_untagged, look, set_garment_tags, repeat. The same garment comes back until it is tagged, and set_garment_tags reports how many are left, so you never have to ask whether to keep going.

When nothing is left it says so and returns no image.`;

/** The stored row in the exact shape `set_garment_tags` takes back. */
function currentTags(stored: StoredGarment): Record<string, unknown> {
  const { id, imageOriginal, imageCutout, ...tags } = stored.garment;
  return { ...tags, uncertain: stored.uncertain };
}

function nextUntaggedTool(context: ToolContext): ToolSpec {
  return defineTool(
    {
      name: 'next_untagged',
      title: 'Next untagged garment',
      description: NEXT_DESCRIPTION,
      inputSchema: z.object({}),
    },
    async () => {
      const waiting = (await listGarments(context.env.DB, {})).filter(isUntagged);
      // Oldest first, so the queue drains in the order the photos arrived.
      const stored = waiting[waiting.length - 1];
      if (stored === undefined) {
        return ok(
          'Nothing is untagged. Every garment in this wardrobe has been described, so there is no photo to look at.',
        );
      }

      const key = stored.garment.imageCutout ?? stored.garment.imageOriginal;
      let image: SmallImage;
      try {
        image = await smallImageFor(context.env, key);
      } catch (error) {
        if (error instanceof ImagesUnusableError) return failed(error.fault.error);
        console.error('reading a garment photo failed', { id: stored.garment.id, error });
        return failed(
          `The photo stored for garment ${stored.garment.id} could not be read, so there is nothing to look at. Skip this one and tell the owner.`,
        );
      }

      return {
        isError: false,
        content: [
          {
            type: 'text',
            text: [
              `${waiting.length} garment${waiting.length === 1 ? '' : 's'} still untagged. This is one of them.`,
              '',
              `id: ${stored.garment.id}`,
              '',
              'What the app holds for it now, in the shape set_garment_tags takes. These are placeholders written when the photo was stored, not observations, so treat none of them as evidence:',
              JSON.stringify(currentTags(stored), null, 2),
              '',
              'Look at the photo below and call set_garment_tags with this id.',
            ].join('\n'),
          },
          { type: 'image', data: image.base64, mimeType: image.mediaType },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// set_garment_tags
// ---------------------------------------------------------------------------

const TAGS_DESCRIPTION = `Writes what you saw in a garment's photo into the app's catalog. Call it for an id next_untagged handed you, or for a garment the owner asked you to correct.

Every field is optional and only the ones you send are written, but a garment being described for the first time needs all of them. Writing anything clears the placeholder flags, so the garment stops coming back from next_untagged whether you filled it in or not.

What you write is not the last word. It goes in as yours, the garment becomes usable in an outfit straight away, and it waits on the Review screen of the web app for the owner to confirm or correct it. So describe what you actually see and let them settle the calls you were unsure of, rather than leaving a field out.

The fields, and the exact words each one takes. A word of your own costs that field.

  slot            ${words(VOCABULARIES.slot)}
                  base is worn against the skin on the torso (t-shirt, tank, dress shirt, polo). top is a shirt worn over a base. mid is a sweater, hoodie, cardigan, vest or blazer. outer is a coat, parka or heavy jacket. bottom is anything worn on the legs. shoes is anything worn on the feet. accessory is anything worn that is not clothing and not shoes: jewelry, eyewear, a hat, a scarf, a belt, a watch, a bag. A shirt that could be base or top is base.
  subtype         two or three lowercase words a person would say out loud: "oxford shirt", "white sneakers". No brand names.
  colors          one to three plain color words, the largest area of the garment first.
  colorRole       ${words(VOCABULARIES.colorRole)}. neutral for black, white, gray, navy, beige, brown, olive and denim blue. accent for anything that would be the loudest piece in an outfit.
  pattern         ${words(VOCABULARIES.pattern)}
  fabric          ${words(VOCABULARIES.fabric)}, or null when the photo does not say. Never infer a fiber from color alone.
  warmth          a whole number 0 to 5, see the scale below
  formality       a whole number 1 to 5, see the scale below
  fit             ${words(VOCABULARIES.fit)}. Read the width of the panels and the shape of the cut.
  structured      true when the garment holds its own shape instead of draping: blazer, denim jacket, stiff oxford. false for jersey and knitwear.
  shoulderBulk    true only when the shoulders are padded or built up. The book's rules for one body type ban these outright.
  waterResistant  true only when the surface is plainly made to shed water: rain shell, waxed jacket, rubber boots. Not wool, not denim.
  seasons         any of ${words(VOCABULARIES.seasons)}. Most pieces suit two or three. An empty list keeps the garment out of every outfit, so do not send one out of caution.
  rise            ${words(VOCABULARIES.rise)}. Bottoms only, null on everything else.
  leg             ${words(VOCABULARIES.leg)}. Judge the line from the knee to the hem. Bottoms only, null on everything else.
  neckline        ${words(VOCABULARIES.neckline)}. open means a collar or buttons worn open, high means a mock neck or turtleneck. Torso layers only, null on everything else.
  sleeves         ${words(VOCABULARIES.sleeves)}. Torso layers only, null on everything else.
  hem             ${words(VOCABULARIES.hem)}, where the bottom edge falls on the torso. Torso layers only, null on everything else.
  accessoryKind   ${words(VOCABULARIES.accessoryKind)}. What the piece is, in one word the app can act on. Accessories only, null on everything else, and never null on an accessory. Pick other over a word that is close but wrong.
  notes           one short line, only when something matters that no other field carries: visible damage, a large logo, a cropped length. null otherwise.
  uncertain       the field names you were not confident about, spelled as they are spelled here. The owner reviews every flagged field by hand, so doubt costs nothing and a confident wrong guess costs a lot.

ACCESSORIES, where two of those fields do not mean what they mean on clothes.
  seasons    jewelry, eyewear, a watch and a belt are worn all year, so send all four seasons for them. A season left off keeps the piece out of every outfit for that quarter of the year, and nothing tells the owner why it went missing. A wool hat and a wool scarf are genuinely seasonal, so say so.
  formality  on an accessory this is a note and not a filter. It no longer keeps a piece out of a menu, so read it as how dressy the piece is and leave the floor to the clothes.

${calibrationAnchors()}

Returns how many garments are still untagged.`;

const SetTagsArgs = z.object({
  id: z
    .string()
    .min(1)
    .describe('The garment id, exactly as next_untagged gave it. Never a name you made up.'),
  tags: GarmentPatchSchema.describe(
    'The fields to write. Send every field you can read off the photo.',
  ),
});

function setTagsTool(context: ToolContext): ToolSpec {
  return defineTool(
    {
      name: 'set_garment_tags',
      title: 'Set garment tags',
      description: TAGS_DESCRIPTION,
      inputSchema: SetTagsArgs,
    },
    async (args) => {
      if (Object.keys(args.tags).length === 0) {
        return failed(
          'No fields were sent, and writing nothing would still clear the placeholders and hide the garment from next_untagged. Send the fields you read off the photo.',
        );
      }

      const updated = await describeGarment(context.env.DB, args.id, args.tags);
      if (updated === null) {
        return failed(
          `No garment with id ${args.id} in this wardrobe. Call next_untagged and use the id it returns.`,
        );
      }

      const left = (await listGarments(context.env.DB, {})).filter(isUntagged).length;
      return ok(
        `Tagged ${updated.garment.id} as "${updated.garment.subtype}".`,
        left === 0
          ? 'Nothing is left untagged. The owner confirms these on the Review screen of the web app, and every one of them is usable in an outfit meanwhile.'
          : `${left} garment${left === 1 ? '' : 's'} still untagged. Call next_untagged for the next one.`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// plan_outfit
// ---------------------------------------------------------------------------

const PLAN_DESCRIPTION = `Does every part of choosing an outfit that a computer can do, and hands you the rest. Call it once, compose one outfit from what comes back, then call save_outfit.

What it returns:
  - a planId. save_outfit only accepts garments from the plan that minted it, so keep it. A plan lives for one hour.
  - the body: which of the four types the owner's styling book classifies them as, and the five mirror observations behind it.
  - the book's rules for that body type and no other, each one an id, the part of the outfit it is judged over, and the book's own reason. A rule written for another body type does not exist here, and citing one is rejected.
  - what the outfit has to satisfy: two warmth bands as numbers with what each one means, the formality floor, the season, and whether rain counts today.
  - the menu, grouped by slot. This is every garment you may name and nothing else. Formality, season, rain and the book's outright donts have already been applied to it, so anything in the menu is safe on those counts and you never have to check them. The one exception says so on its own line: a garment the owner asked for is marked as theirs and names what it failed. A garment id that is not in the menu throws away the whole outfit it appears in.
  - any required slot the wardrobe cannot fill today, in which case no outfit exists and you should say so rather than compose one.
  - what the owner has corrected by hand on outfits you saved before, and the line they wrote about each change. Read it before you compose: repeating a swap they already made is the mistake that section exists to prevent.
  - what today's filters held back, with the id of each garment and what held it. These are not in the menu and naming one fails the save. They are listed for one reason, below.

When the owner names a garment by an outfit rather than by its name, "the same jacket as last Friday", read that outfit with past_outfits first. It gives you the id, which is the only thing that lets you look the garment up here.

The owner's own request is the one thing that overrides a filter. If they ask for a specific garment and it is in the held back list, call plan_outfit a second time with ownerAsked filled in. That garment then enters the menu marked as theirs, with the filters it failed named on its line, and every other garment stays filtered exactly as before. Season, the formality floor, rain and the recency cooldown are the four that a request waives. The guide's donts are not: they are about this person's body rather than about today, and save_outfit rejects an outfit that breaks one whatever the menu says. Warmth is not waived either, so the two warmth bands still hold.

Weather: pass it when you know it. Leave it out and the app reads it from the owner's stored home location, and tells you plainly when no location is stored.`;

const PlanArgs = z.object({
  event: z
    .enum(EVENTS)
    .describe(
      'Where the day is going. This sets the formality floor: home, errands and active have none, work, social and dinner ask for smart casual and up, formal asks for dressy and up.',
    ),
  timeOfDay: z.enum(TIMES_OF_DAY).describe('When the outfit is worn.'),
  hoursOutdoors: z
    .number()
    .min(0)
    .max(24)
    .describe(
      'How many hours of the day are actually spent outside. It decides how much of the warmth the coat is allowed to carry: a desk day can sit in a light shirt under a warm coat, a day spent outdoors needs the warmth in the layers themselves. It also decides whether rain is worth dressing for.',
    ),
  mood: z
    .string()
    .optional()
    .describe(
      'Anything the owner said about how they want to look or feel today, in their own words. Free text, read by you and by nothing else.',
    ),
  ownerAsked: z
    .object({
      garmentIds: z
        .array(z.string().min(1))
        .min(1)
        .describe(
          'The ids of the garments they named. Take them from the held back list of an earlier plan, from a menu, or from an outfit past_outfits read back. One request covers one outfit and expires with the plan.',
        ),
      words: z
        .string()
        .min(1)
        .describe(
          'What the owner said, in their own words, as close to verbatim as you have them. It is stored on the outfit and shown to them next to the filters it turned off, so a sentence they did not say is a sentence they will read back.',
        ),
    })
    .optional()
    .describe(
      'Fill this in only when the owner asked for a specific garment. It is the one thing in this app that turns a filter off, so it is theirs alone: never set it because the outfit would look better, because the menu is thin, or because you want a garment you saw earlier. A mood is not a request. "Something warm" is not a request. "I want to wear the mustard sweater" is.',
    ),
  weather: z
    .object({
      tempC: z.number().describe('Air temperature in Celsius.'),
      feelsLikeC: z
        .number()
        .optional()
        .describe('Apparent temperature in Celsius. Falls back to tempC. This is the number the warmth bands are read from, so send it when you have it.'),
      precipProbability: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe('Chance of rain as a fraction from 0 to 1, not a percentage. Defaults to 0.'),
      windKph: z.number().min(0).optional().describe('Wind speed in km/h. Defaults to 0.'),
    })
    .optional()
    .describe(
      "Today's weather, when you already have it. Leave the whole object out to have the app look it up from the stored home location.",
    ),
});

/** Enough to read as a pattern, short enough that the newest one is never buried. */
const CORRECTIONS_SHOWN = 15;

function correctionLine(correction: Correction): string {
  const day = correction.at.slice(0, 10);
  const when = correction.event === null ? day : `${day}, ${correction.event}`;

  // A garment archived since has no name left to give, so the slot stands alone.
  const picked =
    correction.from.subtype === null
      ? `you picked something for ${correction.slot} that is gone from the wardrobe`
      : `you picked the ${correction.from.subtype} for ${correction.slot}`;

  // Never "they wore": a correction is only possible before the outfit is
  // logged as worn, so what this records is the change and not the day.
  let changed = 'they took it out and left the slot empty';
  if (correction.to !== null) {
    changed =
      correction.to.subtype === null
        ? 'they changed it to a garment that is gone from the wardrobe'
        : `they changed it to the ${correction.to.subtype}`;
  }

  return `- ${when}: ${picked}, ${changed}. "${correction.reason}"`;
}

/**
 * The one thing in this app that carries an opinion the guide does not have. It
 * says what these words are not before it says what they are, because a note
 * from the owner read as an instruction would have the composer explaining the
 * app to them instead of dressing them.
 */
function correctionsSection(corrections: readonly Correction[]): string {
  return [
    'WHAT THE OWNER CORRECTED',
    'After you saved an outfit, the owner sometimes changed one piece of it in the app and said why. Their newest corrections, in their own words. These are preferences to weigh, the way you weigh their mood. They are not from the guide, nothing filtered the menu on them, and a correction made on a rainy day may not apply today.',
    '',
    ...corrections.map(correctionLine),
  ].join('\n');
}

/**
 * Long enough that the garment the owner has in mind is almost always on it,
 * short enough that it never crowds out the menu it sits under.
 */
const HELD_BACK_SHOWN = 40;

function heldBackLine(held: HeldBack): string {
  const garment = held.garment;
  const parts = [garment.id, garment.subtype];
  if (garment.colors.length > 0) parts.push(garment.colors.join(' and '));
  parts.push(garment.slot);
  parts.push(
    held.bookDonts.length > 0
      ? `the guide's ${held.bookDonts.join(' and ')}, which a request cannot override`
      : waivedText(held.why),
  );
  return `  ${parts.join(' | ')}`;
}

/**
 * The menu's shadow, and the only place a garment outside the menu has a visible
 * id. It says what it is not before it says what it is, because a list of ids
 * next to a menu of ids is the easiest thing in this whole result to misread.
 */
function heldBackSection(heldBack: readonly HeldBack[]): string {
  const shown = heldBack.slice(0, HELD_BACK_SHOWN);
  const rest = heldBack.length - shown.length;
  return [
    'HELD BACK BY TODAY, AND NOT IN THE MENU',
    'Garments this person owns that today filtered out. None of these is in the menu, so naming one in save_outfit throws away the whole outfit exactly as an invented id would. They are listed so that when the owner asks for one by name you can find its id and say which it is.',
    'To use one, call plan_outfit again with ownerAsked. Only when they asked.',
    '',
    ...shown.map(heldBackLine),
    ...(rest > 0 ? ['', `and ${rest} more that today also held back.`] : []),
  ].join('\n');
}

function refusedLine(refused: RefusedRequest): string {
  if (refused.kind === 'not_in_wardrobe') {
    return `  ${refused.id}: no garment in this wardrobe has that id, so nothing was admitted for it.`;
  }
  const rule = RULES_BY_ID.get(refused.ruleId);
  const because = rule === undefined ? '' : ` The guide says: ${rule.because}`;
  return `  ${refused.subtype} (${refused.id}): not admitted. It breaks the guide's ${refused.ruleId}, and a request does not override the guide.${because}`;
}

/**
 * What the request actually did, garment by garment. A request that changed
 * nothing and a request that was refused both have to be visible: the whole
 * point of this feature is that the owner gets what they asked for or is told
 * plainly why not, and a silent drop is the one outcome that breaks it.
 */
function ownerAskedSection(plan: Plan): string {
  const asked = plan.ownerAsked;
  if (asked === null) return '';

  const admitted = SLOT_ORDER.flatMap((slot) => plan.menu.bySlot[slot]).filter(
    (entry) => asked.garmentIds.includes(entry.garment.id),
  );

  const lines = admitted.map((entry) => {
    const waived = entry.admittedBy.by === 'owner_asked' ? entry.admittedBy.waived : [];
    return waived.length === 0
      ? `  ${entry.garment.subtype} (${entry.garment.id}): in the ${entry.garment.slot} menu. It passed today's filters anyway, so the request turned nothing off and there is nothing to disagree with.`
      : `  ${entry.garment.subtype} (${entry.garment.id}): in the ${entry.garment.slot} menu, and there only because they asked. It is ${waivedText(waived)}.`;
  });

  return [
    'WHAT THE OWNER ASKED FOR',
    `They said: "${asked.words}"`,
    '',
    ...lines,
    ...plan.menu.refused.map(refusedLine),
    '',
    'Compose with what they asked for. Where a line above says a filter was turned off, write the second opinion into save_outfit\'s `disagreement` field: what you would have chosen instead and why, in their language, in a sentence or two. They get what they want and your read of it, kept apart from the rationale. It is not a refusal and not a lecture. Where nothing was turned off, leave that field out.',
  ].join('\n');
}

function planTool(context: ToolContext): ToolSpec {
  return defineTool(
    {
      name: 'plan_outfit',
      title: 'Plan an outfit',
      description: PLAN_DESCRIPTION,
      inputSchema: PlanArgs,
    },
    async (args) => {
      const request: PlanRequest = args;
      const plan = await buildPlan(context.env, request, context.now());
      if (planFailed(plan)) return failed(plan.problem);

      const { profile, constraints, menu, moment } = plan;
      const planId = await savePlan(context.env, context.userId, {
        menu,
        constraints,
        bodyType: profile.bodyType,
        event: moment.event,
        ownerAsked: plan.ownerAsked,
      });

      const sections = [
        `PLAN ${planId}\nsave_outfit takes this id and accepts garments only from the menu below. It expires in one hour.`,
      ];

      if (menu.starved.length > 0) {
        sections.push(
          `NO COMPLETE OUTFIT EXISTS TODAY\nNothing this person owns can fill ${menu.starved.join(' or ')} under today's constraints, and those slots are required. Do not compose: save_outfit would reject anything you sent. Tell them which slot is empty, and that the formality floor and the season are the two filters that empty one.`,
        );
      }

      const corrections = await recentCorrections(context.env.DB, CORRECTIONS_SHOWN);

      sections.push(
        `THE BODY\n${bodyText(profile)}`,
        `THE GUIDE\nThese are the guide's rules for this body, and the only rules that exist. Each line is an id, what the rule is judged over, and then the guide's own reason for it. Cite an id only when this outfit actually follows that rule.\n\n${rulesFor(profile.bodyType).map(ruleLine).join('\n')}`,
        calibrationAnchors(),
        userMessage({ profile, constraints, menu, moment }),
      );

      if (corrections.length > 0) sections.push(correctionsSection(corrections));
      if (menu.heldBack.length > 0) sections.push(heldBackSection(menu.heldBack));
      if (plan.ownerAsked !== null) sections.push(ownerAskedSection(plan));

      sections.push(
        `WHAT TO DO NEXT\nCompose one outfit. Fill base, bottom and shoes, and add top, mid, outer and accessories when the day calls for them. Write the rationale to the wearer in ${LANGUAGE_NAMES[profile.language]}, two or three sentences saying what the outfit is doing for them today. Then call save_outfit with this planId.\n\nYour own styling taste is wanted and is the reason you are here. It is not the guide. A sentence only speaks for the guide when you cite the id of the rule it came from, so write everything else as your own read.`,
      );

      return ok(sections.join('\n\n'));
    },
  );
}

// ---------------------------------------------------------------------------
// save_outfit
// ---------------------------------------------------------------------------

const SAVE_DESCRIPTION = `Checks an outfit you composed against the plan it came from, and stores it when it passes. The owner's app then shows it with the real photos.

Every garment id has to come from the menu of the plan named by planId. Not from memory, not from an earlier plan, and not from a list you rebuilt: the wardrobe and the recency cooldowns move between calls, so a rebuilt menu is a different menu. An unknown or expired planId fails and tells you to call plan_outfit again.

What is checked here and nowhere else:
  - the warmth sums, against both bands the plan gave you
  - the book's donts that need the pieces seen together, which no menu filter could catch
  - every rule id you cite. A cited rule has to exist, apply to this body type, and actually hold for these clothes. Citing a rule the outfit breaks fails the whole save.
  - the accessories a body has one place for. At most one of glasses, hat, scarf, belt, bag, watch and earrings each. A ring, a chain and a bracelet may repeat as often as you like.

On failure nothing is stored and every reason comes back, naming the garment or the rule. Compose again straight away if you like, but write a new rationale for the new clothes: a rationale carried over from a rejected outfit describes something the owner is not wearing.

If the plan carried an ownerAsked request, this is where the second opinion on it goes. Write it into the disagreement field. The owner is shown what they asked for and which filters it turned off whether or not you write one, so an empty field is their request standing on its own.

On success you get the saved outfit's id and a link to it in the web app.`;

const SaveArgs = z.object({
  planId: z.string().min(1).describe('The planId plan_outfit returned. Nothing else is accepted.'),
  pieces: z
    .object({
      base: z
        .string()
        .min(1)
        .describe('Garment id from the base menu. The torso layer worn against the skin. Required.'),
      bottom: z.string().min(1).describe('Garment id from the bottom menu. Required.'),
      shoes: z.string().min(1).describe('Garment id from the shoes menu. Required.'),
      top: z
        .string()
        .optional()
        .describe('Garment id from the top menu, a shirt worn over the base. Leave out for no top layer.'),
      mid: z
        .string()
        .optional()
        .describe('Garment id from the mid menu: sweater, cardigan, blazer. Leave out for no mid layer.'),
      outer: z
        .string()
        .optional()
        .describe('Garment id from the outer menu: coat or jacket. Leave out for no outer layer.'),
      accessories: z
        .array(z.string())
        .optional()
        .describe(
          "Garment ids from the accessory menu. A belt is worth checking for, because several of the book's rules ask for one.",
        ),
    })
    .describe("The outfit, one garment id per slot. Every id must be in this plan's menu."),
  rationale: z
    .string()
    .min(1)
    .describe(
      'Two or three sentences written to the person wearing this, saying what the outfit is doing for them today, in the language the plan named. It is stored and shown to them, so write it for them and not for the tool.',
    ),
  citedRules: z
    .array(z.string())
    .describe(
      'Ids of the guide rules from this plan that this outfit actually follows. An empty list is allowed and is better than a rule you cannot defend. Rule ids are ids in every language: never translate one and never invent one.',
    ),
  disagreement: z
    .string()
    .optional()
    .describe(
      'Only for an outfit built on a plan whose ownerAsked turned a filter off. A sentence or two, written to the wearer in the language the plan named, saying what you would have picked instead and why. It is stored beside their own words and shown under a heading of its own, so it never reads as part of the rationale. Leave it out when the plan waived nothing: there is nothing to disagree with.',
    ),
});

function proposalFrom(args: z.infer<typeof SaveArgs>): OutfitProposal {
  const layers: { top?: string; mid?: string; outer?: string } = {};
  if (args.pieces.top !== undefined) layers.top = args.pieces.top;
  if (args.pieces.mid !== undefined) layers.mid = args.pieces.mid;
  if (args.pieces.outer !== undefined) layers.outer = args.pieces.outer;

  return {
    base: args.pieces.base,
    bottom: args.pieces.bottom,
    shoes: args.pieces.shoes,
    ...layers,
    accessories: args.pieces.accessories ?? [],
    rationale: args.rationale,
    citedRules: args.citedRules,
  };
}

const WORN_ORDER: readonly Slot[] = ['base', 'top', 'mid', 'outer', 'bottom', 'shoes'];

function piecesOf(outfit: CertifiedOutfit): readonly OutfitPiece[] {
  const worn = WORN_ORDER.flatMap((slot): OutfitPiece[] => {
    const garment = outfit.pieces[slot];
    return garment === undefined ? [] : [{ slot, id: garment.id }];
  });
  const accessories = outfit.accessories.map(
    (garment): OutfitPiece => ({ slot: 'accessory', id: garment.id }),
  );
  return [...worn, ...accessories];
}

const ruleIds = (rules: readonly BookRule[]): readonly string[] => rules.map((rule) => rule.id);

/**
 * What the request actually bought, read off the menu rather than off the
 * arguments. The composer says which garments it used and the plan says what
 * admitting each one turned off, so neither side can write the other's half.
 *
 * Only the requested garments that are really in the outfit are recorded. A
 * request the composer ignored is not something to show the owner as honored.
 */
function honoredIn(
  menu: MenuChoices,
  askedFor: readonly string[],
  pieces: readonly OutfitPiece[],
): readonly Waiver[] {
  return pieces.flatMap((piece): Waiver[] => {
    if (!askedFor.includes(piece.id)) return [];
    const admission = menu.bySlot[piece.slot].find(
      (entry) => entry.garment.id === piece.id,
    )?.admittedBy;
    const waived: readonly Waived[] =
      admission !== undefined && admission.by === 'owner_asked' ? admission.waived : [];
    return [{ id: piece.id, waived }];
  });
}

/**
 * Said back rather than checked, because the second opinion is the owner's to
 * want and not this server's to require. What it does do is make the silence
 * audible: a waived filter with nothing written next to it is a thing the owner
 * reads alone.
 */
function requestLine(request: NewOwnerRequest): string {
  const waived = request.honored.filter((one) => one.waived.length > 0);
  if (waived.length === 0) {
    return 'It records what the owner asked for. Every piece they named fit the day anyway, so no filter was turned off.';
  }
  const turned = `It records what the owner asked for, and the ${waived.length === 1 ? 'filter' : 'filters'} that turned off for ${waived.map((one) => one.id).join(', ')}.`;
  return request.disagreement === null
    ? `${turned} No second opinion was written, so they see the waiver with nothing from you beside it.`
    : `${turned} Your second opinion is stored beside it.`;
}

function saveTool(context: ToolContext): ToolSpec {
  return defineTool(
    {
      name: 'save_outfit',
      title: 'Save an outfit',
      description: SAVE_DESCRIPTION,
      inputSchema: SaveArgs,
    },
    async (args) => {
      const plan = await readPlan(context.env, context.userId, args.planId);
      if (plan === null) {
        return failed(
          `No plan with id ${args.planId}. A plan lives for one hour and belongs to this connection only, so this one has expired or was never made here.`,
          'Call plan_outfit and use the planId it returns. Do not retry this call with the same id.',
        );
      }

      const rejected = (reasons: readonly RejectionReason[]): CallToolResult =>
        failed(
          'Rejected. Nothing was stored.',
          ...reasons.map((reason) => `- ${reasonText(reason, plan.constraints)}`),
          '',
          `Compose again from the menu in plan ${args.planId} and write a new rationale for the new pieces. A rationale carried over from a rejected outfit describes clothes nobody is wearing.`,
        );

      const resolved = resolveOutfit(proposalFrom(args), plan.menu);
      if (Array.isArray(resolved)) return rejected(resolved);

      const certified = certify(resolved, plan.constraints, plan.bodyType);
      if (Array.isArray(certified)) return rejected(certified);

      const pieces = piecesOf(certified);
      const asked = plan.ownerAsked;
      const honored = asked === null ? [] : honoredIn(plan.menu, asked.garmentIds, pieces);
      // Said out loud rather than stored. A request the outfit does not wear is
      // not something to show the owner as honored, but it is something the
      // composer should notice it dropped.
      const ignored =
        asked === null
          ? []
          : asked.garmentIds.filter((id) => !pieces.some((piece) => piece.id === id));
      const disagreement = args.disagreement?.trim();
      const ownerRequest: NewOwnerRequest | null =
        asked === null || honored.length === 0
          ? null
          : {
              words: asked.words,
              disagreement: disagreement === undefined || disagreement === '' ? null : disagreement,
              honored,
            };

      const id = await insertOutfit(
        context.env.DB,
        {
          planId: args.planId,
          event: plan.event,
          pieces,
          rationale: args.rationale,
          citedRules: ruleIds(certified.cited),
          missedRules: ruleIds(certified.missed),
          warmthCore: certified.warmthCore,
          warmthWithOuter: certified.warmthWithOuter,
          ownerRequest,
        },
        context.now(),
      );

      return ok(
        'Saved. The app will show this outfit with the real photos.',
        `id: ${id}`,
        `link: ${context.origin}/#/today`,
        `warmth ${certified.warmthCore} at the core, ${certified.warmthWithOuter} with the outer layer.`,
        certified.cited.length === 0
          ? 'It cites no guide rules.'
          : `Guide rules it follows: ${ruleIds(certified.cited).join(', ')}.`,
        certified.missed.length === 0
          ? 'It misses none of the guide preferences for this body.'
          : `Guide preferences it knowingly misses, which the owner is shown rather than spared: ${ruleIds(certified.missed).join(', ')}.`,
        ...(ownerRequest === null ? [] : [requestLine(ownerRequest)]),
        ...(ignored.length === 0
          ? []
          : [
              `The owner asked for ${ignored.join(', ')} and this outfit does not wear ${ignored.length === 1 ? 'it' : 'them'}. Nothing about that is stored, so they are shown no record of having asked.`,
            ]),
        `Call log_wear with these ids once it is actually worn: ${pieces.map((piece) => piece.id).join(', ')}.`,
      );
    },
  );
}

// ---------------------------------------------------------------------------
// past_outfits
// ---------------------------------------------------------------------------

const PAST_DESCRIPTION = `Reads outfits you saved before, so the owner can talk about one instead of starting over. "The last three", "what I wore on Friday", "the one with the brown boots", a variation on any of them.

Selection is by count or by date, and it does both at once: three by default, newest first, and a from and a to date narrow it to a range. One day is from and to set to the same date.

Dates are UTC and spelled YYYY-MM-DD. The result states today's UTC date before anything else, because you cannot know it and every relative date the owner says is measured from it. Work out "last Friday" yourself and pass the day. This tool does no date parsing and would rather be given a wrong date it can echo back than guess at a right one.

What comes back for each outfit: the day, the event, every garment as slot, id and name, the rationale, the guide rules it cited and missed, both warmth sums, whether it was logged as worn, anything the owner corrected by hand with the line they wrote, and anything they asked for by name with the filters that waived.

Reading one of these does not make its garments wearable today. The ids are wardrobe ids, and every plan builds its menu from today's weather, today's event and today's cooldowns, so a garment from an old outfit may be out of season now, too casual for today, or still resting. Look for it in today's menu first. If the owner asks for it and it is not there, that is what plan_outfit's ownerAsked is for.`;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const dayArg = (what: string) =>
  z
    .string()
    .regex(DAY_PATTERN, 'A day is spelled YYYY-MM-DD.')
    .optional()
    .describe(what);

const PastArgs = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_OUTFITS)
    .optional()
    .describe(
      `How many to read, newest first. Three unless you say otherwise, and ${MAX_OUTFITS} at most. The result says how many matched, so a truncated read is never mistaken for the whole of it.`,
    ),
  from: dayArg(
    'The oldest day to read, UTC, YYYY-MM-DD, inclusive. Leave it out to read back from the newest.',
  ),
  to: dayArg(
    'The newest day to read, UTC, YYYY-MM-DD, inclusive. Set it equal to from for one day.',
  ),
});

/** Three is what "the last few" means in a conversation. More is a deliberate ask. */
const PAST_SHOWN = 3;

/** Wide enough for `accessory`, the longest slot there is, plus a space. */
const SLOT_COLUMN = 10;

/**
 * Every garment the outfit was saved with, including the ones since archived.
 * Leaving those out would show an outfit with no bottom, which this app says
 * cannot exist, and a variation composed from that reading would be a variation
 * on clothes the owner never wore.
 */
function pieceLines(outfit: SavedOutfit): readonly string[] {
  const line = (slot: Slot, id: string, name: string) =>
    `    ${slot.padEnd(SLOT_COLUMN)}${id} | ${name}`;
  return [
    ...outfit.pieces.map((piece) => line(piece.slot, piece.garment.id, piece.garment.subtype)),
    ...outfit.accessories.map((garment) => line('accessory', garment.id, garment.subtype)),
    ...outfit.gone.map((piece: OutfitPiece) =>
      line(piece.slot, piece.id, 'gone from the wardrobe since'),
    ),
  ];
}

function honoredText(honored: HonoredRequest): string {
  const name = honored.subtype ?? 'a garment gone from the wardrobe';
  return honored.waived.length === 0
    ? `${name} (${honored.id}), which fit that day anyway`
    : `${name} (${honored.id}), in only because they asked: ${waivedText(honored.waived)}`;
}

function requestLines(request: OwnerRequest | null): readonly string[] {
  if (request === null) return [];
  const lines = [`    they asked: "${request.words}"`, ...request.honored.map((one) => `      ${honoredText(one)}`)];
  if (request.disagreement !== null) lines.push(`    you said back: "${request.disagreement}"`);
  return lines;
}

function correctedLines(corrections: readonly Correction[]): readonly string[] {
  return corrections.map((correction) => {
    const out = correction.from.subtype ?? 'a garment gone from the wardrobe';
    const into = correction.to === null ? 'nothing' : (correction.to.subtype ?? 'a garment gone from the wardrobe');
    return `    they changed ${correction.slot}: ${out} out, ${into} in. "${correction.reason}"`;
  });
}

function outfitBlock(outfit: SavedOutfit): string {
  const day = outfit.createdAt.slice(0, 10);
  const head = [day, outfit.event ?? 'no event recorded', outfit.worn ? 'worn' : 'not logged as worn'];

  return [
    `  ${head.join(' | ')}`,
    ...pieceLines(outfit),
    `    "${outfit.rationale}"`,
    outfit.cited.length === 0
      ? '    cites no guide rules'
      : `    follows ${outfit.cited.map((rule) => rule.id).join(', ')}`,
    outfit.missed.length === 0
      ? '    misses none of the guide preferences for this body'
      : `    misses ${outfit.missed.map((rule) => rule.id).join(', ')}`,
    `    warmth ${outfit.warmthCore} at the core, ${outfit.warmthWithOuter} with the outer layer`,
    ...requestLines(outfit.ownerRequest),
    ...correctedLines(outfit.corrections),
  ].join('\n');
}

function searched(args: z.infer<typeof PastArgs>): string {
  if (args.from !== undefined && args.to !== undefined) {
    return args.from === args.to ? `on ${args.from}` : `between ${args.from} and ${args.to}`;
  }
  if (args.from !== undefined) return `on or after ${args.from}`;
  if (args.to !== undefined) return `on or before ${args.to}`;
  return 'in the whole history';
}

function pastTool(context: ToolContext): ToolSpec {
  return defineTool(
    {
      name: 'past_outfits',
      title: 'Read past outfits',
      description: PAST_DESCRIPTION,
      inputSchema: PastArgs,
    },
    async (args) => {
      const today = context.now().toISOString().slice(0, 10);
      const dated = `TODAY IS ${today}, UTC.\nEvery date below is UTC and so is that one. Measure any day the owner named from it.`;

      // Comparing two strings is not parsing a date, so this stays inside the
      // rule that dates are the model's business. Left alone it would run a
      // range that cannot match and report an empty wardrobe.
      if (args.from !== undefined && args.to !== undefined && args.from > args.to) {
        return failed(
          dated,
          '',
          `from is ${args.from} and to is ${args.to}, so the range runs backwards and nothing could be inside it. Swap them and call again.`,
        );
      }

      const limit = args.limit ?? PAST_SHOWN;
      const page = await readOutfits(context.env.DB, { limit, from: args.from, to: args.to });

      if (page.outfits.length === 0) {
        return ok(
          dated,
          '',
          `No saved outfits ${searched(args)}. Outfits get here through save_outfit, so an outfit that was only talked about is not one this can find.`,
        );
      }

      const more =
        limit < MAX_OUTFITS
          ? `Call again with a higher limit for the rest, up to ${MAX_OUTFITS}.`
          : `${MAX_OUTFITS} is the most one call reads, so narrow it with from and to for the rest.`;
      const counted =
        page.total > page.outfits.length
          ? `${page.outfits.length} of ${page.total} outfits ${searched(args)}, newest first. ${more}`
          : `${page.outfits.length} outfit${page.outfits.length === 1 ? '' : 's'} ${searched(args)}, newest first.`;

      return ok(
        dated,
        '',
        counted,
        '',
        page.outfits.map(outfitBlock).join('\n\n'),
        '',
        "A garment's id is the same string everywhere in this app, so match one of these against today's menu by hand to see whether it is wearable today. Today's menu is the part of the wardrobe that passed today's filters, and it is rebuilt on every plan_outfit call, so a garment worn last week may be out of it now. If it is not there and the owner asked for it, name it in plan_outfit's ownerAsked.",
      );
    },
  );
}

// ---------------------------------------------------------------------------
// log_wear
// ---------------------------------------------------------------------------

const WEAR_DESCRIPTION = `Records that these garments were worn today. One call for one outfit actually put on.

This is the only thing that feeds the recency cooldown, which is what stops the same jacket coming back every morning: a garment that was worn recently drops out of the menu for a few days, longer for a coat than for a t-shirt. An outfit worn but never logged is invisible to every later plan.

Every id has to be a garment this wardrobe knows. An unknown id is refused rather than recorded, because a wrong id would quietly bench a garment nobody wore.`;

const LogWearArgs = z.object({
  garmentIds: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'The ids of every garment worn, including accessories. save_outfit hands back exactly this list for the outfit it saved.',
    ),
});

function logWearTool(context: ToolContext): ToolSpec {
  return defineTool(
    {
      name: 'log_wear',
      title: 'Log what was worn',
      description: WEAR_DESCRIPTION,
      inputSchema: LogWearArgs,
    },
    async (args) => {
      const ids = [...new Set(args.garmentIds.map((id) => id.trim()))];
      const found = await Promise.all(ids.map((id) => getGarment(context.env.DB, id)));
      const unknown = ids.filter((_, index) => found[index] === null);
      if (unknown.length > 0) {
        return failed(
          'Nothing was logged.',
          `These are not garments in this wardrobe: ${unknown.join(', ')}.`,
          "Use the ids from a plan's menu, or the list save_outfit handed back.",
        );
      }

      const logged = await recordWear(context.env.DB, { garmentIds: ids }, context.now());
      return ok(
        `Logged ${ids.length} garment${ids.length === 1 ? '' : 's'} as worn on ${logged.wornOn}.`,
        'They now sit out their cooldown and will not be offered in the next few plans. The wait is longer for a coat than for a t-shirt.',
      );
    },
  );
}

// ---------------------------------------------------------------------------

export function wardrobeTools(context: ToolContext): readonly ToolSpec[] {
  return [
    statusTool(context),
    nextUntaggedTool(context),
    setTagsTool(context),
    planTool(context),
    saveTool(context),
    pastTool(context),
    logWearTool(context),
  ];
}
