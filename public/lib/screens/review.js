import { button, clear, el } from '../dom.js';
import { createField, summaryChips } from '../fields.js';
import { isUntagged } from '../garments.js';
import { buildPatch, confirmPatch } from '../patch.js';
import { imagePath, watchImage } from '../photo.js';
import { FIELDS, FIELD_BY_NAME, isRelevant } from '../vocab.js';

const ARCHIVE_ARM_MS = 4000;

export function mountReview(ctx, route) {
  const node = el('section', { class: 'screen__body screen__body--review' });
  const single = route.id !== null;

  let queue = [];
  let index = 0;
  let original = null;
  let draft = null;
  let detailsOpen = false;
  let busy = false;
  let gone = false;

  function show(...children) {
    clear(node);
    node.append(...children.filter((child) => child !== null));
  }

  function showMessage(text, action = null) {
    show(el('div', { class: 'empty' }, [el('p', { class: 'empty__text' }, text), action]));
  }

  function current() {
    return queue[index] ?? null;
  }

  function advance() {
    if (single) {
      ctx.go('#/wardrobe');
      return;
    }
    index += 1;
    render();
  }

  function buildGroups(group, flaggedBody, restBody, refreshActions) {
    clear(flaggedBody);
    clear(restBody);

    const flagged = new Set(original.uncertain.filter((name) => FIELD_BY_NAME.has(name)));
    const onChange = (name, value) => {
      draft[name] = value;
      if (name === 'slot') buildGroups(group, flaggedBody, restBody, refreshActions);
      refreshActions();
    };

    let flaggedCount = 0;
    for (const field of FIELDS) {
      if (!isRelevant(field.name, draft.slot)) continue;
      const isFlagged = flagged.has(field.name);
      const target = isFlagged ? flaggedBody : restBody;
      if (isFlagged) flaggedCount += 1;
      target.append(createField(field, draft[field.name], { flagged: isFlagged, onChange }).node);
    }

    restBody.append(dangerRow());
    group.querySelector('.group__title').textContent =
      flaggedCount === 0 ? 'The tagger was sure about every field' : `Check ${flaggedCount}`;
    group.classList.toggle('is-clear', flaggedCount === 0);
  }

  function dangerRow() {
    const retag = button('Tag it again', { class: 'btn btn--small btn--ghost' });
    const archive = button('Archive', { class: 'btn btn--small btn--danger' });
    let armed = false;
    let timer = null;

    retag.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      retag.disabled = true;
      retag.textContent = 'Looking again';
      try {
        const updated = await ctx.api.retagGarment(original.id);
        ctx.store.upsert(updated);
        ctx.refreshBadge();
        queue[index] = updated;
        busy = false;
        render();
      } catch (error) {
        busy = false;
        retag.disabled = false;
        retag.textContent = 'Tag it again';
        ctx.toast(error.message, 'error');
      }
    });

    archive.addEventListener('click', async () => {
      if (busy) return;
      if (!armed) {
        armed = true;
        archive.textContent = 'Tap again to archive';
        timer = setTimeout(() => {
          armed = false;
          archive.textContent = 'Archive';
        }, ARCHIVE_ARM_MS);
        return;
      }
      clearTimeout(timer);
      busy = true;
      archive.disabled = true;
      try {
        await ctx.api.archiveGarment(original.id);
        ctx.store.remove(original.id);
        ctx.refreshBadge();
        queue.splice(index, 1);
        busy = false;
        if (single) ctx.go('#/wardrobe');
        else render();
      } catch (error) {
        busy = false;
        archive.disabled = false;
        ctx.toast(error.message, 'error');
      }
    });

    return el('div', { class: 'danger' }, [retag, archive]);
  }

  function render() {
    const garment = current();
    if (garment === null) {
      ctx.setTitle('Review', '');
      showMessage(
        'Nothing left to review.',
        button('Open the wardrobe', { class: 'btn btn--primary', onclick: () => ctx.go('#/wardrobe') }),
      );
      return;
    }

    original = garment;
    draft = { ...garment };

    const left = queue.length - index;
    ctx.setTitle('Review', single ? '' : `${left} left`);

    const image = el('img', {
      class: 'photo__img',
      src: imagePath(garment),
      alt: garment.subtype,
      decoding: 'async',
    });

    const frame = el('div', { class: 'photo' }, image);
    watchImage(frame, image, { retry: true });

    const chips = el('ul', { class: 'tags' }, summaryChips(garment).map((text) => el('li', { class: 'tag' }, text)));

    const flaggedTitle = el('h3', { class: 'group__title' });
    const flaggedBody = el('div', { class: 'group__body' });
    const flaggedGroup = el('section', { class: 'group group--flagged' }, [flaggedTitle, flaggedBody]);

    const restBody = el('div', { class: 'group__body' });
    const details = el('details', { class: 'group group--rest' }, [
      el('summary', { class: 'group__summary' }, 'Everything else'),
      restBody,
    ]);
    details.open = detailsOpen;
    details.addEventListener('toggle', () => {
      detailsOpen = details.open;
    });

    const primary = button('Looks right', { class: 'btn btn--primary' });
    const skip = button('Skip', { class: 'btn btn--ghost btn--small' });
    const count = el('p', { class: 'actionbar__count' }, single ? '' : `${index + 1} of ${queue.length}`);

    const refreshActions = () => {
      const dirty = Object.keys(buildPatch(original, draft)).length > 0;
      primary.textContent = dirty ? 'Save changes' : 'Looks right';
      primary.classList.toggle('btn--edited', dirty);
    };

    buildGroups(flaggedGroup, flaggedBody, restBody, refreshActions);

    // A failed save keeps the edits on screen: the draft only lives here, so
    // re-rendering after an error would throw the corrections away.
    primary.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      const label = primary.textContent;
      primary.disabled = true;
      primary.textContent = 'Saving';
      try {
        const updated = await ctx.api.patchGarment(original.id, confirmPatch(buildPatch(original, draft)));
        ctx.store.upsert(updated);
        ctx.refreshBadge();
        queue[index] = updated;
        busy = false;
        advance();
      } catch (error) {
        busy = false;
        primary.disabled = false;
        primary.textContent = label;
        ctx.toast(error.message, 'error');
      }
    });
    skip.addEventListener('click', advance);

    refreshActions();

    // Every field is flagged on a garment nothing ever looked at, so the head
    // says why rather than leaving the user to read nineteen warnings.
    const source = isUntagged(garment)
      ? el('p', { class: 'source' }, 'Never tagged. Every field below is a placeholder.')
      : null;

    show(
      frame,
      el('div', { class: 'review__head' }, [el('h2', { class: 'review__title' }, garment.subtype), source, chips]),
      flaggedGroup,
      details,
      el('div', { class: 'actionbar' }, [count, el('div', { class: 'actionbar__buttons' }, [skip, primary])]),
    );
  }

  async function load() {
    showMessage('Loading the queue.');
    try {
      if (single) {
        await ctx.store.ensure();
        const garment = ctx.store.find(route.id);
        if (garment === null) {
          showMessage('That garment is not in the wardrobe any more.');
          return;
        }
        queue = [garment];
      } else {
        const rows = await ctx.api.listGarments({ reviewed: false });
        for (const row of rows) ctx.store.upsert(row);
        ctx.refreshBadge();
        queue = rows;
      }
      if (gone) return;
      index = 0;
      render();
    } catch (error) {
      if (gone) return;
      showMessage(error.message, button('Try again', { class: 'btn btn--primary', onclick: load }));
    }
  }

  ctx.setTitle('Review', '');
  ctx.setBack(single ? '#/wardrobe' : null);
  load();

  return {
    node,
    destroy() {
      gone = true;
    },
  };
}
