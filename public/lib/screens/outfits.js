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

  /**
   * The name carries the row whenever the outfit has one, because a column of
   * days is not something you can scan for the outfit you remember. The day
   * moves to the small text on the right, taking the piece count's place: the
   * count is on the card a tap away and the day is not.
   */
  function summaryOf(outfit) {
    const when = savedLine(outfit.createdAt);
    if (outfit.title === '') return { lead: when, aside: summaryLine(outfit) };
    return { lead: outfit.title, aside: outfit.worn ? `${when}, worn` : when };
  }

  /** The card is built on the first open: twenty outfits is a hundred photos. */
  function entry(outfit, index) {
    const { lead, aside } = summaryOf(outfit);
    const box = el('details', { class: 'entry' }, [
      el('summary', { class: 'entry__summary' }, [
        el('span', { class: 'entry__when' }, lead),
        el('span', { class: 'entry__meta' }, aside),
      ]),
    ]);

    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      // Read again rather than the row dropped here. The screen keeps no
      // outfits of its own, so asking once more is what stops the count in the
      // title and the list under it from disagreeing.
      box.append(outfitCard(ctx, outfit, { showName: false, onRemoved: load }));
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
  ctx.onRefresh(load);
  load();

  return {
    node,
    destroy() {
      gone = true;
    },
  };
}
