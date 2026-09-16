/**
 * One saved outfit, drawn. Today and the history both show the same thing, so
 * they show it through the same function: the photos, the book's own sentences
 * for the rules it cites, the ones it misses kept visible but quieter, and the
 * rationale marked as the assistant's own words.
 *
 * It is also where the owner corrects it. Tapping a piece turns the card into a
 * picker, so there is no route to widen and no second surface to invent, and
 * correcting works from the history for free.
 */
import { append, button, clear, el } from './dom.js';
import { tagState } from './garments.js';
import {
  LAYER_ORDER,
  bookTally,
  garmentIds,
  orderPieces,
  outfitDay,
  readOutfit,
  splitRules,
  wearEntry,
} from './outfits.js';
import { imagePath, watchImage } from './photo.js';

/** An outfit without one of these is not an outfit, so neither side offers to empty one. */
const REQUIRED_SLOTS = ['base', 'bottom', 'shoes'];

/** The layers an outfit can go without, which are the only ones it can be missing. */
const ADDABLE_LAYERS = LAYER_ORDER.filter((slot) => !REQUIRED_SLOTS.includes(slot));

/**
 * The slots the card offers to fill: every layer the outfit is not already
 * wearing, and `accessory` every time, because an outfit wears as many of those
 * as the owner likes, so the first one and the fourth are the same gesture.
 *
 * `worn` comes in rather than being read off the outfit, since a wear logged on
 * this phone counts the same as one the server already knows about. A worn
 * outfit is the record of a day and the server refuses to change one, so it
 * offers nothing at all.
 */
export function addableSlots(outfit, worn) {
  if (worn) return [];
  const held = new Set((outfit?.pieces ?? []).map((piece) => piece.slot));
  return [...ADDABLE_LAYERS.filter((slot) => !held.has(slot)), 'accessory'];
}

const MISSING_NAME = 'a garment no longer in the wardrobe';

/**
 * What a tile calls the piece under it. Every other slot holds one garment and
 * the slot's own name says which one that is, but an outfit wears as many
 * accessories as the owner likes, so the kind is the only thing that tells two
 * of them apart.
 */
export function pieceLabel(slot, garment) {
  if (slot !== 'accessory') return slot;
  const kind = garment.accessoryKind;
  // `other` is a real choice on the review screen and names nothing, so it
  // falls back with the untagged ones rather than reading "Change the other".
  return kind === null || kind === undefined || kind === 'other' ? 'accessory' : kind;
}

/** `outer` and `accessory` both open on a vowel, and "Add a outer" is not a sentence. */
const article = (word) => ('aeiou'.includes(word[0]) ? 'an' : 'a');

/**
 * Kinds a body has one place for, copied from `ONE_PER_OUTFIT` in
 * `src/domain/certify.ts`, which is the list `save_outfit` and the swap both
 * refuse a second of. The picker needs it to stop offering a garment the server
 * will turn down, and it cannot ask for it: the grid reads the wardrobe already
 * on the phone and makes no call at all. `test/accessoryParity.test.ts` fails
 * when the two drift, and nothing else would notice.
 */
export const ONE_PER_OUTFIT = ['glasses', 'hat', 'scarf', 'belt', 'bag', 'watch', 'earrings'];

function pieceTile(label, garment, onPick) {
  const image = el('img', {
    class: 'piece__img',
    src: imagePath(garment),
    alt: garment.subtype,
    decoding: 'async',
  });

  const frame = el('div', { class: 'piece__frame' }, image);
  watchImage(frame, image, { retry: true });

  const body = [
    frame,
    el('span', { class: 'piece__slot' }, label),
    el('span', { class: 'piece__name' }, garment.subtype),
  ];

  return el(
    'li',
    { class: 'piece' },
    onPick === null
      ? body
      : button(body, { class: 'piece__pick', 'aria-label': `Change the ${label}`, onclick: onPick }),
  );
}

function ruleList(rules, modifier) {
  return el(
    'ul',
    { class: modifier === null ? 'rules' : `rules ${modifier}` },
    rules.map((rule) =>
      el('li', { class: 'rule' }, [
        el('p', { class: 'rule__because' }, rule.because),
        el('span', { class: 'rule__id' }, rule.id),
      ]),
    ),
  );
}

