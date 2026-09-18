/**
 * One saved outfit, drawn. Today and the history both show the same thing, so
 * they show it through the same component: the photos, the book's own sentences
 * for the rules it cites, the ones it misses kept visible but quieter, and the
 * rationale marked as the assistant's own words.
 *
 * It is also where the owner corrects it. Tapping a piece turns the card into a
 * picker, so there is no route to widen and no second surface to invent, and
 * correcting works from the history for free.
 *
 * What the card computes lives in `client/lib/outfitcard.js`.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Photo } from './Photo.js';
import {
  CAUTION_WORDS,
  ONE_PER_OUTFIT,
  REQUIRED_SLOTS,
  addableSlots,
  article,
  changeLine,
  honoredLine,
  cautionsFor,
  pieceLabel,
} from '../lib/outfitcard.js';
import {
  bookTally,
  garmentIds,
  orderPieces,
  outfitDay,
  readOutfit,
  splitRules,
  wearEntry,
} from '../lib/outfits.js';
import { imagePath } from '../lib/photo.js';
import { api, garmentsQuery } from '../lib/queries.js';
import type { Garment, Outfit } from '../lib/queries.js';
import { useShell } from '../lib/shell.js';
import { isWorn, markWorn } from '../lib/worn.js';

const REMOVE_ARM_MS = 4000;

type Rule = { id: string; short: string; because: string };
type Target = { slot: string; garment: Garment | null };

function PieceTile({ label, garment, onPick }: { label: string; garment: Garment; onPick: (() => void) | null }) {
  const body = (
    <>
      <Photo src={imagePath(garment)} frameClass="piece__frame" imageClass="piece__img" retry lazy={false} />
      <span className="piece__slot">{label}</span>
      <span className="piece__name">{garment.subtype}</span>
    </>
  );

  return (
    <li className="piece">
      {onPick === null ? (
        body
      ) : (
        <button className="piece__pick" type="button" aria-label={`Change the ${label}`} onClick={onPick}>
          {body}
        </button>
      )}
    </li>
  );
}

function RuleList({ rules, modifier = null }: { rules: Rule[]; modifier?: string | null }) {
  return (
    <ul className={modifier === null ? 'rules' : `rules ${modifier}`}>
      {rules.map((rule) => (
        <li className="rule" key={rule.id}>
          <p className="rule__because">{rule.because}</p>
          <span className="rule__id">{rule.id}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The rules the outfit keeps and the ones it sets aside, folded into one row.
 * Eleven of the book's sentences is most of a phone screen, and none of them
 * asks the owner to do anything today, so the pills carry what each rule wants
 * and the sentence behind one is a tap away.
 *
 * The donts are not in here. One of those means a swap made on this card went
 * against the book, which is the one thing nobody should have to open anything
 * to find.
 */
