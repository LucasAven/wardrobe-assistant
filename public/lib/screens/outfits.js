import { append, button, clear, el } from '../dom.js';
import { outfitCard } from '../outfitcard.js';
import { readOutfits, savedLine } from '../outfits.js';

/** Enough to scroll a couple of weeks back on a phone without paging. */
const HISTORY_LIMIT = 20;

export function mountOutfits(ctx) {
  const node = el('section', { class: 'screen__body' });
  let gone = false;

  function show(...children) {
    clear(node);
    append(node, ...children);
  }

  function summaryLine(outfit) {
    const count = outfit.pieces.length + outfit.accessories.length;
    const pieces = count === 1 ? '1 piece' : `${count} pieces`;
    return outfit.worn ? `${pieces}, worn` : pieces;
  }

  /** The card is built on the first open: twenty outfits is a hundred photos. */
  function entry(outfit, index) {
    const box = el('details', { class: 'entry' }, [
      el('summary', { class: 'entry__summary' }, [
        el('span', { class: 'entry__when' }, savedLine(outfit.createdAt)),
        el('span', { class: 'entry__meta' }, summaryLine(outfit)),
      ]),
    ]);

    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      box.append(outfitCard(ctx, outfit));
    };

    box.addEventListener('toggle', () => {
      if (box.open) build();
    });

    if (index === 0) {
      box.open = true;
      build();
    }
    return box;
  }

  function render(outfits) {
    ctx.setTitle('Outfits', outfits.length === 0 ? '' : `${outfits.length} saved`);

    if (outfits.length === 0) {
      show(
        el('section', { class: 'card' }, [
          el('h2', { class: 'card__title' }, 'Nothing saved yet.'),
          el(
            'p',
            { class: 'card__line' },
            'Every outfit Claude saves stays here. Ask on your phone, and the first one shows up after that.',
          ),
          button('Back to today', { class: 'btn btn--wide', onclick: () => ctx.go('#/today') }),
        ]),
      );
      return;
    }

    show(...outfits.map(entry));
  }

  async function load() {
    show(el('div', { class: 'empty' }, el('p', { class: 'empty__text' }, 'Reading what Claude saved.')));
    try {
      const outfits = readOutfits(await ctx.api.listOutfits(HISTORY_LIMIT));
      if (gone) return;
      render(outfits);
    } catch (error) {
      if (gone) return;
      show(
        el('div', { class: 'empty' }, [
          el('p', { class: 'empty__text' }, error.message),
          button('Try again', { class: 'btn btn--primary', onclick: load }),
        ]),
      );
    }
  }

  ctx.setTitle('Outfits', '');
  ctx.setBack('#/today');
  ctx.onRefresh(load);
  load();

  return {
    node,
    destroy() {
      gone = true;
    },
  };
}