/**
 * The rules the outfit keeps and the ones it sets aside, folded into one row.
 * Eleven of the book's sentences is most of a phone screen, and none of them
 * asks the owner to do anything today, so the pills carry what each rule wants
 * and the sentence behind one is a tap away.
 *
 * The donts are not in here. One of those means a swap made on this card went
 * against the book, which is the one thing nobody should have to open anything
 * to find.
 */
function bookSection(cited, missed, outfitId) {
  // Today and the history can have two cards on one screen, so the panel every
  // pill points at is named after the outfit rather than after the section.
  const said = el('div', { class: 'book__said', id: `book-said-${outfitId}` });
  let open = null;

  function pill(rule, kept) {
    const control = button(rule.short, {
      class: kept ? 'pill' : 'pill pill--missed',
      'aria-expanded': 'false',
      'aria-controls': said.id,
    });

    control.addEventListener('click', () => {
      const same = open === control;
      open?.setAttribute('aria-expanded', 'false');
      clear(said);
      open = same ? null : control;
      if (same) return;
      control.setAttribute('aria-expanded', 'true');
      append(
        said,
        // The sentence the missed section used to carry over its list. It is
        // the whole difference between a rule this outfit follows and one it
        // does not, and the quieter treatment alone does not say it.
        kept ? null : el('p', { class: 'source' }, 'This outfit breaks this one on purpose.'),
        ruleList([rule], kept ? null : 'rules--missed'),
      );
    });

    return el('li', {}, control);
  }

  return el('details', { class: 'book' }, [
    el('summary', { class: 'book__summary' }, [
      el('span', { class: 'section__title' }, 'From the book'),
      el('span', { class: 'book__tally' }, bookTally(cited.length, missed.length)),
    ]),
    el('ul', { class: 'pills' }, [
      ...cited.map((rule) => pill(rule, true)),
      ...missed.map((rule) => pill(rule, false)),
    ]),
    said,
  ]);
}

function changeLine(correction) {
  const into = correction.to === null ? 'nothing' : (correction.to.subtype ?? MISSING_NAME);
  // A row with neither side never reaches the card, `readCorrections` drops it,
  // so a missing `from` is always a real garment arriving on its own.
  if (correction.from === null) return `${correction.slot}: ${into} added`;
  const out = correction.from.subtype ?? MISSING_NAME;
  return `${correction.slot}: ${out} out, ${into} in`;
}

/** A third voice, kept apart from the book's and the assistant's the way those two are. */
function changeList(corrections) {
  return el('section', { class: 'section' }, [
    el('h3', { class: 'section__title' }, 'What you changed'),
    el(
      'ul',
      { class: 'changes' },
      corrections.map((correction) =>
        el('li', { class: 'change' }, [
          el('p', { class: 'change__what' }, changeLine(correction)),
          el('p', { class: 'change__why' }, `"${correction.reason}"`),
        ]),
      ),
    ),
    el('p', { class: 'source' }, 'Your own words. Claude reads them the next time it plans.'),
  ]);
}

/**
 * The three sentences this side mirrors from `FILTER_WORDS` in
 * src/worker/compose.ts. Fixed words rather than a table with rules in it, so
 * the copy cannot drift into saying something the engine does not do.
 *
 * Nothing pins the two tables together, and they have already parted: the
 * formality line here says "the day's" where the server's says "today's". This
 * is the right claim on a card about an outfit saved days ago, so the gap is
 * worth knowing about rather than closing from this side.
 */
const FILTER_WORDS = {
  season: 'out of season',
  formality: "under the day's formality floor",
  cooldown: 'worn too recently to come back yet',
};

/**
 * What a picker tile says, and deliberately not `FILTER_WORDS`. The two are
 * allowed to disagree, and the reason for a second table is length.
 *
 * "under the day's formality floor" is 31 characters. Measured in the real grid
 * at a 375px screen, where a tile is 97.66px wide, it takes two lines on its own
 * and three once the season line joins it, which drags every tile in that row
 * from 119px to 171px. That is not a rare case: a formal outfit has a floor of
 * 4, and in a 47 garment wardrobe every bottom, every mid and every base sits
 * under it, so nearly every tile in the grid would carry the long line at once.
 *
 * The other table's words are also fragments, written to be swallowed by the
 * sentence `honoredLine` wraps them in. These stand alone under a photo.
 *
 * 'out of season' is the same string in both, which is the short one already
 * being right rather than a reference the two share.
 */
