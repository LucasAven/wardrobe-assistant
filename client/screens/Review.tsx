import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Photo } from './Photo.js';
import { tagState } from '../lib/garments.js';
import { buildPatch, confirmPatch, formatColors, parseColors } from '../lib/patch.js';
import { imagePath } from '../lib/photo.js';
import { api, garmentsQuery, queryClient, removeGarment, reviewKey, upsertGarment } from '../lib/queries.js';
import type { Garment } from '../lib/queries.js';
import { go } from '../lib/route.js';
import { routeHash } from '../lib/router.js';
import { useScreenChrome, useShell } from '../lib/shell.js';
import { ANCHORS, FIELDS, FIELD_BY_NAME, isAsked, isRelevant } from '../lib/vocab.js';
import type { Field as FieldSpec } from '../lib/vocab.js';

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
      ) : field.control === 'select' ? (
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
      ) : (
        <TextControl field={field} value={value} onChange={(next) => onChange(field.name, next)} />
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
function RemoveButton({ busy, onRemove }: { busy: boolean; onRemove: () => Promise<void> }) {
  const { toast } = useShell();
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  return (
    <button
      className="btn btn--small btn--danger"
      type="button"
      disabled={busy}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          toast('Outfits you already saved keep this piece and its photo.');
          timer.current = setTimeout(() => setArmed(false), ARCHIVE_ARM_MS);
          return;
        }
        clearTimeout(timer.current ?? undefined);
        void onRemove();
      }}
    >
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
  onSaved: (updated: Garment) => void;
  onRetagged: (updated: Garment) => void;
  onRemoved: () => void;
  onSkip: () => void;
}) {
  const { toast } = useShell();
  // A failed save keeps the edits on screen: the draft only lives here, so
  // dropping it after an error would throw the corrections away.
  const [draft, setDraft] = useState<Draft>(() => ({ ...garment }));
  const [busy, setBusy] = useState(false);
  const [saveLabel, setSaveLabel] = useState<string | null>(null);

  const patch = buildPatch(garment, draft);
  const dirty = Object.keys(patch).length > 0;

  // A field nobody is asked about cannot be checked by hand, so a flag on one
  // would count toward "Check N" against a row that is never drawn.
  const flagged = new Set(garment.uncertain.filter((name: string) => FIELD_BY_NAME.has(name) && isAsked(name)));
  const shown = FIELDS.filter((field) => isAsked(field.name) && isRelevant(field.name, draft['slot']));
  const flaggedFields = shown.filter((field) => flagged.has(field.name));
  const restFields = shown.filter((field) => !flagged.has(field.name));

  const change = (name: string, value: unknown) => setDraft((rows) => ({ ...rows, [name]: value }));

  async function save() {
    if (busy) return;
    setBusy(true);
    setSaveLabel('Saving');
    try {
      const updated = await api.patchGarment(garment.id, confirmPatch(patch));
      upsertGarment(updated);
      onSaved(updated);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
      setSaveLabel(null);
    }
  }

  async function retag() {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await api.retagGarment(garment.id);
      upsertGarment(updated);
      // The row is back to placeholders, so there is nothing to check here
      // until Claude has looked at the photo again. Move on and say so.
      toast('Back in Claude’s queue. Ask it to tag the untagged garments.');
      onRetagged(updated);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await api.archiveGarment(garment.id);
      removeGarment(garment.id);
      onRemoved();
    } catch (error) {
      setBusy(false);
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  // Every field is flagged on a garment nothing ever looked at, so the head
  // says why rather than leaving the user to read nineteen warnings.
  const source = SOURCE_LINE[tagState(garment)] ?? null;

  return (
    <>
      <Photo src={imagePath(garment)} frameClass="photo" imageClass="photo__img" retry lazy={false} />

      {/* Both of these are about the whole garment rather than one field, and
          both belong above the fields. Removing used to sit under all nineteen
          of them, which is why it read as missing. */}
      <div className="photoedit">
        <RemoveButton busy={busy} onRemove={remove} />
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
            <button className="btn btn--small btn--ghost" type="button" disabled={busy} onClick={() => void retag()}>
              {busy ? 'Sending it back' : 'Ask Claude again'}
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
            onClick={() => void save()}
          >
            {saveLabel ?? (dirty ? 'Save changes' : 'Looks right')}
          </button>
        </div>
      </div>
    </>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <main className="screen">
      <section className="screen__body screen__body--review">{children}</section>
    </main>
  );
}

export function Review({ route }: { route: { id: string | null } }) {
  const single = route.id !== null;
  const [index, setIndex] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const key = reviewKey(route.id);
  const queue = useQuery({
    queryKey: key,
    queryFn: async (): Promise<Garment[]> => {
      if (route.id !== null) {
        const rows = await queryClient.ensureQueryData(garmentsQuery);
        return rows.filter((row) => row.id === route.id);
      }
      const rows: Garment[] = await api.listGarments({ reviewed: false });
      for (const row of rows) upsertGarment(row);
      return rows;
    },
  });

  const rows = queue.data ?? [];
  const garment = rows[index] ?? null;
  const left = rows.length - index;

  useScreenChrome({
    title: 'Review',
    meta: garment === null || single ? '' : `${left} left`,
    back: single ? '#/wardrobe' : null,
  });

  function replace(next: Garment[]) {
    queryClient.setQueryData(key, next);
  }

  function advance() {
    if (single) go('#/wardrobe');
    else setIndex((at) => at + 1);
  }

  if (queue.isPending) return <Body>{message('Loading the queue.')}</Body>;
  if (queue.isError) {
    return (
      <Body>
        {message(queue.error.message, (
          <button className="btn btn--primary" type="button" onClick={() => void queue.refetch()}>
            Try again
          </button>
        ))}
      </Body>
    );
  }

  if (single && rows.length === 0) return <Body>{message('That garment is not in the wardrobe any more.')}</Body>;

  if (garment === null) {
    return (
      <Body>
        {message('Nothing left to review.', (
          <button className="btn btn--primary" type="button" onClick={() => go('#/wardrobe')}>
            Open the wardrobe
          </button>
        ))}
      </Body>
    );
  }

  return (
    <Body>
      <ReviewCard
        key={garment.id}
        garment={garment}
        count={single ? '' : `${index + 1} of ${rows.length}`}
        detailsOpen={detailsOpen}
        onDetailsToggle={setDetailsOpen}
        onSaved={(updated) => {
          replace(rows.map((row, at) => (at === index ? updated : row)));
          advance();
        }}
        onRetagged={(updated) => {
          replace(rows.map((row, at) => (at === index ? updated : row)));
          advance();
        }}
        onRemoved={() => {
          replace(rows.filter((_, at) => at !== index));
          if (single) go('#/wardrobe');
        }}
        onSkip={advance}
      />
    </Body>
  );
}

function message(text: string, action: React.ReactNode = null) {
  return (
    <div className="empty">
      <p className="empty__text">{text}</p>
      {action}
    </div>
  );
}
