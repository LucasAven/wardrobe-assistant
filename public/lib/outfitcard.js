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
import { garmentIds, orderPieces, readOutfit, splitRules, wearEntry } from './outfits.js';
import { imagePath, watchImage } from './photo.js';

/** An outfit without one of these is not an outfit, so neither side offers to empty one. */
const REQUIRED_SLOTS = ['base', 'bottom', 'shoes'];

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

function changeLine(correction) {
  const out = correction.from.subtype ?? MISSING_NAME;
  const into = correction.to === null ? 'nothing' : (correction.to.subtype ?? MISSING_NAME);
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
 * The same four sentences `FILTER_WORDS` holds in src/worker/compose.ts. Four
 * fixed words rather than a table with rules in it, so the copy cannot drift
 * into saying something the engine does not do.
 */
const FILTER_WORDS = {
  season: 'out of season',
  formality: "under the day's formality floor",
  cooldown: 'worn too recently to come back yet',
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
 * The whole wardrobe for that slot, in the order the wardrobe screen shows it.
 * Nothing is filtered and nothing is labeled: the owner is at that moment
 * saying the app's own filters were wrong, so a second filter would hide the
 * garment the tap exists to reach.
 *
 * `done` takes the outfit the server sent back, or null when they backed out.
 */
function picker(ctx, outfit, piece, done) {
  const options = ctx.store.garments.filter((garment) => garment.slot === piece.slot);
  const tiles = new Map();
  let chosen;

  const reason = el('input', {
    class: 'control',
    type: 'text',
    id: 'swap-reason',
    maxlength: '280',
    autocomplete: 'off',
    placeholder: 'It itches, it is too warm, it does not go',
  });
  const why = el('div', { class: 'field', hidden: true }, [
    el('label', { class: 'field__label', for: 'swap-reason' }, 'Why the change?'),
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

    const tile = el(
      'button',
      { type: 'button', class: 'tile', 'aria-pressed': 'false', onclick: () => pick(value) },
      [frame, el('span', { class: 'tile__name' }, name)],
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
  // would cost the owner a reason typed out and a Save before it said no.
  const kept = new Set(
    outfit.accessories
      .filter((garment) => garment.id !== piece.garment.id)
      .map((garment) => garment.accessoryKind)
      .filter((kind) => ONE_PER_OUTFIT.includes(kind)),
  );

  const offered = options.filter(
    (garment) => !alreadyOn.has(garment.id) && !kept.has(garment.accessoryKind),
  );

  const grid = el('div', { class: 'grid' });
  if (!REQUIRED_SLOTS.includes(piece.slot)) grid.append(option(null, 'Nothing here', null));
  for (const garment of options) {
    if (alreadyOn.has(garment.id)) grid.append(held(garment, 'in this outfit'));
    else if (kept.has(garment.accessoryKind)) {
      grid.append(held(garment, `already wearing a ${garment.accessoryKind}`));
    } else grid.append(option(garment.id, garment.subtype, garment));
  }
  // Counted off the garments, not off `tiles`, which also holds the "Nothing
  // here" option and so is never empty for a slot an outfit can leave off.
  if (offered.length === 0) {
    grid.append(el('p', { class: 'empty__text' }, 'Nothing else in your wardrobe can go here.'));
  }

  reason.addEventListener('input', refresh);
  save.addEventListener('click', async () => {
    if (save.disabled) return;
    save.disabled = true;
    save.textContent = 'Saving';
    try {
      const body = await ctx.api.swapPiece(outfit.id, {
        fromId: piece.garment.id,
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

  return el('div', { class: 'swap' }, [
    el('h3', { class: 'section__title' }, `Change the ${pieceLabel(piece.slot, piece.garment)}`),
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
  async function drawPicker(piece) {
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
      picker(ctx, current, piece, (next) => {
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
      cited.length === 0
        ? null
        : el('section', { class: 'section' }, [el('h3', { class: 'section__title' }, 'From the book'), ruleList(cited, null)]),
      missed.length === 0
        ? null
        : el('section', { class: 'section section--missed' }, [
            el('h3', { class: 'section__title' }, 'From the book, and missed here'),
            el('p', { class: 'source' }, 'This outfit breaks these on purpose.'),
            ruleList(missed, 'rules--missed'),
          ]),
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