const CAUTION_WORDS = {
  untagged: 'not tagged yet',
  no_season: 'no season set',
  season: 'out of season',
  formality: 'too casual',
};

function honoredLine(honored) {
  const name = honored.subtype ?? MISSING_NAME;
  if (honored.waived.length === 0) return `${name}, which fit the day anyway`;
  return `${name}: in only because you asked, ${honored.waived.map((one) => FILTER_WORDS[one]).join(' and ')}`;
}

/**
 * The premise of the outfit rather than a note on it, so it sits above the
 * rationale. What the owner said carries the section the way their reason
 * carries a correction, and the garments it let in are the small line under it.
 */
function requestSection(request) {
  return el('section', { class: 'section' }, [
    el('h3', { class: 'section__title' }, 'What you asked for'),
    el('p', { class: 'change__why' }, `"${request.words}"`),
    el(
      'ul',
      { class: 'changes' },
      request.honored.map((honored) =>
        el('li', { class: 'change' }, el('p', { class: 'change__what' }, honoredLine(honored))),
      ),
    ),
    el('p', { class: 'source' }, 'Your own words, as Claude wrote them down.'),
  ]);
}

/**
 * A fourth voice, and the only one that argues. It sits after the rationale
 * because it is the assistant's second thought about the outfit it just
 * explained, and under a title of its own so the two never read as one
 * paragraph.
 */
function disagreementSection(request) {
  return el('section', { class: 'section' }, [
    el('h3', { class: 'section__title' }, 'What Claude would have changed'),
    el('p', { class: 'rationale__text' }, request.disagreement),
    // Not the rationale's caption again: that one says these words are the
    // assistant's and not the book's, and the title above already said it here.
    el('p', { class: 'source source--model' }, "The assistant's own read of what you asked for."),
  ]);
}

/**
 * The tap is logged on the phone as well as on the server: whether saving a
 * wear also flips the outfit's own `worn` flag is the Worker's business, and
 * leaving the screen and coming back must not offer to log the same day twice.
 */
function wearButton(ctx, outfit, already, onWorn) {
  const control = button(already ? 'Worn' : 'Wore this', { class: 'btn btn--wide', disabled: already });
  if (!already) control.classList.add('btn--primary');

  control.addEventListener('click', async () => {
    if (control.disabled) return;
    control.disabled = true;
    control.textContent = 'Saving';
    try {
      await ctx.api.wear(wearEntry(outfit));
      ctx.worn.markWorn(outfit.id);
      // Redrawn rather than just relabeled: the pieces stop being tap targets
      // the moment the outfit becomes the record of a day, and the server would
      // refuse the swap anyway, so leaving them tappable only earns a toast.
      onWorn();
    } catch (error) {
      control.disabled = false;
      control.textContent = 'Wore this';
      ctx.toast(error.message, 'error');
    }
  });

  return control;
}

const REMOVE_ARM_MS = 4000;

/**
 * Two taps, the shape `removeRow` uses on the review screen, and with a better
 * claim to it: that one archives a garment and this one is the first thing in
 * the app that really deletes rows, so there is nothing to undo a mis-tap with.
 *
 * The first tap says the cooldown goes, because that is the part nobody expects
 * a card to do on its way off the screen. It is told on `wearNamed` and not on
 * `worn`, since only a wear row naming this outfit is one the delete can reach.
 */
function removeButton(ctx, outfit, wearNamed, onRemoved) {
  const control = button('Remove this outfit', { class: 'btn btn--small btn--danger' });
  let armed = false;
  let timer = null;

  control.addEventListener('click', async () => {
    if (control.disabled) return;
    if (!armed) {
      armed = true;
      control.textContent = 'Tap again to remove';
      ctx.toast(
        wearNamed
          ? 'This outfit and the wear you logged both go, so its garments come off their cooldown.'
          : 'This outfit leaves the app for good.',
      );
      timer = setTimeout(() => {
        armed = false;
        control.textContent = 'Remove this outfit';
      }, REMOVE_ARM_MS);
      return;
    }

    clearTimeout(timer);
    control.disabled = true;
    try {
      await ctx.api.removeOutfit(outfit.id);
      onRemoved();
    } catch (error) {
      // A 404 means the outfit is already gone, which is the outcome the tap
      // asked for. Two surfaces open on one outfit make that ordinary, and
      // reporting it would leave a card on screen for an outfit nothing holds.
      if (error?.status === 404) {
        onRemoved();
        return;
      }
      control.disabled = false;
      ctx.toast(error.message, 'error');
    }
  });

  return control;
}

