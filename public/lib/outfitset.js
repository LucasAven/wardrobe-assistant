/**
 * The outfits of one request, shown one at a time.
 *
 * Claude composes two or three when the owner asks for options, and the set is
 * a choice rather than a list: one card, a count saying which option this is,
 * and a move either way. Nothing here scrolls sideways. One card runs taller
 * than a phone screen, so two of them can never be read side by side anyway,
 * and a track wide enough to peek the next one leaves a gap under the short
 * ones as tall as a third of the screen.
 */
import { append, button, clear, el } from './dom.js';
import { outfitCard } from './outfitcard.js';

export function outfitSet(ctx, outfits, { caption = null, meta = '', showName = true, onRemoved = null } = {}) {
  const options = { caption, meta, showName, onRemoved };
  // A bar reading "Option 1 of 1" is chrome that says nothing, so a set of one
  // is just the card. Both screens hand every group over here, so neither has
  // to know which of the two it got.
  if (outfits.length === 1) return outfitCard(ctx, outfits[0], options);

  const stage = el('div', { class: 'set__stage' });
  // Built on the first show and kept. Three outfits is up to fifteen photos,
  // and a slide left in the page unseen loads every one of them.
  const built = new Map();
  let at = 0;

  const count = el('span', { class: 'set__count', 'aria-live': 'polite' });
  const previous = button('Previous', { class: 'btn btn--small btn--ghost' });
  const next = button('Next', { class: 'btn btn--small btn--ghost' });

  function show(index) {
    at = index;
    count.textContent = `Option ${index + 1} of ${outfits.length}`;
    previous.disabled = index === 0;
    next.disabled = index === outfits.length - 1;

    let card = built.get(index);
    if (card === undefined) {
      card = outfitCard(ctx, outfits[index], options);
      built.set(index, card);
    }
    // The card owns this node for its whole life and only ever clears and
    // refills it, so a card taken off the screen and put back comes back as it
    // was left, an open picker and a typed reason included.
    clear(stage);
    append(stage, card);
  }

  previous.addEventListener('click', () => {
    if (at > 0) show(at - 1);
  });
  next.addEventListener('click', () => {
    if (at < outfits.length - 1) show(at + 1);
  });

  show(0);

  return el('div', { class: 'set' }, [
    el('div', { class: 'set__bar' }, [count, el('div', { class: 'set__moves' }, [previous, next])]),
    stage,
  ]);
}
