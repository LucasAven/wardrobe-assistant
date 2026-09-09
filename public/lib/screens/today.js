import { append, button, clear, el } from '../dom.js';
import { outfitCard } from '../outfitcard.js';
import { savedClock, todayView } from '../outfits.js';
import { forgetPref, readChoice, writePref } from '../prefs.js';
import { locatedWeather, readWeather, weatherLine } from '../weather.js';

const GEO_TIMEOUT_MS = 8000;
/** A position from earlier this morning is good enough, and it saves the second wait. */
const GEO_MAX_AGE_MS = 10 * 60 * 1000;

function geoFailure(error) {
  if (error?.code === 1) return 'Location is off for this app, so there is no weather to show.';
  if (error?.code === 3) return 'Finding you took too long, so there is no weather to show.';
  return 'Your location did not come back, so there is no weather to show.';
}

/**
 * Asked once, and never waited on. A denial is remembered so tomorrow morning
 * does not open on the same prompt.
 */
function askLocation() {
  return new Promise((resolve) => {
    if (readChoice('location', ['off'], null) === 'off') {
      resolve({ source: 'off', reason: 'Location is off for this app, so there is no weather to show.' });
      return;
    }

    const geolocation = globalThis.navigator?.geolocation ?? null;
    if (geolocation === null) {
      resolve({ source: 'off', reason: 'This browser cannot give a location, so there is no weather to show.' });
      return;
    }

    geolocation.getCurrentPosition(
      (position) => resolve(locatedWeather(position)),
      (error) => {
        if (error?.code === 1) writePref('location', 'off');
        resolve({ source: 'off', reason: geoFailure(error) });
      },
      { timeout: GEO_TIMEOUT_MS, maximumAge: GEO_MAX_AGE_MS },
    );
  });
}

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

  function startLocating() {
    askLocation().then((result) => {
      if (gone) return;
      if (result.source === 'location') {
        located = result;
        note = 'Reading the weather where you are.';
        showForecast(result);
      } else {
        located = null;
        note = result.reason;
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
    show(outfitCard(ctx, outfit, { title: 'Today', meta: clock === '' ? '' : `saved ${clock}` }));
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
