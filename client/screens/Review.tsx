import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Photo } from './Photo.js';
import { Empty, Screen, TryAgain } from './Screen.js';
import { useArmedTap } from '../lib/armed.js';
import { tagState } from '../lib/garments.js';
import { buildPatch, confirmPatch, formatColors, parseColors } from '../lib/patch.js';
import { imagePath } from '../lib/photo.js';
import { api, garmentsKey, garmentsQuery, queryClient, removeGarment, upsertGarment } from '../lib/queries.js';
import type { Garment } from '../lib/queries.js';
import { go } from '../lib/route.js';
import { routeHash } from '../lib/router.js';
import { useRefreshFailure, useScreenChrome, useScreenToast, useShell } from '../lib/shell.js';
import { ANCHORS, FIELDS, FIELD_BY_NAME, isAsked, isRelevant } from '../lib/vocab.js';
import type { Field as FieldSpec } from '../lib/vocab.js';
import { useWrite } from '../lib/write.js';

const ARCHIVE_ARM_MS = 4000;

/** Whose values these are, which is the difference between checking and writing. */
const SOURCE_LINE: Record<string, string | null> = {
  untagged: 'Never tagged. Every field below is a placeholder, so ask Claude to look at the photo.',
  unconfirmed: 'Claude read these off the photo. Fix what is wrong and confirm.',
  reviewed: null,
};

type Draft = Record<string, unknown>;

