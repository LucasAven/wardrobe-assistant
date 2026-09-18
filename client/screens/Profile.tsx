import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
} from '../lib/body.js';
import type { ChipOption, MirrorQuestion } from '../lib/body.js';
import { askPosition, positionLine } from '../lib/geo.js';
import { api, profileKey, profileQuery, queryClient } from '../lib/queries.js';
import type { ProfileData } from '../lib/queries.js';
import { go } from '../lib/route.js';
import { useScreenChrome, useShell } from '../lib/shell.js';
import { useWrite } from '../lib/write.js';

/** The two waits behind one tap, so the button says which one it is in. */
const HOME_STEP_LABEL = { asking: 'Asking', saving: 'Saving' };

/** What a missing position costs here. The owner asked for it, so it is said out loud. */
const NO_POSITION: Record<string, string> = {
  denied: 'Location is off for this app, so there is no home to save.',
  unsupported: 'This browser cannot give a location, so there is no home to save.',
  timeout: 'Finding you took too long, so the home was not saved.',
  unknown: 'Your location did not come back, so the home was not saved.',
};

type Answers = Record<string, string | boolean | null>;

function encodeBoolean(value: unknown) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return null;
}

/**
 * A one-choice chip row. Radios rather than buttons, so the browser owns which
 * one is selected.
 */
