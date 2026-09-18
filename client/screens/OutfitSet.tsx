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
import { useState } from 'react';
import { OutfitCard } from './OutfitCard.js';
import type { Outfit } from '../lib/queries.js';


export function OutfitSet({
  outfits,
  caption = null,
  meta = '',
  showName = true,
  onRemoved = null,
}: {
  outfits: Outfit[];
  caption?: string | null;
  meta?: string;
  showName?: boolean;
  onRemoved?: (() => void) | null;
}) {
  const [at, setAt] = useState(0);
  // Built on the first show and kept. Three outfits is up to fifteen photos,
  // and a slide left in the page unseen loads every one of them. A card kept
  // hidden comes back as it was left, an open picker and a typed reason
  // included, which is why the others are hidden rather than unmounted.
  const [built, setBuilt] = useState<number[]>([0]);

  const card = (outfit: Outfit, index: number) => (
    <OutfitCard
      outfit={outfit}
      caption={caption}
      meta={meta}
      showName={showName}
      onRemoved={onRemoved}
      key={outfit.id ?? index}
    />
  );

  // A bar reading "Option 1 of 1" is chrome that says nothing, so a set of one
  // is just the card. Both screens hand every group over here, so neither has
  // to know which of the two it got.
  const only = outfits[0];
  if (outfits.length === 1 && only !== undefined) return card(only, 0);

  function show(index: number) {
    setAt(index);
    setBuilt((rows) => (rows.includes(index) ? rows : [...rows, index]));
  }

  return (
    <div className="set">
      <div className="set__bar">
        <span className="set__count" aria-live="polite">{`Option ${at + 1} of ${outfits.length}`}</span>
        <div className="set__moves">
          <button className="btn btn--small btn--ghost" type="button" disabled={at === 0} onClick={() => show(at - 1)}>
            Previous
          </button>
          <button
            className="btn btn--small btn--ghost"
            type="button"
            disabled={at === outfits.length - 1}
            onClick={() => show(at + 1)}
          >
            Next
          </button>
        </div>
      </div>
      <div className="set__stage">
        {outfits.map((outfit, index) =>
          built.includes(index) ? (
            <div hidden={index !== at} key={outfit.id ?? index}>
              {card(outfit, index)}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}