function encode(field: FieldSpec, value: unknown) {
  if (value === null || value === undefined) return '';
  if (field.type === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function decode(field: FieldSpec, raw: string) {
  if (raw === '') return field.type === 'string' && field.nullable !== true ? '' : null;
  if (field.type === 'boolean') return raw === 'true';
  if (field.type === 'number') return Number(raw);
  return raw;
}

function optionRows(field: FieldSpec) {
  const options = field.options ?? [];
  return options.map((option) => (typeof option === 'string' ? { value: option, label: option } : option));
}

/**
 * Warmth and formality carry the tagger's own scale. Grading against a
 * different scale than the model used is how these two fields end up wrong in a
 * way nothing downstream can detect.
 */
function Anchors({ field, value }: { field: FieldSpec; value: unknown }) {
  const anchor = ANCHORS[field.anchors as 'warmth' | 'formality'];
  return (
    <div className="anchors">
      <p className="anchors__scale">{anchor.scale}</p>
      <ul className="anchors__list">
        {anchor.steps.map((step) => (
          <li className={step.value === value ? 'anchors__step is-current' : 'anchors__step'} key={step.value}>
            <span className="anchors__value">{step.value}</span>
            <span className="anchors__text">{step.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The typed text is the control's own, not a round trip through the draft. A
 * value derived from `parseColors` would swallow the comma the moment it is
 * typed, and a trimmed one would refuse a space between two words.
 */
function TextControl({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [text, setText] = useState(() =>
    field.type === 'colors' ? formatColors((value as string[]) ?? []) : ((value as string) ?? ''),
  );
  const isArea = field.control === 'textarea';

  function edit(next: string) {
    setText(next);
    onChange(field.type === 'colors' ? parseColors(next) : decode(field, next.trim()));
  }

  const shared = {
    className: `control control--${isArea ? 'area' : 'text'}`,
    id: `f-${field.name}`,
    placeholder: field.placeholder,
    autoCapitalize: 'none',
    autoCorrect: 'off',
    spellCheck: false,
    enterKeyHint: 'done' as const,
    value: text,
    onChange: (event: { target: { value: string } }) => edit(event.target.value),
  };

  return isArea ? <textarea {...shared} rows={3} /> : <input {...shared} type="text" />;
}

function ChipsControl({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  onChange: (next: string[]) => void;
}) {
  const rows = optionRows(field);
  const selected = new Set((value as string[] | null) ?? []);

  return (
    <div className="chips">
      {rows.map((option) => (
        <label className="chip" htmlFor={`f-${field.name}-${option.value}`} key={option.value}>
          <input
            type="checkbox"
            className="chip__input"
            id={`f-${field.name}-${option.value}`}
            value={option.value}
            checked={selected.has(option.value)}
            onChange={(event) => {
              const next = new Set(selected);
              if (event.target.checked) next.add(option.value);
              else next.delete(option.value);
              onChange(rows.map((row) => row.value).filter((name) => next.has(name)));
            }}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

function Field({
  field,
  value,
  flagged,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  flagged: boolean;
  onChange: (name: string, next: unknown) => void;
}) {
  return (
    <div className={flagged ? 'field field--flagged' : 'field'} data-field={field.name}>
      <div className="field__head">
        <label className="field__label" htmlFor={`f-${field.name}`}>
          {field.label}
        </label>
        {flagged && <span className="field__flag">check this</span>}
      </div>

      {field.control === 'chips' ? (
        <ChipsControl field={field} value={value} onChange={(next) => onChange(field.name, next)} />
      ) : field.control === 'text' || field.control === 'textarea' ? (
        <TextControl field={field} value={value} onChange={(next) => onChange(field.name, next)} />
      ) : (
        <>
          <select
            className="control control--select"
            id={`f-${field.name}`}
            value={encode(field, value)}
            onChange={(event) => onChange(field.name, decode(field, event.target.value))}
          >
            {field.nullable === true && <option value="">not set</option>}
            {optionRows(field).map((option) => (
              <option value={option.value} key={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {field.anchors !== undefined && <Anchors field={field} value={value} />}
        </>
      )}

      {field.hint !== undefined && <p className="field__hint">{field.hint}</p>}
    </div>
  );
}

function summaryChips(garment: Garment) {
  const seasons = garment.seasons.length === 0 ? 'no season' : garment.seasons.join(', ');
  return [garment.slot, `warmth ${garment.warmth}`, `formality ${garment.formality}`, seasons];
}

/**
 * The route archives rather than deletes, because `wear_log` and the saved
 * outfits hold garment ids and a row that is gone would take the photo out of a
 * look the owner already wore. Two taps, because the only other guard against a
 * mis-tap is undoing it in the database by hand.
 */
function RemoveButton({ busy, onRemove }: { busy: boolean; onRemove: () => void }) {
  const { toast } = useShell();
  const { armed, tap } = useArmedTap({
    ms: ARCHIVE_ARM_MS,
    onArm: () => toast('Outfits you already saved keep this piece and its photo.'),
    onFire: onRemove,
  });

  return (
    <button className="btn btn--small btn--danger" type="button" disabled={busy} onClick={tap}>
      {armed ? 'Tap again to remove' : 'Remove from wardrobe'}
    </button>
  );
}

function ReviewCard({
  garment,
  count,
  detailsOpen,
  onDetailsToggle,
  onSaved,
  onRetagged,
  onRemoved,
  onSkip,
}: {
  garment: Garment;
  count: string;
  detailsOpen: boolean;
  onDetailsToggle: (open: boolean) => void;
  onSaved: () => void;
  onRetagged: () => void;
  onRemoved: () => void;
  onSkip: () => void;
}) {
  // The retag reports back from a mutation callback, which runs whether or not
  // this card is still mounted, so the message follows the screen.
  const say = useScreenToast();
  // A failed save keeps the edits on screen: the draft only lives here, so
  // dropping it after an error would throw the corrections away.
  const [draft, setDraft] = useState<Draft>(() => ({ ...garment }));

  const patch = buildPatch(garment, draft);
  const dirty = Object.keys(patch).length > 0;

  // A field nobody is asked about cannot be checked by hand, so a flag on one
  // would count toward "Check N" against a row that is never drawn.
  const flagged = new Set(garment.uncertain.filter((name: string) => FIELD_BY_NAME.has(name) && isAsked(name)));
  const shown = FIELDS.filter((field) => isAsked(field.name) && isRelevant(field.name, draft['slot']));
  const flaggedFields = shown.filter((field) => flagged.has(field.name));
  const restFields = shown.filter((field) => !flagged.has(field.name));

  const change = (name: string, value: unknown) => setDraft((rows) => ({ ...rows, [name]: value }));

  const save = useWrite({
    mutationFn: () => api.patchGarment(garment.id, confirmPatch(patch)),
    onSuccess: (updated) => {
      upsertGarment(updated);
      onSaved();
    },
  });

  const retag = useWrite({
    mutationFn: () => api.retagGarment(garment.id),
    onSuccess: (updated) => {
      upsertGarment(updated);
      // The row is back to placeholders, so there is nothing to check here
      // until Claude has looked at the photo again. Move on and say so.
      say('Back in Claude’s queue. Ask it to tag the untagged garments.');
      onRetagged();
    },
  });

  const remove = useWrite({
    mutationFn: () => api.archiveGarment(garment.id),
    onSuccess: () => {
      removeGarment(garment.id);
      onRemoved();
    },
  });

  /**
   * One flag over three writes, because the three buttons sit together and a
   * garment takes one write at a time. Each keeps its own label off its own
   * `isPending`, so Save cannot relabel the retag.
   */
  const busy = save.isPending || retag.isPending || remove.isPending;

  // Every field is flagged on a garment nothing ever looked at, so the head
  // says why rather than leaving the user to read nineteen warnings.
  const source = SOURCE_LINE[tagState(garment)] ?? null;

  return (
    <>
      <Photo src={imagePath(garment)} alt={garment.subtype} frameClass="photo" imageClass="photo__img" retry lazy={false} />

      {/* Both of these are about the whole garment rather than one field, and
          both belong above the fields. Removing used to sit under all nineteen
          of them, which is why it read as missing. */}
      <div className="photoedit">
        <RemoveButton busy={busy} onRemove={() => remove.mutate()} />
        <button
          className="btn btn--small btn--ghost"
          type="button"
          onClick={() => go(routeHash('edit', garment.id))}
        >
          Fix the photo
        </button>
      </div>

      <div className="review__head">
        <h2 className="review__title">{garment.subtype}</h2>
        {source !== null && <p className="source">{source}</p>}
        <ul className="tags">
          {summaryChips(garment).map((text) => (
            <li className="tag" key={text}>
              {text}
            </li>
          ))}
        </ul>
      </div>

      <section className={flaggedFields.length === 0 ? 'group group--flagged is-clear' : 'group group--flagged'}>
        <h3 className="group__title">
          {flaggedFields.length === 0 ? 'Claude was sure about every field' : `Check ${flaggedFields.length}`}
        </h3>
        <div className="group__body">
          {flaggedFields.map((field) => (
            <Field field={field} value={draft[field.name]} flagged onChange={change} key={field.name} />
          ))}
        </div>
      </section>

      <details
        className="group group--rest"
        open={detailsOpen}
        onToggle={(event) => onDetailsToggle(event.currentTarget.open)}
      >
        <summary className="group__summary">Everything else</summary>
        <div className="group__body">
          {restFields.map((field) => (
            <Field field={field} value={draft[field.name]} flagged={false} onChange={change} key={field.name} />
          ))}
          <div className="grouprow">
            <button className="btn btn--small btn--ghost" type="button" disabled={busy} onClick={() => retag.mutate()}>
              {retag.isPending ? 'Sending it back' : 'Ask Claude again'}
            </button>
          </div>
        </div>
      </details>

      <div className="actionbar">
        <p className="actionbar__count">{count}</p>
        <div className="actionbar__buttons">
          <button className="btn btn--ghost btn--small" type="button" onClick={onSkip}>
            Skip
          </button>
          <button
            className={dirty ? 'btn btn--primary btn--edited' : 'btn btn--primary'}
            type="button"
            disabled={busy}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving' : dirty ? 'Save changes' : 'Looks right'}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The queue is the wardrobe filtered, not a list of its own.
 *
 * It used to be a second query that fetched the unreviewed rows and wrote each
 * one into the wardrobe entry from inside its own `queryFn`. That made the
 * wardrobe a function of this screen's fetch, which is how a failed wardrobe
 * read plus a visit here left the app believing it owned three garments. The
 * predicate is the same one the tab badge counts with, so the two cannot drift
 * the way a second list could. They are not the same number: the meta also
 * hides the rows put aside this visit, so a skipped garment still counts toward
 * the badge, which is right, because the server still calls it unreviewed.
 *
 * `passed` is the skip cursor. Indexing into the list is what let a save renumber
 * the rows under the user and step over the next garment, so nothing indexes:
 * a row leaves the queue when the server says it is reviewed or gone, and Skip
 * and "Ask Claude again" put it aside by id for this visit only.
 */
export function Review({ route }: { route: { id: string | null } }) {
  const single = route.id !== null;
  const [passed, setPassed] = useState<ReadonlySet<string>>(() => new Set());
  const [detailsOpen, setDetailsOpen] = useState(false);

  const garments = useQuery(garmentsQuery);
  useRefreshFailure(garments);

  /**
   * The wardrobe is cached for the session, so without this the screen would
   * show the rows that were unreviewed at boot. This is the one screen whose
   * whole job is what Claude tagged since, so it is the one that asks again.
   */
  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: garmentsKey });
  }, []);

  const all = garments.data ?? [];
  const rows = single
    ? all.filter((row) => row.id === route.id)
    : all.filter((row) => !row.reviewed && !passed.has(row.id));
  const garment = rows[0] ?? null;

  useScreenChrome({
    title: 'Review',
    meta: garment === null || single ? '' : `${rows.length} left`,
    back: single ? '#/wardrobe' : null,
  });

  /** Put aside for this visit. A row the server still calls unreviewed would come back otherwise. */
  function pass(id: string) {
    setPassed((seen) => new Set(seen).add(id));
  }

  /**
   * A write already told the cache what it did, so the row leaves the queue on
   * its own. Passing the id as well makes that independent of what the server
   * set: the user answered this garment, so it does not come back either way.
   */
  function done(id: string) {
    if (single) go('#/wardrobe');
    else pass(id);
  }

  const body = 'screen__body--review';

  if (garments.isPending) {
    return (
      <Screen bodyClass={body}>
        <Empty text={single ? 'Loading the garment.' : 'Loading the queue.'} />
      </Screen>
    );
  }
  // Only with nothing behind it, so a failed refetch keeps the queue on screen.
  if (garments.isError && garments.data === undefined) {
    return (
      <Screen bodyClass={body}>
        <Empty text={garments.error.message} action={<TryAgain onRetry={() => void garments.refetch()} />} />
      </Screen>
    );
  }

  if (single && garment === null) {
    return (
      <Screen bodyClass={body}>
        <Empty text="That garment is not in the wardrobe any more." />
      </Screen>
    );
  }

  if (garment === null) {
    return (
      <Screen bodyClass={body}>
        <Empty
          text="Nothing left to review."
          action={
            <button className="btn btn--primary" type="button" onClick={() => go('#/wardrobe')}>
              Open the wardrobe
            </button>
          }
        />
      </Screen>
    );
  }

  return (
    <Screen bodyClass={body}>
      <ReviewCard
        key={garment.id}
        garment={garment}
        count={single ? '' : `${passed.size + 1} of ${passed.size + rows.length}`}
        detailsOpen={detailsOpen}
        onDetailsToggle={setDetailsOpen}
        onSaved={() => done(garment.id)}
        // Retagging puts the row back to placeholders, so the server still calls
        // it unreviewed and it would be the next thing shown. The toast says to
        // move on, so it is put aside.
        onRetagged={() => done(garment.id)}
        onRemoved={() => done(garment.id)}
        onSkip={() => pass(garment.id)}
      />
    </Screen>
  );
}

