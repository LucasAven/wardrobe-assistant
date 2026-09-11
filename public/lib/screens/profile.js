import {
  BODY_TYPES,
  DEFAULT_LANGUAGE,
  LANGUAGES,
  MIRROR_PROTOCOL,
  MIRROR_QUESTIONS,
  NO_SHAPE_IS_BAD,
  bodyTypeLabel,
  deriveBodyType,
  emptyObservations,
  isComplete,
  profileBody,
  readProfile,
  sameObservations,
  unanswered,
} from '../body.js';
import { chipChoice } from '../choice.js';
import { append, button, clear, el } from '../dom.js';
import { askPosition, positionLine } from '../geo.js';

/** The two waits behind one tap, so the button says which one it is in. */
const HOME_STEP_LABEL = { asking: 'Asking', saving: 'Saving' };

/** What a missing position costs here. The owner asked for it, so it is said out loud. */
const NO_POSITION = {
  denied: 'Location is off for this app, so there is no home to save.',
  unsupported: 'This browser cannot give a location, so there is no home to save.',
  timeout: 'Finding you took too long, so the home was not saved.',
  unknown: 'Your location did not come back, so the home was not saved.',
};

export function mountProfile(ctx) {
  const node = el('section', { class: 'screen__body' });
  let gone = false;
  let busy = false;
  /** Null, or the step the one home action is in. */
  let homeStep = null;

  let answers = emptyObservations();
  let language = DEFAULT_LANGUAGE;
  /** Set only when the user picks a type the answers do not imply. Kept, because that is why both are stored. */
  let override = null;
  let stored = { profile: null, suggestedType: null, home: null };

  const resultBody = el('div', { class: 'result__body' });
  const homeBody = el('div', { class: 'card__body' });
  const save = button('Save profile', { class: 'btn btn--primary btn--wide' });
  const saveNote = el('p', { class: 'actionbar__count' });

  function showMessage(text, action = null) {
    clear(node);
    node.append(el('div', { class: 'empty' }, [el('p', { class: 'empty__text' }, text), action]));
  }

  /**
   * The server derives the suggestion, so its answer wins while the questions on
   * screen still match the ones it saw. Deriving here too is what makes the type
   * appear as the fifth question is answered, with no round trip.
   */
  function suggestion() {
    if (stored.suggestedType !== null && sameObservations(answers, stored.profile)) return stored.suggestedType;
    return deriveBodyType(answers);
  }

  function chosenType() {
    return override ?? suggestion();
  }

  function renderResult() {
    clear(resultBody);
    const suggested = suggestion();
    const chosen = chosenType();

    if (chosen === null) {
      const left = unanswered(answers).length;
      resultBody.append(
        el(
          'p',
          { class: 'empty__text' },
          left === 1 ? 'One question left, then the type appears here.' : `${left} questions left, then the type appears here.`,
        ),
      );
      return;
    }

    const type = BODY_TYPES.find((entry) => entry.value === chosen);
    append(
      resultBody,
      el('h2', { class: 'result__type' }, type.label),
      el('p', { class: 'result__description' }, type.description),
      type.aside === null ? null : el('p', { class: 'field__hint' }, type.aside),
      el('p', { class: 'result__creed' }, NO_SHAPE_IS_BAD),
    );

    const select = el(
      'select',
      { class: 'control control--select', id: 'body-type' },
      BODY_TYPES.map((entry) => el('option', { value: entry.value }, entry.label)),
    );
    select.value = chosen;
    select.addEventListener('change', () => {
      override = select.value === suggestion() ? null : select.value;
      renderResult();
      refreshSave();
    });

    resultBody.append(
      el('div', { class: 'field' }, [
        el('div', { class: 'field__head' }, el('label', { class: 'field__label', for: 'body-type' }, 'Stored as')),
        select,
        el('p', { class: 'field__hint' }, 'The app keeps the type and the answers apart, so a wrong call can be fixed here.'),
      ]),
    );

    if (suggested !== null && suggested !== chosen) {
      resultBody.append(
        el('div', { class: 'note' }, [
          el('p', { class: 'note__text' }, `Your answers point at ${bodyTypeLabel(suggested)}, and this is stored as ${bodyTypeLabel(chosen)}.`),
          button(`Use ${bodyTypeLabel(suggested)}`, {
            class: 'btn btn--small btn--ghost',
            onclick: () => {
              override = null;
              renderResult();
              refreshSave();
            },
          }),
        ]),
      );
    }
  }

  function renderHome() {
    clear(homeBody);
    const working = homeStep === null ? null : HOME_STEP_LABEL[homeStep];

    if (stored.home === null) {
      append(
        homeBody,
        el(
          'p',
          { class: 'card__line' },
          'Until this is set, Claude has to be told the temperature on every plan you ask for.',
        ),
        button(working ?? 'Use where I am now', {
          class: 'btn btn--small',
          disabled: working !== null,
          onclick: useHere,
        }),
      );
      return;
    }

    append(
      homeBody,
      el('p', { class: 'card__line' }, 'Claude reads the weather here by itself.'),
      el('p', { class: 'card__line' }, positionLine(stored.home)),
      button(working ?? 'Update it', {
        class: 'btn btn--small',
        disabled: working !== null,
        onclick: useHere,
      }),
      button('Forget it', { class: 'btn btn--small btn--ghost', disabled: working !== null, onclick: forget }),
    );
  }

  /** Both writes answer the whole profile, so the card redraws from the reply. */
  async function applyHome(call, done) {
    homeStep = 'saving';
    renderHome();

    try {
      stored = readProfile(await call());
      ctx.profile.set(stored);
      if (!gone) ctx.toast(done);
    } catch (error) {
      if (!gone) ctx.toast(error.message, 'error');
    } finally {
      homeStep = null;
      if (!gone) renderHome();
    }
  }

  async function useHere() {
    if (homeStep !== null) return;
    homeStep = 'asking';
    renderHome();

    // The owner just tapped this, which is a newer answer than a denial
    // remembered on the Today screen days ago, so that one does not stop it.
    const position = await askPosition({ remembered: false });
    if (gone) return;
    if (!position.found) {
      homeStep = null;
      renderHome();
      ctx.toast(NO_POSITION[position.cause], 'error');
      return;
    }

    await applyHome(() => ctx.api.saveHome(position.lat, position.lon), 'Home saved.');
  }

  function forget() {
    if (homeStep === null) applyHome(() => ctx.api.clearHome(), 'Home forgotten.');
  }

  function refreshSave() {
    const complete = isComplete(answers);
    save.disabled = !complete || busy;
    if (!complete) {
      const left = unanswered(answers).length;
      saveNote.textContent = left === 1 ? '1 question to answer' : `${left} questions to answer`;
      return;
    }
    saveNote.textContent = stored.profile === null ? 'Saved once, changed whenever you want' : '';
  }

  function questionBlock(question) {
    const head = el('div', { class: 'question__head' }, [
      el('h3', { class: 'question__label' }, question.label),
      question.hint === undefined ? null : el('p', { class: 'field__hint' }, question.hint),
    ]);

    const row = chipChoice({
      name: question.name,
      options: question.options,
      value: question.type === 'boolean' ? encodeBoolean(answers[question.name]) : answers[question.name],
      onPick: (value) => {
        answers = { ...answers, [question.name]: question.type === 'boolean' ? value === 'true' : value };
        renderResult();
        refreshSave();
      },
    });

    return el('section', { class: 'question' }, [head, row]);
  }

  function encodeBoolean(value) {
    if (value === true) return 'true';
    if (value === false) return 'false';
    return null;
  }

  async function submit() {
    if (busy) return;
    const first = stored.profile === null;
    busy = true;
    save.disabled = true;
    const label = save.textContent;
    save.textContent = 'Saving';

    try {
      const answer = await ctx.api.saveProfile(profileBody(answers, chosenType(), language));
      stored = readProfile(answer);
      ctx.profile.set(stored);
      busy = false;
      if (gone) return;
      // A saved profile is the only thing standing between the user and the
      // screen they came for, so the first save walks them there.
      if (first) {
        ctx.go('#/today');
        return;
      }
      override = stored.suggestedType === stored.profile?.bodyType ? null : (stored.profile?.bodyType ?? null);
      save.textContent = label;
      renderResult();
      refreshSave();
      ctx.toast('Profile saved.');
    } catch (error) {
      busy = false;
      save.textContent = label;
      refreshSave();
      ctx.toast(error.message, 'error');
    }
  }

  function render() {
    clear(node);

    append(
      node,
      el('section', { class: 'card' }, [
        el('h2', { class: 'card__title' }, 'Look in a mirror first'),
        el('ol', { class: 'protocol' }, MIRROR_PROTOCOL.map((step) => el('li', { class: 'protocol__step' }, step))),
        el('p', { class: 'field__hint' }, 'The book classifies by looking, so the app asks for no measurement.'),
      ]),
      ...MIRROR_QUESTIONS.map(questionBlock),
      el('section', { class: 'card result' }, resultBody),
      el('section', { class: 'question' }, [
        el('div', { class: 'question__head' }, [
          el('h3', { class: 'question__label' }, 'Language of the outfit rationale'),
        ]),
        chipChoice({
          name: 'language',
          options: LANGUAGES,
          value: language,
          onPick: (value) => {
            language = value;
          },
        }),
      ]),
      el('section', { class: 'card' }, [
        el('h2', { class: 'card__title' }, 'Home for the weather'),
        homeBody,
      ]),
      el('div', { class: 'actionbar' }, [saveNote, save]),
    );

    renderResult();
    renderHome();
    refreshSave();
  }

  save.addEventListener('click', submit);

  async function load() {
    showMessage('Loading your profile.');
    try {
      stored = await ctx.profile.ensure();
      if (gone) return;
      if (stored.profile !== null) {
        save.textContent = 'Save changes';
        answers = {
          shouldersVsHips: stored.profile.shouldersVsHips,
          waistIsWidest: stored.profile.waistIsWidest,
          volume: stored.profile.volume,
          line: stored.profile.line,
          thinLegs: stored.profile.thinLegs,
        };
        language = stored.profile.language ?? DEFAULT_LANGUAGE;
        override = stored.profile.bodyType === suggestion() ? null : stored.profile.bodyType;
      }
      render();
    } catch (error) {
      if (gone) return;
      showMessage(error.message, button('Try again', { class: 'btn btn--primary', onclick: load }));
    }
  }

  ctx.setTitle('Profile', '');
  load();

  return {
    node,
    destroy() {
      gone = true;
    },
  };
}
