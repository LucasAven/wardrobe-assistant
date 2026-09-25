import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { OutfitSet } from './OutfitSet.js';
import { Empty, Screen, TryAgain } from './Screen.js';
import { groupBySet, readOutfits, savedLine } from '../lib/outfits.js';
import { api, historyKey, outfitListOptions } from '../lib/queries.js';
import type { Outfit } from '../lib/queries.js';
import { go } from '../lib/route.js';
import { useRefreshFailure, useScreenChrome } from '../lib/shell.js';
import { useWorn } from '../lib/worn.js';

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
function Entry({ set, openFirst }: { set: Group; openFirst: boolean }) {
  // Built once and kept, so a row closed and opened again comes back as it was
  // left rather than reloading its photos.
  const [built, setBuilt] = useState(openFirst);
  const box = useRef<HTMLDetailsElement>(null);
  const wornSession = useWorn();
  const { lead, aside } = summaryOf(set);

  useEffect(() => {
    if (openFirst && box.current !== null) box.current.open = true;
  }, [openFirst]);

  // The same question the card inside this row asks. A wear logged this session
  // may not be on the row the server just sent back, and a row reading nothing
  // over a card reading Worn is the disagreement to avoid, so this subscribes
  // and the tap inside the row reaches the summary above it. Any one option
  // worn is a day this set was wearing, since the owner picks one of them and
  // the rest stay unworn.
  const worn = set.outfits.some((outfit) => outfit.worn || wornSession.has(outfit.id));

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
          // The ids, not the set, so removing one option rebuilds the pager
          // rather than leaving it on "Option 3 of 2".
          key={set.outfits.map((outfit) => outfit.id).join()}
          outfits={set.outfits}
          // The row above already names a single outfit, and it cannot name
          // three, so the names come back on a set, where they tell the options
          // apart.
          showName={set.outfits.length > 1}
        />
      )}
    </details>
  );
}

export function Outfits() {
  const history = useQuery({
    queryKey: historyKey(HISTORY_LIMIT),
    queryFn: async () => readOutfits(await api.listOutfits(HISTORY_LIMIT)),
    ...outfitListOptions,
  });

  useRefreshFailure(history);

  const outfits = history.data ?? [];
  useScreenChrome({
    title: 'Outfits',
    meta: history.data === undefined || outfits.length === 0 ? '' : `${outfits.length} saved`,
    refresh: () => void history.refetch(),
  });

  const sets: Group[] = history.data === undefined ? [] : groupBySet(outfits);

  return (
    <Screen>
      {history.isPending && <Empty text="Reading what Claude saved." />}

      {/* Only where there is nothing behind it, so a failed Refresh keeps the
          history on screen and says so in a line instead. */}
      {history.isError && history.data === undefined && (
        <Empty text={history.error.message} action={<TryAgain onRetry={() => void history.refetch()} />} />
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
        <Entry set={set} openFirst={set.setId === sets[0]?.setId} key={set.setId} />
      ))}
    </Screen>
  );
}
