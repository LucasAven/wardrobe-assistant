/**
 * One saved outfit, drawn. Today and the history both show the same thing, so
 * they show it through the same function: the photos, the book's own sentences
 * for the rules it cites, the ones it misses kept visible but quieter, and the
 * rationale marked as the assistant's own words.
 */
import { button, el } from './dom.js';
import { garmentIds, orderPieces, splitRules } from './outfits.js';
import { imagePath, watchImage } from './photo.js';

function pieceTile(slot, garment) {
  const image = el('img', {
    class: 'piece__img',
    src: imagePath(garment),
    alt: garment.subtype,
    decoding: 'async',
  });

  const frame = el('div', { class: 'piece__frame' }, image);
  watchImage(frame, image, { retry: true });

  return el('li', { class: 'piece' }, [
    frame,
    el('span', { class: 'piece__slot' }, slot),
    el('span', { class: 'piece__name' }, garment.subtype),
  ]);
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
 * The tap is logged on the phone as well as on the server: whether saving a
 * wear also flips the outfit's own `worn` flag is the Worker's business, and
 * leaving the screen and coming back must not offer to log the same day twice.
 */
function wearButton(ctx, outfit) {
  const already = outfit.worn || ctx.worn.isWorn(outfit.id);
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

/** `title` is null where the screen already says which outfit this is. */
export function outfitCard(ctx, outfit, { title = null, meta = '' } = {}) {
  const pieces = orderPieces(outfit.pieces);
  const { cited, missed } = splitRules(outfit);

  const head =
    title === null
      ? null
      : el('div', { class: 'outfit__head' }, [
          el('h2', { class: 'outfit__title' }, title),
          el('span', { class: 'outfit__meta' }, meta),
        ]);

  const accessories =
    outfit.accessories.length === 0
      ? null
      : el('div', { class: 'accessories' }, [
          el('h4', { class: 'section__title' }, 'With'),
          el(
            'ul',
            { class: 'tags' },
            outfit.accessories.map((garment) => el('li', { class: 'tag' }, garment.subtype)),
          ),
        ]);

  return el('section', { class: 'outfit' }, [
    head,
    el(
      'ul',
      { class: 'looks' },
      pieces.map((piece) => pieceTile(piece.slot, piece.garment)),
    ),
    accessories,
    outfit.rationale === ''
      ? null
      : el('div', { class: 'rationale' }, [
          el('p', { class: 'rationale__text' }, outfit.rationale),
          el('p', { class: 'source source--model' }, 'The assistant wrote this. It is not from the book.'),
        ]),
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
    wearButton(ctx, outfit),
  ]);
}
