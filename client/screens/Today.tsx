import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { OutfitSet } from './OutfitSet.js';
import { askPosition } from '../lib/geo.js';
import { savedClock, todayView } from '../lib/outfits.js';
import { forgetPref } from '../lib/prefs.js';
import { api, profileQuery, todayKey, weatherKey } from '../lib/queries.js';
import { go } from '../lib/route.js';
import { useScreenChrome } from '../lib/shell.js';
import { readWeather, weatherLine } from '../lib/weather.js';

/** What a missing position costs this screen, said once per cause. */
const NO_POSITION: Record<string, string> = {
  denied: 'Location is off for this app, so there is no weather to show.',
  unsupported: 'This browser cannot give a location, so there is no weather to show.',
  timeout: 'Finding you took too long, so there is no weather to show.',
  unknown: 'Your location did not come back, so there is no weather to show.',
};

type Position = { lat: number; lon: number };

function Weather() {
  const [located, setLocated] = useState<Position | null>(null);
  const [note, setNote] = useState('Getting the weather where you are.');
  /** Bumped by the button, which is the only thing that asks a second time. */
  const [asks, setAsks] = useState(0);

  /** Asked once on mount, and never waited on. */
  useEffect(() => {
    let live = true;
    void askPosition().then((result) => {
      if (!live) return;
      if (result.found) {
        setLocated({ lat: result.lat, lon: result.lon });
        setNote('Reading the weather where you are.');
      } else {
        setLocated(null);
        setNote(NO_POSITION[result.cause] ?? NO_POSITION['unknown'] ?? '');
      }
    });
    return () => {
      live = false;
    };
  }, [asks]);

  const forecast = useQuery({
    queryKey: located === null ? ['weather', 'none'] : weatherKey(located.lat, located.lon),
    enabled: located !== null,
    queryFn: async () => readWeather(await api.getWeather(located?.lat, located?.lon)),
  });

  const reading = forecast.data ?? null;

  return (
    <section className="card">
      <h2 className="card__title">Weather</h2>
      <div className="card__body">
        {reading !== null ? (
          <>
            <p className="card__weather">{weatherLine(reading)}</p>
            <p className="card__line">From where you are.</p>
          </>
        ) : (
          <>
            {/* Nothing downstream reads the weather any more, so a failed read
                costs this card a line of text and nothing else. */}
            <p className="card__line">{forecast.isError ? 'The weather did not come back.' : note}</p>
            {located === null && (
              <button
                className="btn btn--small btn--ghost"
                type="button"
                onClick={() => {
                  forgetPref('location');
                  setNote('Asking for your location.');
                  setAsks((at) => at + 1);
                }}
              >
                Use my location
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function Today() {
  const today = useQuery({ queryKey: todayKey, queryFn: () => api.getTodayOutfits() });
  useScreenChrome({ title: 'Today', refresh: () => void today.refetch() });

  // The profile is a nudge on this screen, not a gate. A failed read stays quiet.
  const profile = useQuery(profileQuery);

  const view = today.data === undefined ? null : todayView(today.data);

  return (
    <main className="screen">
      <section className="screen__body">
        <div className="banner">
          {profile.data?.profile == null && profile.isSuccess && (
            <>
              <p className="card__line">The book needs your body type before Claude can style you.</p>
              <button className="btn btn--primary btn--wide" type="button" onClick={() => go('#/profile')}>
                Set up the profile
              </button>
            </>
          )}
        </div>

        <Weather />

        <div className="stack">
          {today.isPending && (
            <div className="empty">
              <p className="empty__text">Looking for the outfit Claude saved.</p>
            </div>
          )}

          {today.isError && (
            <div className="empty">
              <p className="empty__text">{today.error.message}</p>
              <button className="btn btn--primary" type="button" onClick={() => void today.refetch()}>
                Try again
              </button>
            </div>
          )}

          {view !== null && view.kind !== 'sets' && (
            <section className="card">
              <h2 className="card__title">{view.title}</h2>
              <p className="card__line">{view.detail}</p>
              <button className="btn btn--wide" type="button" onClick={() => void today.refetch()}>
                Check again
              </button>
            </section>
          )}

          {/* One card for an outfit saved on its own, one pager for a set of
              options, and the sets decide which of the two. The screen hands
              every group over the same way, so it never asks how many outfits
              are in one. */}
          {view !== null &&
            view.kind === 'sets' &&
            view.sets.map((set) => {
              // The time the first option landed, which is when the set was
              // composed. The rest were saved in the same turn, seconds behind.
              const clock = savedClock(set.outfits[0]?.createdAt);
              return (
                <OutfitSet
                  outfits={set.outfits}
                  caption="Today"
                  meta={clock === '' ? '' : `saved ${clock}`}
                  // Read again rather than cleared here. The screen keeps no
                  // outfit of its own, so asking once more is the only thing
                  // that reaches its empty state.
                  onRemoved={() => void today.refetch()}
                  // The ids, not the set, so removing one option rebuilds the
                  // pager rather than leaving it on "Option 3 of 2".
                  key={set.outfits.map((outfit) => outfit.id).join()}
                />
              );
            })}
        </div>
      </section>
    </main>
  );
}