function BookSection({ cited, missed, outfitId }: { cited: Rule[]; missed: Rule[]; outfitId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  // Today and the history can have two cards on one screen, so the panel every
  // pill points at is named after the outfit rather than after the section.
  const saidId = `book-said-${outfitId}`;
  const shown = [...cited, ...missed].find((rule) => rule.id === open) ?? null;
  const shownKept = shown !== null && cited.includes(shown);

  function pill(rule: Rule, kept: boolean) {
    return (
      <li key={rule.id}>
        <button
          className={kept ? 'pill' : 'pill pill--missed'}
          type="button"
          aria-expanded={open === rule.id}
          aria-controls={saidId}
          onClick={() => setOpen((at) => (at === rule.id ? null : rule.id))}
        >
          {rule.short}
        </button>
      </li>
    );
  }

  return (
    <details className="book">
      <summary className="book__summary">
        <span className="section__title">From the book</span>
        <span className="book__tally">{bookTally(cited.length, missed.length)}</span>
      </summary>
      <ul className="pills">
        {cited.map((rule) => pill(rule, true))}
        {missed.map((rule) => pill(rule, false))}
      </ul>
      <div className="book__said" id={saidId}>
        {shown !== null && (
          <>
            {/* The sentence the missed section used to carry over its list. It
                is the whole difference between a rule this outfit follows and
                one it does not, and the quieter treatment alone does not say it. */}
            {!shownKept && <p className="source">This outfit breaks this one on purpose.</p>}
            <RuleList rules={[shown]} modifier={shownKept ? null : 'rules--missed'} />
          </>
        )}
      </div>
    </details>
  );
}

/**
 * The tap is logged on the phone as well as on the server: whether saving a
 * wear also flips the outfit's own `worn` flag is the Worker's business, and
 * leaving the screen and coming back must not offer to log the same day twice.
 */
function WearButton({ outfit, already, onWorn }: { outfit: Outfit; already: boolean; onWorn: () => void }) {
  const { toast } = useShell();
  const [saving, setSaving] = useState(false);

  async function wear() {
    setSaving(true);
    try {
      await api.wear(wearEntry(outfit));
      markWorn(outfit.id);
      onWorn();
    } catch (error) {
      setSaving(false);
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  return (
    <button
      className={already ? 'btn btn--wide' : 'btn btn--wide btn--primary'}
      type="button"
      disabled={already || saving}
      onClick={() => void wear()}
    >
      {already ? 'Worn' : saving ? 'Saving' : 'Wore this'}
    </button>
  );
}

/**
 * Two taps, the shape the review screen uses, and with a better claim to it:
 * that one archives a garment and this one is the first thing in the app that
 * really deletes rows, so there is nothing to undo a mis-tap with.
 *
 * The first tap says the cooldown goes, because that is the part nobody expects
 * a card to do on its way off the screen. It is told on `wearNamed` and not on
 * `worn`, since only a wear row naming this outfit is one the delete can reach.
 */
function RemoveButton({
  outfit,
  wearNamed,
  onRemoved,
}: {
  outfit: Outfit;
  wearNamed: boolean;
  onRemoved: () => void;
}) {
  const { toast } = useShell();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    try {
      await api.removeOutfit(outfit.id);
      onRemoved();
    } catch (error) {
      // A 404 means the outfit is already gone, which is the outcome the tap
      // asked for. Two surfaces open on one outfit make that ordinary, and
      // reporting it would leave a card on screen for an outfit nothing holds.
      if ((error as { status?: number })?.status === 404) {
        onRemoved();
        return;
      }
      setBusy(false);
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  return (
    <button
      className="btn btn--small btn--danger"
      type="button"
      disabled={busy}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          toast(
            wearNamed
              ? 'This outfit and the wear you logged both go, so its garments come off their cooldown.'
              : 'This outfit leaves the app for good.',
          );
          setTimeout(() => setArmed(false), REMOVE_ARM_MS);
          return;
        }
        void remove();
      }}
    >
      {armed ? 'Tap again to remove' : 'Remove this outfit'}
    </button>
  );
}

function OptionTile({
  name,
  garment,
  cautions,
  pressed,
  onPick,
}: {
  name: string;
  garment: Garment | null;
  cautions: string[];
  pressed: boolean;
  onPick: () => void;
}) {
  return (
    <button className="tile" type="button" aria-pressed={pressed} onClick={onPick}>
      {garment === null ? <div className="tile__frame" /> : <Photo src={imagePath(garment)} />}
      <span className="tile__name">{name}</span>
      {/* Inside the button rather than beside it, so the words join the
          control's own accessible name and a screen reader says "wool coat,
          out of season" about one thing. */}
      {cautions.length > 0 && (
        <span className="tile__warn">{cautions.map((one) => CAUTION_WORDS[one]).join(' and ')}</span>
      )}
    </button>
  );
}

/**
 * Shown but not offered, with the line under it saying which of the two it is.
 *
 * `worn` is the narrower of the two: this garment is on the outfit right now.
 * The other is a garment the outfit blocks without wearing it, a second pair of
 * glasses when it already wears one, and that keeps its color so a grid holding
 * both still answers which garment is in use at a glance.
 */
function HeldTile({ garment, note, worn }: { garment: Garment; note: string; worn: boolean }) {
  return (
    <div className={worn ? 'tile tile--current tile--worn' : 'tile tile--current'}>
      <Photo src={imagePath(garment)} />
      <span className="tile__name">{garment.subtype}</span>
      <span className="tile__slot">{note}</span>
    </div>
  );
}

/**
 * The whole wardrobe for that slot, in the order the wardrobe screen shows it.
 * Nothing is filtered and nothing is sorted: the owner is at that moment saying
 * the app's own filters were wrong, so a second filter would hide the garment
 * the tap exists to reach.
 *
 * Every candidate is labeled instead. A label hides nothing, costs no tap and
 * refuses nothing, and the tile keeps its place in that order, its photo, its
 * frame and its tap.
 *
 * The day behind the label is the outfit's own and never today's. An outfit
 * built for a summer day and opened in the winter is still a summer outfit, so
 * reading it against the day it is opened on would put a false warning on the
 * one screen where the owner can argue with it least.
 *
 * `target.garment` is null on an add: the owner is filling a slot the outfit
 * never had and nothing steps out. `onDone` takes the outfit the server sent
 * back, or null when they backed out.
 */
function Picker({
  outfit,
  target,
  onDone,
}: {
  outfit: Outfit;
  target: Target;
  onDone: (next: Outfit | null) => void;
}) {
  const { toast } = useShell();
  const garments = useQuery(garmentsQuery);
  const [chosen, setChosen] = useState<{ id: string | null } | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const adding = target.garment === null;
  // Null rides all the way to the wire, where it is the whole of what tells the
  // server an add from a swap.
  const fromId = adding ? null : target.garment?.id ?? null;

  /**
   * The wardrobe is loaded once at boot, and Today's own fetch for the outfit
   * normally lands after it. Normally is not always, and a picker drawn from an
   * empty cache would tell the owner they own nothing in this slot.
   */
  if (garments.isPending) return <p className="empty__text">Reading your wardrobe.</p>;
  if (garments.isError) {
    toast(garments.error.message, 'error');
    onDone(null);
    return null;
  }

  const options = garments.data.filter((garment) => garment.slot === target.slot);
  // Read once for the whole grid. Every candidate is judged against the same
  // day, and that day cannot change while the picker is open, because it is the
  // outfit's and the outfit is already saved.
  const day = outfitDay(outfit);

  // Every garment already on the outfit, not just the tapped one. An outfit's
  // other accessories sit in this slot too, so they would otherwise be offered
  // as options the server then refuses as already in this outfit.
  const alreadyOn = new Set<string>(garmentIds(outfit));

  // The one-per-outfit kinds the outfit still wears once the tapped garment
  // steps out. The server refuses a second of any of them, so offering one here
  // would cost the owner a reason typed out and a Save before it said no. On an
  // add nothing steps out, and a null `fromId` matches no garment, so every
  // accessory the outfit wears keeps its claim.
  const kept = new Set<string>(
    outfit.accessories
      .filter((garment: Garment) => garment.id !== fromId)
      .map((garment: Garment) => garment.accessoryKind)
      .filter((kind: string) => ONE_PER_OUTFIT.includes(kind)),
  );

  const offered = options.filter((garment) => !alreadyOn.has(garment.id) && !kept.has(garment.accessoryKind));
  const canSave = chosen !== null && reason.trim() !== '';

  async function save() {
    if (!canSave || chosen === null) return;
    setSaving(true);
    try {
      const body = await api.editPiece(outfit.id, { fromId, toId: chosen.id, reason: reason.trim() });
      const next = readOutfit(body?.outfit);
      if (next === null) throw new Error('The server sent back an outfit the app could not read.');
      onDone(next);
    } catch (error) {
      setSaving(false);
      toast(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  return (
    <div className="swap">
      <h3 className="section__title">
        {adding
          ? `Add ${article(target.slot)} ${target.slot}`
          : `Change the ${pieceLabel(target.slot, target.garment)}`}
      </h3>

      <div className="grid">
        {/* "Nothing here" empties the slot, and an add starts from an empty one,
            so there it would be a tap asking for the state the card is in. */}
        {!adding && !REQUIRED_SLOTS.includes(target.slot) && (
          <OptionTile
            name="Nothing here"
            garment={null}
            cautions={[]}
            pressed={chosen?.id === null && chosen !== null}
            onPick={() => setChosen({ id: null })}
          />
        )}
        {options.map((garment) =>
          alreadyOn.has(garment.id) ? (
            <HeldTile garment={garment} note="in this outfit" worn key={garment.id} />
          ) : kept.has(garment.accessoryKind) ? (
            <HeldTile
              garment={garment}
              note={`already wearing a ${garment.accessoryKind}`}
              worn={false}
              key={garment.id}
            />
          ) : (
            <OptionTile
              name={garment.subtype}
              garment={garment}
              cautions={cautionsFor(garment, day)}
              pressed={chosen?.id === garment.id}
              onPick={() => setChosen({ id: garment.id })}
              key={garment.id}
            />
          ),
        )}
        {/* Counted off the garments, not off the tiles, which also hold the
            "Nothing here" option and so are never empty for a slot an outfit
            can leave off. "else" counts the garment stepping out, and an add
            has none. */}
        {offered.length === 0 && (
          <p className="empty__text">
            {adding ? 'Nothing in your wardrobe can go here.' : 'Nothing else in your wardrobe can go here.'}
          </p>
        )}
      </div>

      <div className="field" hidden={chosen === null}>
        <label className="field__label" htmlFor={`swap-reason-${outfit.id}`}>
          Why the change?
        </label>
        <input
          className="control"
          type="text"
          // Named after the outfit, the way the book panel above is. Two open
          // history rows are two cards in one page, and one fixed id there
          // points the label at the other card's input.
          id={`swap-reason-${outfit.id}`}
          maxLength={280}
          autoComplete="off"
          // The swap asks what was wrong with the garment going out. An add has
          // no garment going out, so it asks for the thing the owner wanted.
          placeholder={
            adding
              ? 'It gets cold at night, the outfit needs a belt'
              : 'It itches, it is too warm, it does not go'
          }
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <p className="field__hint">Claude reads this the next time it plans an outfit.</p>
      </div>

      <div className="swap__actions">
        <button className="btn btn--ghost" type="button" onClick={() => onDone(null)}>
          Cancel
        </button>
        {/* The sentence is the point of the whole gesture, so it is what unlocks Save. */}
        <button className="btn btn--primary" type="button" disabled={!canSave || saving} onClick={() => void save()}>
          {saving ? 'Saving' : 'Save'}
        </button>
      </div>
    </div>
  );
}

/**
 * The outfit's own title takes the heading, and the screen's caption drops to
 * the small line under it: the name the assistant gave the outfit is the more
 * useful thing to read first. An outfit with no title keeps the caption as its
 * heading, so nothing saved before titles existed loses one.
 */
function CardHead({ named, caption, meta }: { named: string | null; caption: string | null; meta: string }) {
  const heading = named ?? caption;
  const under = named === null ? null : caption;
  if (heading === null && under === null && meta === '') return null;

  return (
    <div className="outfit__head">
      {heading !== null && <h2 className="outfit__title">{heading}</h2>}
      {(under !== null || meta !== '') && (
        <div className="outfit__when">
          {under !== null && <span>{under}</span>}
          {meta !== '' && <span className="outfit__meta">{meta}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * `caption` is null where the screen already says which outfit this is, and
 * `showName` is false where it has already shown the outfit's own name. The
 * history does exactly that, in the row you tap to open the card.
 *
 * `onRemoved` runs once the outfit is deleted, and a screen that passes none
 * gets no remove control at all. The card cannot take itself off the screen, so
 * offering the tap where nobody handles it would leave a card for an outfit
 * that is gone.
 */
export function OutfitCard({
  outfit,
  caption = null,
  meta = '',
  showName = true,
  onRemoved = null,
}: {
  outfit: Outfit;
  caption?: string | null;
  meta?: string;
  showName?: boolean;
  onRemoved?: (() => void) | null;
}) {
  const [current, setCurrent] = useState<Outfit>(outfit);
  const [target, setTarget] = useState<Target | null>(null);
  const [wornNow, setWornNow] = useState(false);

  if (target !== null) {
    return (
      <section className="outfit">
        <Picker
          outfit={current}
          target={target}
          onDone={(next) => {
            if (next !== null) setCurrent(next);
            setTarget(null);
          }}
        />
      </section>
    );
  }

  const pieces = orderPieces(current.pieces);
  const { cited, missed, broke } = splitRules(current);
  // The test the wear button already made, read once: an outfit that was worn
  // is the record of a day, so the server refuses to change one and the card
  // offers no tap.
  const worn = current.worn || isWorn(current.id) || wornNow;
  // A narrower question than `worn`, and the one the remove control needs: an
  // outfit worn before migration 009, or through a log_wear that left the id
  // out, is worn off the day and the garments and no row claims it.
  const wearNamed = current.wearNamed || isWorn(current.id) || wornNow;
  const open = addableSlots(current, worn);
  const request = current.ownerRequest;

  return (
    <section className="outfit">
      <CardHead
        named={showName && current.title !== '' ? current.title : null}
        caption={caption}
        meta={meta}
      />

      <ul className="looks">
        {pieces.map((piece: { slot: string; garment: Garment }) => (
          <PieceTile
            label={pieceLabel(piece.slot, piece.garment)}
            garment={piece.garment}
            onPick={worn ? null : () => setTarget(piece)}
            key={piece.slot}
          />
        ))}
      </ul>

      {/* Under the grid rather than a dashed hole standing in for each empty
          slot. Measured at a 375px shell, the holes cost a bare card 490px of
          empty photo frames and push the rationale off the screen, and the
          chips cost 70px and still name the slot they fill. */}
      {open.length > 0 && (
        <div className="addrow">
          <span className="addrow__label">Add</span>
          <div className="filters">
            {open.map((slot: string) => (
              <button
                className="filter"
                type="button"
                aria-label={`Add ${article(slot)} ${slot}`}
                onClick={() => setTarget({ slot, garment: null })}
                key={slot}
              >
                {slot}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* The same tile the pieces get, and tappable for the same reason. It
          keeps a section of its own because an accessory has no place in the
          base to shoes order above it, and there can be several. */}
      {current.accessories.length > 0 && (
        <div className="accessories">
          <h4 className="section__title">With</h4>
          <ul className="looks">
            {current.accessories.map((garment: Garment) => (
              <PieceTile
                label={pieceLabel('accessory', garment)}
                garment={garment}
                onPick={worn ? null : () => setTarget({ slot: 'accessory', garment })}
                key={garment.id}
              />
            ))}
          </ul>
        </div>
      )}

      {/* The premise of the outfit rather than a note on it, so it sits above
          the rationale. What the owner said carries the section the way their
          reason carries a correction. */}
      {request !== null && (
        <section className="section">
          <h3 className="section__title">What you asked for</h3>
          <p className="change__why">{`"${request.words}"`}</p>
          <ul className="changes">
            {request.honored.map((honored: { subtype: string | null; waived: string[] }, at: number) => (
              <li className="change" key={at}>
                <p className="change__what">{honoredLine(honored)}</p>
              </li>
            ))}
          </ul>
          <p className="source">Your own words, as Claude wrote them down.</p>
        </section>
      )}

      {current.rationale !== '' && (
        <div className="rationale">
          <p className="rationale__text">{current.rationale}</p>
          <p className="source source--model">
            {current.corrections.length === 0
              ? 'The assistant wrote this. It is not from the book.'
              : 'The assistant wrote this for the pieces it chose, before you changed one. It is not from the book.'}
          </p>
        </div>
      )}

      {/* A fourth voice, and the only one that argues. It sits after the
          rationale because it is the assistant's second thought about the
          outfit it just explained. */}
      {request !== null && request.disagreement !== '' && (
        <section className="section">
          <h3 className="section__title">What Claude would have changed</h3>
          <p className="rationale__text">{request.disagreement}</p>
          <p className="source source--model">The assistant&apos;s own read of what you asked for.</p>
        </section>
      )}

      {/* A third voice, kept apart from the book's and the assistant's the way
          those two are. */}
      {current.corrections.length > 0 && (
        <section className="section">
          <h3 className="section__title">What you changed</h3>
          <ul className="changes">
            {current.corrections.map((correction: { reason: string }, at: number) => (
              <li className="change" key={at}>
                <p className="change__what">{changeLine(correction)}</p>
                <p className="change__why">{`"${correction.reason}"`}</p>
              </li>
            ))}
          </ul>
          <p className="source">Your own words. Claude reads them the next time it plans.</p>
        </section>
      )}

      {(cited.length > 0 || missed.length > 0) && (
        <BookSection cited={cited} missed={missed} outfitId={current.id} />
      )}

      {/* Apart from the missed section because a dont is not a preference. The
          outfit was saved keeping these, so the only thing that can have broken
          one is a change the owner made here. */}
      {broke.length > 0 && (
        <section className="section section--broke">
          <h3 className="section__title">From the book, and broken here</h3>
          {/* No sentence blaming the owner, however likely they are the cause.
              The list is recomputed over the whole outfit and read against the
              book as it stands now, so a garment retagged since, or a rule the
              book has since made a dont, lands here having broken nothing at
              the time. "What you changed" sits right below. */}
          <p className="source">These are the book&apos;s donts, not preferences.</p>
          <RuleList rules={broke} modifier="rules--broke" />
        </section>
      )}

      <WearButton outfit={current} already={worn} onWorn={() => setWornNow(true)} />

      {onRemoved !== null && (
        <div className="outfit__remove">
          <RemoveButton outfit={current} wearNamed={wearNamed} onRemoved={onRemoved} />
        </div>
      )}
    </section>
  );
}
