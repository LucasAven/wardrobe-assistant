import { append, button, clear, el } from '../dom.js';
import { askPosition } from '../geo.js';
import { outfitCard } from '../outfitcard.js';
import { savedClock, todayView } from '../outfits.js';
import { forgetPref } from '../prefs.js';
import { readWeather, weatherLine } from '../weather.js';

/** What a missing position costs this screen, said once per cause. */
const NO_POSITION = {
  denied: 'Location is off for this app, so there is no weather to show.',
  unsupported: 'This browser cannot give a location, so there is no weather to show.',
  timeout: 'Finding you took too long, so there is no weather to show.',
  unknown: 'Your location did not come back, so there is no weather to show.',
};

export function mountToday(ctx) {
  let located = null;
  let forecast = null;
  let note = 'Getting the weather where you are.';
  let gone = false;

  const banner = el('div', { class: 'banner' });
  const weatherBody = el('div', { class: 'card__body' });
  const body = el('div', { class: 'stack' });

  function renderWeather() {
    clear(weatherBody);

    if (forecast !== null) {
      append(
        weatherBody,
        el('p', { class: 'card__weather' }, weatherLine(forecast)),
        el('p', { class: 'card__line' }, 'From where you are.'),
      );
      return;
    }

    append(
      weatherBody,
      el('p', { class: 'card__line' }, note),
      located !== null
        ? null
        : button('Use my location', {
            class: 'btn btn--small btn--ghost',
            onclick: () => {
              forgetPref('location');
              note = 'Asking for your location.';
              renderWeather();
              startLocating();
            },
          }),
    );
  }

  function showForecast(position) {
    ctx.api
      .getWeather(position.lat, position.lon)
      .then((response) => {
        const weather = readWeather(response);
        if (gone || weather === null) return;
        forecast = weather;
        renderWeather();
      })
      .catch(() => {
        // Nothing downstream reads the weather any more, so a failed read costs
        // this card a line of text and nothing else.
        if (gone) return;
        note = 'The weather did not come back.';
        renderWeather();
      });
  }

  /** Asked once on mount, and never waited on. */
  function startLocating() {
    askPosition().then((result) => {
      if (gone) return;
      if (result.found) {
        located = result;
        note = 'Reading the weather where you are.';
        showForecast(result);
      } else {
        located = null;
        note = NO_POSITION[result.cause];
      }
      renderWeather();
    });
  }

  function show(...children) {
    clear(body);
    append(body, ...children);
  }

  function showEmpty(view) {
    show(
      el('section', { class: 'card' }, [
        el('h2', { class: 'card__title' }, view.title),
        el('p', { class: 'card__line' }, view.detail),
        button('Check again', { class: 'btn btn--wide', onclick: load }),
      ]),
    );
  }

  function showOutfit(outfit) {
    const clock = savedClock(outfit.createdAt);
    show(
      outfitCard(ctx, outfit, {
        caption: 'Today',
        meta: clock === '' ? '' : `saved ${clock}`,
        // Read again rather than cleared here. The screen keeps no outfit of
        // its own, so asking once more is the only thing that reaches its
        // empty state.
        onRemoved: load,
      }),
    );
  }

  async function load() {
    show(el('div', { class: 'empty' }, el('p', { class: 'empty__text' }, 'Looking for the outfit Claude saved.')));
    try {
      const view = todayView(await ctx.api.getTodayOutfit());
      if (gone) return;
      if (view.kind === 'outfit') showOutfit(view.outfit);
      else showEmpty(view);
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

  function renderBanner(profile) {
    clear(banner);
    if (profile !== null) return;
    banner.append(
      el('p', { class: 'card__line' }, 'The book needs your body type before Claude can style you.'),
      button('Set up the profile', { class: 'btn btn--primary btn--wide', onclick: () => ctx.go('#/profile') }),
    );
  }

  const node = el('section', { class: 'screen__body' }, [
    banner,
    el('section', { class: 'card' }, [el('h2', { class: 'card__title' }, 'Weather'), weatherBody]),
    body,
    button('Earlier outfits', { class: 'btn btn--ghost btn--wide', onclick: () => ctx.go('#/outfits') }),
  ]);

  renderWeather();
  startLocating();
  load();

  ctx.profile
    .ensure()
    .then((stored) => {
      if (!gone) renderBanner(stored.profile);
    })
    .catch(() => {
      // The profile is a nudge on this screen, not a gate. A failed read stays quiet.
    });

  ctx.setTitle('Today', '');
  ctx.onRefresh(load);
  return {
    node,
    destroy() {
      gone = true;
    },
  };
}