/**
 * Which of the outfit's own filters a candidate fails, copied from
 * `failedFilters` in `src/domain/menu.ts`. The picker reads the wardrobe
 * already on the phone and makes no call at all, so it cannot ask the engine
 * what it would have said about this garment.
 * `test/swapLabelParity.test.ts` fails when the two drift, and nothing else
 * would notice: a tile would warn about a garment the engine admits, or say
 * nothing about one the engine holds back, and the owner reads either as the
 * engine's own word.
 *
 * The two null tests are the whole of what the server's has no need for. A
 * saved outfit can be missing the event that gives it a floor, and a row with
 * an unreadable date names no season, while a `Constraints` always has both.
 *
 * Accessories are exempt from the floor because the floor is about the
 * silhouette and a ring is not part of one (`menu.ts:87-90`). That is one line,
 * it could be edited away on the server, and the only symptom here would be an
 * accessory tile saying the outfit is too formal for it.
 *
 * A list rather than a boolean for the server's own reason: out of season and
 * under the floor stay told apart, and the tile is the one screen where the
 * owner reads them.
 */
export function failedFilters(garment, day) {
  const failed = [];
  if (day.season !== null && !garment.seasons.includes(day.season)) failed.push('season');
  if (day.minFormality !== null && garment.slot !== 'accessory' && garment.formality < day.minFormality) {
    failed.push('formality');
  }
  return failed;
}

/**
 * What the tile says about a candidate, judged against the day the outfit was
 * built for.
 *
 * An untagged garment says one thing and stops. `blankDraft` writes
 * `seasons: []` and `formality: 3`, so the predicate above calls it out of
 * season and a floor of 4 calls it too casual. Both are true of the engine and
 * lies about the garment, since nobody has looked at the photo yet. A vision
 * guess is a reading and is judged like any other, so only the placeholder is
 * held back.
 *
 * "no season set" is this file's own, and it sits above the copied predicate on
 * purpose: what comes from the server is pinned by the parity test, what is
 * invented here is covered by the selftest, and this function is the seam. A
 * reviewed garment can carry an empty season list too, so the split is not the
 * untagged test over again.
 */
export function cautionsFor(garment, day) {
  if (tagState(garment) === 'untagged') return ['untagged'];

  const failed = failedFilters(garment, day);
  const cautions = [];
  if (failed.includes('season')) {
    cautions.push(garment.seasons.length === 0 ? 'no_season' : 'season');
  }
  if (failed.includes('formality')) cautions.push('formality');
  return cautions;
}

/**
 * The whole wardrobe for that slot, in the order the wardrobe screen shows it.
 * Nothing is filtered and nothing is sorted: the owner is at that moment
 * saying the app's own filters were wrong, so a second filter would hide the
 * garment the tap exists to reach.
 *
 * Every candidate is labeled instead. A label hides nothing, costs no tap and
 * refuses nothing, and the tile keeps its place in that order, its photo, its
 * frame and its tap.
 *
 * The day behind the label is the outfit's own and never today's. An outfit
 * built for a summer day and opened in the winter is still a summer outfit, so
 * reading it against the day it is opened on would put a false warning on the
 * one screen where the owner can argue with it least.
 *
 * A missing input means no caution rather than a default one. An outfit saved
 * with no event has no floor to fail, and one with an unreadable date has no
 * season to be out of.
 *
 * `target` is a piece the outfit wears, or a slot with no garment on it, which
 * is the add: the owner is filling a slot the outfit never had and nothing
 * steps out.
 *
 * `done` takes the outfit the server sent back, or null when they backed out.
 */