function ChipChoice({
  name,
  options,
  value,
  onPick,
}: {
  name: string;
  options: ChipOption[];
  value: string | null;
  onPick: (value: string) => void;
}) {
  return (
    <div className="chips">
      {options.map((option) => (
        <label className="chip" htmlFor={`c-${name}-${option.value}`} key={option.value}>
          <input
            type="radio"
            className="chip__input"
            name={name}
            id={`c-${name}-${option.value}`}
            value={option.value}
            checked={option.value === value}
            onChange={() => onPick(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <main className="screen">
      <section className="screen__body">{children}</section>
    </main>
  );
}

function ProfileForm({ stored }: { stored: ProfileData }) {
  const { toast } = useShell();
  const [answers, setAnswers] = useState<Answers>(() =>
    stored.profile === null
      ? emptyObservations()
      : {
          shouldersVsHips: stored.profile.shouldersVsHips,
          waistIsWidest: stored.profile.waistIsWidest,
          volume: stored.profile.volume,
          line: stored.profile.line,
          thinLegs: stored.profile.thinLegs,
        },
  );
  const [language, setLanguage] = useState<string>(() => stored.profile?.language ?? DEFAULT_LANGUAGE);
  /**
   * Null, or the step the one home control is in. Kept as its own state rather
   * than derived from the write: asking comes first and is not a write, and a
   * derived step reads null for the render between the two.
   */
  const [homeStep, setHomeStep] = useState<'asking' | 'saving' | null>(null);
  const [saveLabel] = useState(stored.profile === null ? 'Save profile' : 'Save changes');

  /**
   * The server derives the suggestion, so its answer wins while the questions on
   * screen still match the ones it saw. Deriving here too is what makes the type
   * appear as the fifth question is answered, with no round trip.
   */
  function suggestionFor(rows: Answers) {
    if (stored.suggestedType !== null && sameObservations(rows, stored.profile)) return stored.suggestedType;
    return deriveBodyType(rows);
  }

  /** Set only when the user picks a type the answers do not imply. Kept, because that is why both are stored. */
  const [override, setOverride] = useState<string | null>(() =>
    stored.profile !== null && stored.profile.bodyType !== suggestionFor(answers) ? stored.profile.bodyType : null,
  );

  const suggested = suggestionFor(answers);
  const chosen = override ?? suggested;
  const left = unanswered(answers).length;
  const complete = isComplete(answers);
  const type = BODY_TYPES.find((entry) => entry.value === chosen) ?? null;
  /** Both home writes answer the whole profile, so the card redraws from the reply. */
  function applyHome(body: unknown, done: string) {
    queryClient.setQueryData(profileKey, readProfile(body));
    toast(done);
  }

  const saveHome = useWrite({
    mutationFn: (at: { lat: number; lon: number }) => api.saveHome(at.lat, at.lon),
    onSuccess: (body) => applyHome(body, 'Home saved.'),
    onSettled: () => setHomeStep(null),
  });

  const clearHome = useWrite({
    mutationFn: () => api.clearHome(),
    onSuccess: (body) => applyHome(body, 'Home forgotten.'),
    onSettled: () => setHomeStep(null),
  });

  const working = homeStep === null ? null : HOME_STEP_LABEL[homeStep];

  async function useHere() {
    if (homeStep !== null) return;
    setHomeStep('asking');

    // The owner just tapped this, which is a newer answer than a denial
    // remembered on the Today screen days ago, so that one does not stop it.
    const position = await askPosition({ remembered: false });
    if (!position.found) {
      setHomeStep(null);
      toast(NO_POSITION[position.cause] ?? NO_POSITION['unknown'] ?? '', 'error');
      return;
    }
    // Set before the write starts, because React Query reports `isPending`
    // through a scheduler and the label would blink back to idle in between.
    setHomeStep('saving');
    saveHome.mutate({ lat: position.lat, lon: position.lon });
  }

  const submit = useWrite({
    mutationFn: () => api.saveProfile(profileBody(answers, chosen, language)),
    onSuccess: (body) => {
      const first = stored.profile === null;
      const next = readProfile(body);
      queryClient.setQueryData(profileKey, next);
      // A saved profile is the only thing standing between the user and the
      // screen they came for, so the first save walks them there.
      if (first) {
        go('#/today');
        return;
      }
      setOverride(next.suggestedType === next.profile?.bodyType ? null : (next.profile?.bodyType ?? null));
      toast('Profile saved.');
    },
  });

  return (
    <Body>
      <section className="card">
        <h2 className="card__title">Look in a mirror first</h2>
        <ol className="protocol">
          {MIRROR_PROTOCOL.map((step) => (
            <li className="protocol__step" key={step}>
              {step}
            </li>
          ))}
        </ol>
        <p className="field__hint">The book classifies by looking, so the app asks for no measurement.</p>
      </section>

      {MIRROR_QUESTIONS.map((question: MirrorQuestion) => (
        <section className="question" key={question.name}>
          <div className="question__head">
            <h3 className="question__label">{question.label}</h3>
            {question.hint !== undefined && <p className="field__hint">{question.hint}</p>}
          </div>
          <ChipChoice
            name={question.name}
            options={question.options}
            value={
              question.type === 'boolean'
                ? encodeBoolean(answers[question.name])
                : ((answers[question.name] as string | null) ?? null)
            }
            onPick={(value) =>
              setAnswers((rows) => ({ ...rows, [question.name]: question.type === 'boolean' ? value === 'true' : value }))
            }
          />
        </section>
      ))}

      <section className="card result">
        <div className="result__body">
          {type === null ? (
            <p className="empty__text">
              {left === 1
                ? 'One question left, then the type appears here.'
                : `${left} questions left, then the type appears here.`}
            </p>
          ) : (
            <>
              <h2 className="result__type">{type.label}</h2>
              <p className="result__description">{type.description}</p>
              {type.aside !== null && <p className="field__hint">{type.aside}</p>}
              <p className="result__creed">{NO_SHAPE_IS_BAD}</p>

              <div className="field">
                <div className="field__head">
                  <label className="field__label" htmlFor="body-type">
                    Stored as
                  </label>
                </div>
                <select
                  className="control control--select"
                  id="body-type"
                  value={chosen ?? ''}
                  onChange={(event) => setOverride(event.target.value === suggested ? null : event.target.value)}
                >
                  {BODY_TYPES.map((entry) => (
                    <option value={entry.value} key={entry.value}>
                      {entry.label}
                    </option>
                  ))}
                </select>
                <p className="field__hint">
                  The app keeps the type and the answers apart, so a wrong call can be fixed here.
                </p>
              </div>

              {suggested !== null && suggested !== chosen && (
                <div className="note">
                  <p className="note__text">
                    {`Your answers point at ${bodyTypeLabel(suggested)}, and this is stored as ${bodyTypeLabel(chosen)}.`}
                  </p>
                  <button className="btn btn--small btn--ghost" type="button" onClick={() => setOverride(null)}>
                    {`Use ${bodyTypeLabel(suggested)}`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="question">
        <div className="question__head">
          <h3 className="question__label">Language of the outfit rationale</h3>
        </div>
        <ChipChoice name="language" options={LANGUAGES} value={language} onPick={setLanguage} />
      </section>

      <section className="card">
        <h2 className="card__title">Home for the weather</h2>
        <div className="card__body">
          {stored.home === null ? (
            <>
              <p className="card__line">
                Until this is set, Claude has to be told the temperature on every plan you ask for.
              </p>
              <button className="btn btn--small" type="button" disabled={working !== null} onClick={() => void useHere()}>
                {working ?? 'Use where I am now'}
              </button>
            </>
          ) : (
            <>
              <p className="card__line">Claude reads the weather here by itself.</p>
              <p className="card__line">{positionLine(stored.home)}</p>
              <button className="btn btn--small" type="button" disabled={working !== null} onClick={() => void useHere()}>
                {working ?? 'Update it'}
              </button>
              <button
                className="btn btn--small btn--ghost"
                type="button"
                disabled={working !== null}
                onClick={() => {
                  setHomeStep('saving');
                  clearHome.mutate();
                }}
              >
                Forget it
              </button>
            </>
          )}
        </div>
      </section>

      <div className="actionbar">
        <p className="actionbar__count">
          {complete
            ? stored.profile === null
              ? 'Saved once, changed whenever you want'
              : ''
            : left === 1
              ? '1 question to answer'
              : `${left} questions to answer`}
        </p>
        <button
          className="btn btn--primary btn--wide"
          type="button"
          disabled={!complete || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? 'Saving' : saveLabel}
        </button>
      </div>
    </Body>
  );
}

export function Profile() {
  useScreenChrome({ title: 'Profile' });
  const profile = useQuery(profileQuery);

  if (profile.isPending) {
    return (
      <Body>
        <div className="empty">
          <p className="empty__text">Loading your profile.</p>
        </div>
      </Body>
    );
  }

  if (profile.isError) {
    return (
      <Body>
        <div className="empty">
          <p className="empty__text">{profile.error.message}</p>
          <button className="btn btn--primary" type="button" onClick={() => void profile.refetch()}>
            Try again
          </button>
        </div>
      </Body>
    );
  }

  return <ProfileForm stored={profile.data} />;
}
