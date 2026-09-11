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
import { garmentIds, orderPieces, readOutfit, splitRules } from './outfits.js';
import { imagePath, watchImage } from './photo.js';

/** An outfit without one of these is not an outfit, so neither side offers to empty one. */
const REQUIRED_SLOTS = ['base', 'bottom', 'shoes'];

const MISSING_NAME = 'a garment no longer in the wardrobe';

function pieceTile(slot, garment, onPick) {
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
    el('span', { class: 'piece__slot' }, slot),
    el('span', { class: 'piece__name' }, garment.subtype),
  ];

  return el(
    'li',
    { class: 'piece' },
    onPick === null
      ? body
      : button(body, { class: 'piece__pick', 'aria-label': `Change the ${slot}`, onclick: onPick }),
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
 * The tap is logged on the phone as well as on the server: whether saving a
 * wear also flips the outfit's own `worn` flag is the Worker's business, and
 * leaving the screen and coming back must not offer to log the same day twice.
 */
function wearButton(ctx, outfit, already) {
  const control = button(already ? 'Worn' : 'Wore this', { class: 'btn btn--wide', disabled: already });
  if (!already) control.classList.add('btn--primary');

  control.addEventListener('click', async () => {
    if (control.disabled) return;
    control.disabled = true;
    control.textContent = 'Saving';
    try {
      await ctx.api.wear({ garmentIds: garmentIds(outfit) });
      ctx.worn.markWorn(outfit.id);
      control.classList.remove('btn--primary');
      control.textContent = 'Worn';
    } catch (error) {
      control.disabled = false;
      control.textContent = 'Wore this';
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

  function wearing(garment) {
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
      el('span', { class: 'tile__slot' }, 'in this outfit'),
    ]);
  }

  const grid = el('div', { class: 'grid' });
  if (!REQUIRED_SLOTS.includes(piece.slot)) grid.append(option(null, 'Nothing here', null));
  for (const garment of options) {
    const same = garment.id === piece.garment.id;
    grid.append(same ? wearing(garment) : option(garment.id, garment.subtype, garment));
  }
  if (tiles.size === 0) {
    grid.append(el('p', { class: 'empty__text' }, 'Nothing else in your wardrobe sits in this slot.'));
  }

  reason.addEventListener('input', refresh);
  save.addEventListener('click', async () => {
    if (save.disabled) return;
    save.disabled = true;
    save.textContent = 'Saving';
    try {
      const body = await ctx.api.swapPiece(outfit.id, {
        slot: piece.slot,
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
    el('h3', { class: 'section__title' }, `Change the ${piece.slot}`),
    grid,
    why,
    el('div', { class: 'swap__actions' }, [
      button('Cancel', { class: 'btn btn--ghost', onclick: () => done(null) }),
      save,
    ]),
  ]);
}

/** `title` is null where the screen already says which outfit this is. */
export function outfitCard(ctx, outfit, { title = null, meta = '' } = {}) {
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
    const { cited, missed } = splitRules(current);
    // The test the wear button already made, read once: an outfit that was worn
    // is the record of a day, so the server refuses to change one and the card
    // offers no tap.
    const worn = current.worn || ctx.worn.isWorn(current.id);

    const head =
      title === null
        ? null
        : el('div', { class: 'outfit__head' }, [
            el('h2', { class: 'outfit__title' }, title),
            el('span', { class: 'outfit__meta' }, meta),
          ]);

    const accessories =
      current.accessories.length === 0
        ? null
        : el('div', { class: 'accessories' }, [
            el('h4', { class: 'section__title' }, 'With'),
            el(
              'ul',
              { class: 'tags' },
              current.accessories.map((garment) => el('li', { class: 'tag' }, garment.subtype)),
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
          pieceTile(piece.slot, piece.garment, worn ? null : () => drawPicker(piece)),
        ),
      ),
      accessories,
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
      wearButton(ctx, current, worn),
    );
  }

  drawCard();
  return node;
}