function picker(ctx, outfit, target, done) {
  const options = ctx.store.garments.filter((garment) => garment.slot === target.slot);
  // Read once for the whole grid. Every candidate is judged against the same
  // day, and that day cannot change while the picker is open, because it is the
  // outfit's and the outfit is already saved.
  const day = outfitDay(outfit);
  const tiles = new Map();
  let chosen;

  const adding = target.garment === null;
  // Null rides all the way to the wire, where it is the whole of what tells the
  // server an add from a swap.
  const fromId = adding ? null : target.garment.id;

  const reason = el('input', {
    class: 'control',
    type: 'text',
    // Named after the outfit, the way the book panel above is. Two open history
    // rows are two cards in one page, and one fixed id there points the label at
    // the other card's input, so the tap lands in the wrong picker.
    id: `swap-reason-${outfit.id}`,
    maxlength: '280',
    autocomplete: 'off',
    // The swap asks what was wrong with the garment going out. An add has no
    // garment going out, so it asks for the thing the owner wanted instead.
    placeholder: adding
      ? 'It gets cold at night, the outfit needs a belt'
      : 'It itches, it is too warm, it does not go',
  });
  const why = el('div', { class: 'field', hidden: true }, [
    el('label', { class: 'field__label', for: reason.id }, 'Why the change?'),
    reason,
    el('p', { class: 'field__hint' }, 'Claude reads this the next time it plans an outfit.'),
  ]);
  const save = button('Save', { class: 'btn btn--primary', disabled: true });

  function refresh() {
    for (const [value, tile] of tiles) tile.setAttribute('aria-pressed', String(value === chosen));
    why.hidden = chosen === undefined;
    // The sentence is the point of the whole gesture, so it is what unlocks Save.
    save.disabled = chosen === undefined || reason.value.trim() === '';
  }

  function pick(value) {
    chosen = value;
    refresh();
    reason.focus();
  }

  function option(value, name, garment) {
    const frame = el('div', { class: 'tile__frame' });
    if (garment !== null) {
      const image = el('img', {
        class: 'tile__img',
        src: imagePath(garment),
        alt: '',
        loading: 'lazy',
        decoding: 'async',
      });
      frame.append(image);
      watchImage(frame, image);
    }

    // "Nothing here" is not a garment and has no day to be wrong for.
    const cautions = garment === null ? [] : cautionsFor(garment, day);

    const tile = el(
      'button',
      { type: 'button', class: 'tile', 'aria-pressed': 'false', onclick: () => pick(value) },
      [
        frame,
        el('span', { class: 'tile__name' }, name),
        // Inside the button rather than beside it, so the words join the
        // control's own accessible name and a screen reader says "wool coat,
        // out of season" about one thing.
        cautions.length === 0
          ? null
          : el('span', { class: 'tile__warn' }, cautions.map((one) => CAUTION_WORDS[one]).join(' and ')),
      ],
    );
    tiles.set(value, tile);
    return tile;
  }

  /** Shown but not offered, with the line under it saying which of the two it is. */
  function held(garment, note) {
    const image = el('img', {
      class: 'tile__img',
      src: imagePath(garment),
      alt: '',
      loading: 'lazy',
      decoding: 'async',
    });
    const frame = el('div', { class: 'tile__frame' }, image);
    watchImage(frame, image);

    return el('div', { class: 'tile tile--current' }, [
      frame,
      el('span', { class: 'tile__name' }, garment.subtype),
      el('span', { class: 'tile__slot' }, note),
    ]);
  }

  // Every garment already on the outfit, not just the tapped one. An outfit's
  // other accessories sit in this slot too, so they would otherwise be offered
  // as options the server then refuses as already in this outfit.
  const alreadyOn = new Set(garmentIds(outfit));

  // The one-per-outfit kinds the outfit still wears once the tapped garment
  // steps out. The server refuses a second of any of them, so offering one here
  // would cost the owner a reason typed out and a Save before it said no. On an
  // add nothing steps out, and a null `fromId` matches no garment, so every
  // accessory the outfit wears keeps its claim.
  const kept = new Set(
    outfit.accessories
      .filter((garment) => garment.id !== fromId)
      .map((garment) => garment.accessoryKind)
      .filter((kind) => ONE_PER_OUTFIT.includes(kind)),
  );

  const offered = options.filter(
    (garment) => !alreadyOn.has(garment.id) && !kept.has(garment.accessoryKind),
  );

  const grid = el('div', { class: 'grid' });
  // "Nothing here" empties the slot, and an add starts from an empty one, so
  // there it would be a tap asking for the state the card is already in.
  if (!adding && !REQUIRED_SLOTS.includes(target.slot)) grid.append(option(null, 'Nothing here', null));
  for (const garment of options) {
    if (alreadyOn.has(garment.id)) grid.append(held(garment, 'in this outfit'));
    else if (kept.has(garment.accessoryKind)) {
      grid.append(held(garment, `already wearing a ${garment.accessoryKind}`));
    } else grid.append(option(garment.id, garment.subtype, garment));
  }
  // Counted off the garments, not off `tiles`, which also holds the "Nothing
  // here" option and so is never empty for a slot an outfit can leave off.
  if (offered.length === 0) {
    // "else" counts the garment stepping out, and an add has none.
    grid.append(
      el(
        'p',
        { class: 'empty__text' },
        adding ? 'Nothing in your wardrobe can go here.' : 'Nothing else in your wardrobe can go here.',
      ),
    );
  }

  reason.addEventListener('input', refresh);
  save.addEventListener('click', async () => {
    if (save.disabled) return;
    save.disabled = true;
    save.textContent = 'Saving';
    try {
      const body = await ctx.api.editPiece(outfit.id, {
        fromId,
        toId: chosen,
        reason: reason.value.trim(),
      });
      const next = readOutfit(body?.outfit);
      if (next === null) throw new Error('The server sent back an outfit the app could not read.');
      done(next);
    } catch (error) {
      save.textContent = 'Save';
      refresh();
      ctx.toast(error.message, 'error');
    }
  });

  const heading = adding
    ? `Add ${article(target.slot)} ${target.slot}`
    : `Change the ${pieceLabel(target.slot, target.garment)}`;

  return el('div', { class: 'swap' }, [
    el('h3', { class: 'section__title' }, heading),
    grid,
    why,
    el('div', { class: 'swap__actions' }, [
      button('Cancel', { class: 'btn btn--ghost', onclick: () => done(null) }),
      save,
    ]),
  ]);
}

