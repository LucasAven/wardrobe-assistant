import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { OutfitSet } from './OutfitSet.js';
import { groupBySet, readOutfits, savedLine } from '../lib/outfits.js';
import { api, outfitsKey } from '../lib/queries.js';
import type { Outfit } from '../lib/queries.js';
import { go } from '../lib/route.js';
import { useScreenChrome } from '../lib/shell.js';
import { isWorn } from '../lib/worn.js';

/** Enough to scroll a couple of weeks back on a phone without paging. */
const HISTORY_LIMIT = 20;

type Group = { setId: string; outfits: Outfit[] };

function summaryLine(outfit: Outfit) {
  const count = outfit.pieces.length + outfit.accessories.length;
  return count === 1 ? '1 piece' : `${count} pieces`;
}

/**
 * The name carries the row whenever the outfit has one, because a column of
 * days is not something you can scan for the outfit you remember. The day moves
 * to the small text on the right, taking the piece count's place: the count is
 * on the card a tap away and the day is not.
 *
 * A set holds two or three names and can be led by none of them, so it keeps
 * the day and says how many outfits it opens into. The names are on the cards
 * inside, which is where the choice between them is made anyway.
 */
function summaryOf(set: Group) {
  const [first] = set.outfits;
  if (first === undefined) return { lead: '', aside: '' };

  // The time the first option landed, which is when the set was composed. The
  // rest of them were saved in the same turn, seconds behind it.
  const when = savedLine(first.createdAt);
  if (set.outfits.length > 1) return { lead: when, aside: `${set.outfits.length} outfits` };
  if (first.title === '') return { lead: when, aside: summaryLine(first) };
  return { lead: first.title, aside: when };
}

/**
 * The cards are built on the first open: twenty outfits is a hundred photos.
 *
 * The rows are independent, so opening one leaves the others alone. `open` is
 * set once through the ref rather than held as a prop: React re-applying it on
 * every render would make the rows one accordion, and each row's own `toggle`
 * would then close the row that just opened.
 */
function Entry({ set, openFirst, onRemoved }: { set: Group; openFirst: boolean; onRemoved: () => void }) {
  // Built once and kept, so a row closed and opened again comes back as it was
  // left rather than reloading its photos.
  const [built, setBuilt] = useState(openFirst);
  const box = useRef<HTMLDetailsElement>(null);
  const { lead, aside } = summaryOf(set);

  useEffect(() => {
    if (openFirst && box.current !== null) box.current.open = true;
  }, [openFirst]);

  // The same question the card inside this row asks. A wear logged this session
  // may not be on the row the server just sent back, and a row reading nothing
  // over a card reading Worn is the disagreement to avoid. Any one option worn
  // is a day this set was wearing, since the owner picks one of them and the
  // rest stay unworn.
  const worn = set.outfits.some((outfit) => outfit.worn || isWorn(outfit.id));

  return (
    <details
      className="entry"
      ref={box}
      onToggle={(event) => {
        if (event.currentTarget.open) setBuilt(true);
      }}
    >
      <summary className="entry__summary">
        <span className="entry__when">{lead}</span>
        {worn && <span className="entry__worn">Worn</span>}
        <span className="entry__meta">{aside}</span>
      </summary>
      {built && (
        <OutfitSet
          outfits={set.outfits}
          // The row above already names a single outfit, and it cannot name
          // three, so the names come back on a set, where they tell the options
          // apart.
          showName={set.outfits.length > 1}
          onRemoved={onRemoved}
        />
      )}
    </details>
  );
}

export function Outfits() {
  const history = useQuery({
    queryKey: outfitsKey(HISTORY_LIMIT),
    queryFn: async () => readOutfits(await api.listOutfits(HISTORY_LIMIT)),
  });

  const outfits = history.data ?? [];
  useScreenChrome({
    title: 'Outfits',
    meta: history.data === undefined || outfits.length === 0 ? '' : `${outfits.length} saved`,
    refresh: () => void history.refetch(),
  });

  const sets: Group[] = history.data === undefined ? [] : groupBySet(outfits);

  return (
    <main className="screen">
      <section className="screen__body">
        {history.isPending && (
          <div className="empty">
            <p className="empty__text">Reading what Claude saved.</p>
          </div>
        )}

        {history.isError && (
          <div className="empty">
            <p className="empty__text">{history.error.message}</p>
            <button className="btn btn--primary" type="button" onClick={() => void history.refetch()}>
              Try again
            </button>
          </div>
        )}

        {history.isSuccess && outfits.length === 0 && (
          <section className="card">
            <h2 className="card__title">Nothing saved yet.</h2>
            <p className="card__line">
              Every outfit Claude saves stays here. Ask on your phone, and the first one shows up after that.
            </p>
            <button className="btn btn--wide" type="button" onClick={() => go('#/today')}>
              Back to today
            </button>
          </section>
        )}

        {sets.map((set) => (
          <Entry
            set={set}
            openFirst={set.setId === sets[0]?.setId}
            // Read again rather than the row dropped here. The screen keeps no
            // outfits of its own, so asking once more is what stops the count
            // in the title and the list under it from disagreeing.
            onRemoved={() => void history.refetch()}
            key={set.setId}
          />
        ))}
      </section>
    </main>
  );
}
