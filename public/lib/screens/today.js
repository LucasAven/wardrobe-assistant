import { chipChoice } from '../choice.js';
import { append, button, clear, el } from '../dom.js';
import {
  DEFAULT_EVENT,
  DEFAULT_HOURS_OUTDOORS,
  EVENTS,
  OUTDOORS,
  TIMES_OF_DAY,
  buildRecommendRequest,
  defaultTimeOfDay,
  locatedWeather,
  parseTemperature,
  readWeather,
  typedWeather,
  weatherLine,
  weatherReady,
} from '../moment.js';
import { forgetPref, readChoice, readNumberChoice, writePref } from '../prefs.js';

const GEO_TIMEOUT_MS = 8000;
/** A position from earlier this morning is good enough, and it saves the second wait. */
const GEO_MAX_AGE_MS = 10 * 60 * 1000;

function geoFailure(error) {
  if (error?.code === 1) return 'Location is off. Type the temperature instead.';
  if (error?.code === 3) return 'Finding you took too long. Type the temperature instead.';
  return 'Your location did not come back. Type the temperature instead.';
}

/**
 * Asked once, and never waited on. A denial is remembered so tomorrow morning
 * opens straight on the two fields that replace it.
 */
function askLocation() {
  return new Promise((resolve) => {
    if (readChoice('location', ['off'], null) === 'off') {
      resolve({ source: 'off', reason: 'Location is off for this app. Type the temperature instead.' });
      return;
    }

    const geolocation = globalThis.navigator?.geolocation ?? null;
    if (geolocation === null) {
      resolve({ source: 'off', reason: 'This browser cannot give a location. Type the temperature instead.' });
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
  const eventValues = EVENTS.map((entry) => entry.value);
  const hourValues = OUTDOORS.map((entry) => entry.value);

  let event = readChoice('event', eventValues, DEFAULT_EVENT);
  let timeOfDay = defaultTimeOfDay();
  let hoursOutdoors = readNumberChoice('hours', hourValues, DEFAULT_HOURS_OUTDOORS);
  let mood = '';

  let located = null;
  let locating = null;
  let forecast = null;
  let manual = false;
  let manualNote = 'Getting the weather where you are.';
  let rain = false;
  let busy = false;
  let gone = false;

  const weatherBody = el('div', { class: 'card__body' });
  const banner = el('div', { class: 'banner' });

  const temperature = el('input', {
    class: 'control control--text control--temp',
    id: 'temp',
    type: 'text',
    inputmode: 'decimal',
    enterkeyhint: 'done',
    placeholder: '18',
    autocomplete: 'off',
  });

  const moodInput = el('input', {
    class: 'control control--text',
    id: 'mood',
    type: 'text',
    placeholder: 'anything on your mind',
    enterkeyhint: 'done',
    autocapitalize: 'none',
  });
  moodInput.addEventListener('input', () => {
    mood = moodInput.value;
  });

  const ask = button('What do I wear', { class: 'btn btn--primary btn--wide btn--big' });

  function currentWeather() {
    if (manual) return typedWeather(parseTemperature(temperature.value), rain);
    return located;
  }

  function renderWeather() {
    clear(weatherBody);

    if (!manual) {
      const line = located === null ? manualNote : forecast === null ? 'Weather from where you are.' : weatherLine(forecast);
      append(
        weatherBody,
        el('p', { class: forecast === null || located === null ? 'card__line' : 'card__weather' }, line),
        forecast === null || located === null ? null : el('p', { class: 'card__line' }, 'From where you are.'),
        button('Type it instead', {
          class: 'btn btn--small btn--ghost',
          onclick: () => {
            manual = true;
            renderWeather();
          },
        }),
      );
      return;
    }

    const rainBox = el('input', { type: 'checkbox', class: 'switch__input', id: 'rain', checked: rain });
    rainBox.addEventListener('change', () => {
      rain = rainBox.checked;
    });

    append(
      weatherBody,
      located === null && manualNote !== '' ? el('p', { class: 'card__line' }, manualNote) : null,
      el('div', { class: 'temp' }, [
        el('label', { class: 'field__label', for: 'temp' }, 'Temperature'),
        el('div', { class: 'temp__row' }, [temperature, el('span', { class: 'temp__unit' }, '°C')]),
      ]),
      el('label', { class: 'switch', for: 'rain' }, [
        rainBox,
        el('span', { class: 'switch__body' }, [
          el('span', { class: 'switch__label' }, 'Rain today'),
          el('span', { class: 'switch__hint' }, 'On means take it as a wet day.'),
        ]),
      ]),
      button(located === null ? 'Use my location' : 'Back to my location', {
        class: 'btn btn--small btn--ghost',
        onclick: () => {
          if (located !== null) {
            manual = false;
            renderWeather();
            return;
          }
          forgetPref('location');
          manualNote = 'Asking for your location.';
          manual = false;
          renderWeather();
          startLocating();
        },
      }),
    );
  }

  /**
   * The numbers are shown, never sent: the request travels as a location and
   * the Worker reads the weather itself. So a read that fails costs a line of
   * text and nothing else.
   */
  function showForecast(position) {
    ctx.api
      .getWeather(position.lat, position.lon)
      .then((body) => {
        const weather = readWeather(body);
        if (gone || weather === null) return;
        forecast = weather;
        renderWeather();
      })
      .catch(() => {
        // Nothing to say: the plain line stays and the moment still travels as a location.
      });
  }

  function startLocating() {
    locating = askLocation().then((result) => {
      if (gone) return result;
      if (result.source === 'location') {
        located = result;
        manualNote = '';
        showForecast(result);
      } else {
        located = null;
        manualNote = result.reason;
        // Never block on it: the fields that replace the location open by themselves.
        manual = true;
      }
      renderWeather();
      return result;
    });
  }

  async function submit() {
    if (busy) return;
    busy = true;
    ask.disabled = true;
    const label = ask.textContent;

    try {
      if (!manual && located === null && locating !== null) {
        ask.textContent = 'Getting the weather';
        await locating;
      }

      const weather = currentWeather();
      if (!weatherReady(weather)) {
        ctx.toast('Type the temperature first.');
        temperature.focus();
        return;
      }

      writePref('event', event);
      writePref('hours', hoursOutdoors);
      ctx.moment.set(buildRecommendRequest({ event, timeOfDay, hoursOutdoors, mood, weather }));
      ctx.go('#/outfits');
    } finally {
      busy = false;
      ask.disabled = false;
      ask.textContent = label;
    }
  }

  ask.addEventListener('click', submit);

  function questionBlock(title, row) {
    return el('section', { class: 'question' }, [
      el('div', { class: 'question__head' }, el('h3', { class: 'question__label' }, title)),
      row,
    ]);
  }

  const node = el('section', { class: 'screen__body' }, [
    banner,
    el('section', { class: 'card' }, [el('h2', { class: 'card__title' }, 'Weather'), weatherBody]),
    questionBlock(
      'Where are you going',
      chipChoice({
        name: 'event',
        options: EVENTS,
        value: event,
        onPick: (value) => {
          event = value;
        },
      }),
    ),
    questionBlock(
      'Time of day',
      chipChoice({
        name: 'timeOfDay',
        options: TIMES_OF_DAY,
        value: timeOfDay,
        onPick: (value) => {
          timeOfDay = value;
        },
      }),
    ),
    questionBlock(
      'Hours outdoors',
      chipChoice({
        name: 'hours',
        options: OUTDOORS,
        value: hoursOutdoors,
        onPick: (value) => {
          hoursOutdoors = value;
        },
      }),
    ),
    el('div', { class: 'field field--quiet' }, [
      el('label', { class: 'field__label', for: 'mood' }, 'Mood, if it matters'),
      moodInput,
    ]),
    el('div', { class: 'actionbar' }, ask),
  ]);

  function renderBanner(profile) {
    clear(banner);
    if (profile !== null) return;
    banner.append(
      el('p', { class: 'card__line' }, 'The book needs your body type before it can style you.'),
      button('Set up the profile', { class: 'btn btn--primary btn--wide', onclick: () => ctx.go('#/profile') }),
    );
  }

  renderWeather();
  startLocating();

  ctx.profile
    .ensure()
    .then((stored) => {
      if (!gone) renderBanner(stored.profile);
    })
    .catch(() => {
      // The profile is a nudge on this screen, not a gate. A failed read stays quiet.
    });

  ctx.setTitle('Today', '');
  return {
    node,
    destroy() {
      gone = true;
    },
  };
}