/**
 * The outfit's own title takes the heading, and the screen's caption drops to
 * the small line under it: the name the assistant gave the outfit is the more
 * useful thing to read first. An outfit with no title keeps the caption as its
 * heading, so nothing saved before titles existed loses one.
 */
function cardHead(named, caption, meta) {
  const heading = named ?? caption;
  const under = named === null ? null : caption;
  if (heading === null && under === null && meta === '') return null;

  const sub =
    under === null && meta === ''
      ? null
      : el('div', { class: 'outfit__when' }, [
          under === null ? null : el('span', {}, under),
          meta === '' ? null : el('span', { class: 'outfit__meta' }, meta),
        ]);

  return el('div', { class: 'outfit__head' }, [
    heading === null ? null : el('h2', { class: 'outfit__title' }, heading),
    sub,
  ]);
}

/**
 * `caption` is null where the screen already says which outfit this is, and
 * `showName` is false where it has already shown the outfit's own name. The
 * history does exactly that, in the row you tap to open the card.
 *
 * `onRemoved` runs once the outfit is deleted, and a screen that passes none
 * gets no remove control at all. The card cannot take itself off the screen, so
 * offering the tap where nobody handles it would leave a card for an outfit
 * that is gone.
 */
export function outfitCard(
  ctx,
  outfit,
  { caption = null, meta = '', showName = true, onRemoved = null } = {},
) {
  const node = el('section', { class: 'outfit' });
  let current = outfit;

  /**
   * The wardrobe is loaded once at boot, and Today's own fetch for the outfit
   * normally lands after it. Normally is not always, and a picker drawn from an
   * empty store would tell the owner they own nothing in this slot.
   */
  async function drawPicker(target) {
    clear(node);
    append(node, el('p', { class: 'empty__text' }, 'Reading your wardrobe.'));
    try {
      await ctx.store.ensure();
    } catch (error) {
      ctx.toast(error.message, 'error');
      drawCard();
      return;
    }

    clear(node);
    append(
      node,
      picker(ctx, current, target, (next) => {
        if (next !== null) current = next;
        drawCard();
      }),
    );
  }

  function drawCard() {
    const pieces = orderPieces(current.pieces);
    const { cited, missed, broke } = splitRules(current);
    // The test the wear button already made, read once: an outfit that was worn
    // is the record of a day, so the server refuses to change one and the card
    // offers no tap.
    const worn = current.worn || ctx.worn.isWorn(current.id);
    // A narrower question than `worn`, and the one the remove control needs: an
    // outfit worn before migration 009, or through a log_wear that left the id
    // out, is worn off the day and the garments and no row claims it. `ctx.worn`
    // counts because the only thing that puts an id in it is the button below,
    // which always names the outfit.
    const wearNamed = current.wearNamed || ctx.worn.isWorn(current.id);

    const head = cardHead(showName && current.title !== '' ? current.title : null, caption, meta);

    // The same tile the pieces get, and tappable for the same reason. It keeps a
    // section of its own because an accessory has no place in the base to shoes
    // order above it, and there can be several.
    const accessories =
      current.accessories.length === 0
        ? null
        : el('div', { class: 'accessories' }, [
            el('h4', { class: 'section__title' }, 'With'),
            el(
              'ul',
              { class: 'looks' },
              current.accessories.map((garment) =>
                pieceTile(
                  pieceLabel('accessory', garment),
                  garment,
                  worn ? null : () => drawPicker({ slot: 'accessory', garment }),
                ),
              ),
            ),
          ]);

    // Under the grid rather than a dashed hole standing in for each empty slot.
    // Measured at a 375px shell, the holes cost a bare card 490px of empty photo
    // frames and push the rationale off the screen, and the chips cost 70px and
    // still name the slot they fill.
    const open = addableSlots(current, worn);
    const addRow =
      open.length === 0
        ? null
        : el('div', { class: 'addrow' }, [
            el('span', { class: 'addrow__label' }, 'Add'),
            el(
              'div',
              { class: 'filters' },
              open.map((slot) =>
                button(slot, {
                  class: 'filter',
                  'aria-label': `Add ${article(slot)} ${slot}`,
                  onclick: () => drawPicker({ slot, garment: null }),
                }),
              ),
            ),
          ]);

    clear(node);
    append(
      node,
      head,
      el(
        'ul',
        { class: 'looks' },
        pieces.map((piece) =>
          pieceTile(
            pieceLabel(piece.slot, piece.garment),
            piece.garment,
            worn ? null : () => drawPicker(piece),
          ),
        ),
      ),
      addRow,
      accessories,
      current.ownerRequest === null ? null : requestSection(current.ownerRequest),
      current.rationale === ''
        ? null
        : el('div', { class: 'rationale' }, [
            el('p', { class: 'rationale__text' }, current.rationale),
            el(
              'p',
              { class: 'source source--model' },
              current.corrections.length === 0
                ? 'The assistant wrote this. It is not from the book.'
                : 'The assistant wrote this for the pieces it chose, before you changed one. It is not from the book.',
            ),
          ]),
      current.ownerRequest === null || current.ownerRequest.disagreement === ''
        ? null
        : disagreementSection(current.ownerRequest),
      current.corrections.length === 0 ? null : changeList(current.corrections),
      cited.length === 0 && missed.length === 0 ? null : bookSection(cited, missed, current.id),
      // Apart from the missed section because a dont is not a preference. The
      // outfit was saved keeping these, so the only thing that can have broken
      // one is a change the owner made here.
      broke.length === 0
        ? null
        : el('section', { class: 'section section--broke' }, [
            el('h3', { class: 'section__title' }, 'From the book, and broken here'),
            // No sentence blaming the owner, however likely they are the cause.
            // The list is recomputed over the whole outfit and read against the
            // book as it stands now, so a garment retagged since, or a rule the
            // book has since made a dont, lands here having broken nothing at
            // the time. "What you changed" sits right below and says what it can
            // actually stand behind.
            el('p', { class: 'source' }, "These are the book's donts, not preferences."),
            ruleList(broke, 'rules--broke'),
          ]),
      wearButton(ctx, current, worn, drawCard),
      onRemoved === null
        ? null
        : el('div', { class: 'outfit__remove' }, removeButton(ctx, current, wearNamed, onRemoved)),
    );
  }

  drawCard();
  return node;
}
