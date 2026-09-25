import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Photo } from './Photo.js';
import { countTagStates, tagState } from '../lib/garments.js';
import { imagePath } from '../lib/photo.js';
import { Empty, Screen, TryAgain } from './Screen.js';
import { api, gapsKey, garmentsQuery } from '../lib/queries.js';
import type { Garment } from '../lib/queries.js';
import { go } from '../lib/route.js';
import { routeHash } from '../lib/router.js';
import { useRefreshFailure, useScreenChrome } from '../lib/shell.js';
import { SLOTS } from '../lib/vocab.js';

type Gap = { id: string; because: string; slots: readonly string[]; needs: string | null };

function orList(words: readonly string[]) {
  if (words.length < 2) return words[0];
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/**
 * A gap says what is short in one of two ways, and never both. A rule asking
 * for a garment names the thing, and one about how a garment must look can only
 * name the slots where nothing owned passes.
 *
 * The slots are named with the bare words the tiles and the filter chips on
 * this screen already use, so tapping one shows exactly the garments the
 * sentence is about.
 */
function shortOf(gap: Gap) {
  if (gap.needs !== null) return `You do not own ${gap.needs}.`;
  return `Nothing you own in ${orList(gap.slots)} works for this.`;
}

/** A row the screen cannot draw is dropped rather than drawn half empty. */
function readable(gap: unknown): gap is Gap {
  if (gap === null || typeof gap !== 'object') return false;
  const row = gap as Record<string, unknown>;
  return (
    typeof row['id'] === 'string' &&
    typeof row['because'] === 'string' &&
    Array.isArray(row['slots']) &&
    row['slots'].length > 0 &&
    row['slots'].every((slot) => typeof slot === 'string') &&
    (row['needs'] === null || typeof row['needs'] === 'string')
  );
}

function Tile({ garment }: { garment: Garment }) {
  // Two different jobs, so two different dots: a hollow one waits on Claude,
  // a filled one waits on the user.
  const state = tagState(garment);
  return (
    <a className="tile" href={routeHash('review', garment.id)}>
      <Photo src={imagePath(garment)}>
        {state === 'untagged' && <span className="tile__dot tile__dot--untagged" title="not tagged yet" />}
        {state === 'unconfirmed' && <span className="tile__dot" title="tagged, not confirmed" />}
      </Photo>
      <span className="tile__name">{garment.subtype}</span>
      <span className="tile__slot">{garment.slot}</span>
    </a>
  );
}

/**
 * What this wardrobe can never do, said once here rather than on every outfit
 * card. The outfit cards drop these, so this is the only place they are said,
 * and it sits under the grid because it is something to read now and then and
 * not something to act on today.
 */
function Gaps({ found }: { found: Gap[] }) {
  if (found.length === 0) return null;
  return (
    <section className="section section--missed">
      <h3 className="section__title">What this wardrobe cannot do</h3>
      <p className="source">Left off every outfit card</p>
      <ul className="rules rules--missed">
        {found.map((gap) => (
          // What is short leads, because that is the part worth acting on. The
          // guide's own sentence follows as the reason for it, the way it reads
          // on a card, and it is quieter here than the shortfall.
          <li className="rule" key={gap.id}>
            <p className="rule__short">{shortOf(gap)}</p>
            <p className="rule__because">{gap.because}</p>
            <span className="rule__id">{gap.id}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Wardrobe() {
  const [slot, setSlot] = useState('all');
  const garments = useQuery(garmentsQuery);

  /**
   * Its own query, and its own failure. A wardrobe nobody can read is the
   * screen being broken, while gaps nobody can read is one section missing, so
   * a fault here leaves the clothes on screen instead of taking them down.
   */
  const gaps = useQuery({
    queryKey: gapsKey,
    queryFn: () => api.listGaps(),
  });

  useRefreshFailure(garments);

  const rows = garments.data ?? [];
  useScreenChrome({
    title: 'Wardrobe',
    meta: garments.data === undefined ? '' : rows.length === 1 ? '1 piece' : `${rows.length} pieces`,
    refresh: () => {
      void garments.refetch();
      void gaps.refetch();
    },
  });

  if (garments.isPending) {
    return (
      <Screen>
        <Empty text="Loading." />
      </Screen>
    );
  }

  // Only with nothing behind it. A Refresh that fails keeps the wardrobe on
  // screen and says so in a line, the way the other reads do.
  if (garments.isError && garments.data === undefined) {
    return (
      <Screen>
        <Empty text={garments.error.message} action={<TryAgain onRetry={() => void garments.refetch()} />} />
      </Screen>
    );
  }

  const counts = new Map<string, number>();
  for (const garment of rows) counts.set(garment.slot, (counts.get(garment.slot) ?? 0) + 1);
  const chips = [{ value: 'all', label: `all ${rows.length}` }];
  for (const name of SLOTS) {
    const count = counts.get(name) ?? 0;
    if (count > 0) chips.push({ value: name, label: `${name} ${count}` });
  }

  const shown = rows.filter((garment) => slot === 'all' || garment.slot === slot);
  const { untagged, unconfirmed } = countTagStates(rows);
  const found = (gaps.data?.gaps ?? []).filter(readable);

  return (
    <Screen>
      <div className="banner">
        {untagged > 0 && (
          <div className="note">
            <p className="note__text">
              {untagged === 1
                ? '1 garment has no tags. Ask Claude to tag it through the connector.'
                : `${untagged} garments have no tags. Ask Claude to tag them through the connector.`}
            </p>
            <button className="btn btn--small btn--ghost" type="button" onClick={() => go('#/review')}>
              {untagged === 1 ? 'Tag it by hand' : 'Tag them by hand'}
            </button>
          </div>
        )}
        {unconfirmed > 0 && (
          <button className="btn btn--primary btn--wide" type="button" onClick={() => go('#/review')}>
            {unconfirmed === 1 ? '1 garment to confirm' : `${unconfirmed} garments to confirm`}
          </button>
        )}
      </div>

      <div className="filters">
        {chips.map((chip) => (
          <button
            className="filter"
            type="button"
            key={chip.value}
            aria-pressed={chip.value === slot}
            onClick={() => setSlot(chip.value)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="grid">
        {shown.length === 0 ? (
          <p className="empty__text">{slot === 'all' ? 'No garments yet.' : `Nothing in ${slot}.`}</p>
        ) : (
          shown.map((garment) => <Tile garment={garment} key={garment.id} />)
        )}
      </div>

      <div className="gaps">{gaps.isSuccess && <Gaps found={found} />}</div>
    </Screen>
  );
}
