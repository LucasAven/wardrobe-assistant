import { button, clear, el } from '../dom.js';
import { uploadStatus } from '../garments.js';
import { createLimiter } from '../limiter.js';
import { normalizeForUpload } from '../normalize.js';
import { createThumbnail } from '../thumb.js';

const UPLOAD_CONCURRENCY = 3;
const THUMBNAIL_CONCURRENCY = 2;

function pickerInput(id, extra) {
  return el('input', { type: 'file', accept: 'image/*', class: 'picker__input', id, ...extra });
}

export function mountUpload(ctx) {
  const uploads = createLimiter(UPLOAD_CONCURRENCY);
  const thumbnails = createLimiter(THUMBNAIL_CONCURRENCY);
  const items = [];
  let released = false;

  const library = pickerInput('pick-library', { multiple: 'multiple' });
  const camera = pickerInput('pick-camera', { capture: 'environment' });
  const cutout = el('input', { type: 'checkbox', class: 'switch__input', id: 'cutout' });

  const list = el('ul', { class: 'shots' });
  const summary = el('p', { class: 'batch__summary' }, 'Pick photos of one garment each.');
  const reviewButton = button('Review', {
    class: 'btn btn--primary',
    onclick: () => ctx.go('#/review'),
  });
  reviewButton.hidden = true;

  const node = el('section', { class: 'screen__body' }, [
    el('label', { class: 'switch', for: 'cutout' }, [
      cutout,
      el('span', { class: 'switch__body' }, [
        el('span', { class: 'switch__label' }, 'Already cut out in Photos'),
        el('span', { class: 'switch__hint' }, 'Keeps the subject you lifted instead of removing the background again.'),
      ]),
    ]),
    list,
    el('div', { class: 'uploadbar' }, [
      summary,
      reviewButton,
      el('div', { class: 'picker' }, [
        el('label', { class: 'btn btn--big', for: 'pick-library' }, 'Choose photos'),
        library,
        el('label', { class: 'btn btn--big btn--ghost', for: 'pick-camera' }, 'Take a photo'),
        camera,
      ]),
    ]),
  ]);

  function counts() {
    const total = items.length;
    const done = items.filter((item) => item.state === 'done').length;
    const failed = items.filter((item) => item.state === 'failed').length;
    const untagged = items.filter((item) => item.state === 'done' && !item.tagged).length;
    return { total, done, failed, untagged, left: total - done - failed };
  }

  function finishedLine(total, done, failed, untagged) {
    if (failed > 0) return `${done} saved, ${failed} failed. Retry them above.`;
    if (untagged === 0) return `All ${total} uploaded and tagged.`;
    return `All ${total} saved. ${untagged} still waiting on tags.`;
  }

  function refreshBatch() {
    const { total, done, failed, untagged, left } = counts();
    if (total === 0) {
      summary.textContent = 'Pick photos of one garment each.';
      reviewButton.hidden = true;
      return;
    }
    if (left > 0) {
      summary.textContent = `${done + failed} of ${total} finished, ${left} to go.`;
      reviewButton.hidden = true;
      return;
    }
    summary.textContent = finishedLine(total, done, failed, untagged);
    reviewButton.textContent = done === 1 ? 'Review 1 garment' : `Review ${done} garments`;
    reviewButton.hidden = done === 0;
  }

  function createItem(file, skipCutout) {
    const image = el('img', { class: 'shot__img', alt: '', decoding: 'async' });
    const status = el('p', { class: 'shot__status' }, 'Waiting');
    const note = el('p', { class: 'shot__name', hidden: true });
    const retry = button('Retry', { class: 'btn btn--small' });
    retry.hidden = true;

    const row = el('li', { class: 'shot', dataset: { state: 'queued' } }, [
      el('div', { class: 'shot__thumb' }, image),
      el('div', { class: 'shot__body' }, [el('p', { class: 'shot__name' }, file.name || 'photo'), status, note]),
      retry,
    ]);

    const item = { file, cutout: skipCutout, state: 'queued', tagged: true, node: row, release: null, upload: null };

    item.setNote = (text) => {
      note.textContent = text;
      note.hidden = false;
    };

    item.setTagged = (tagged) => {
      item.tagged = tagged;
      row.dataset.tagged = tagged ? 'yes' : 'no';
    };

    item.setState = (state, text) => {
      item.state = state;
      row.dataset.state = state;
      status.textContent = text;
      retry.hidden = state !== 'failed';
      refreshBatch();
    };

    retry.addEventListener('click', () => start(item));

    thumbnails.run(async () => {
      if (released) return;
      const thumb = await createThumbnail(file);
      if (released) {
        thumb.release();
        return;
      }
      item.release = thumb.release;
      image.src = thumb.src;
    });

    return item;
  }

  /** Kept on the item so a retry does not decode the photo a second time. */
  async function prepare(item) {
    if (item.upload === null) {
      const { body, normalized } = await normalizeForUpload(item.file, { cutout: item.cutout });
      item.upload = body;
      if (!normalized) item.setNote('Sent full size.');
    }
    return item.upload;
  }

  function start(item) {
    item.setState('queued', 'Waiting');
    uploads.run(async () => {
      item.setState('uploading', 'Preparing');
      const body = await prepare(item);
      item.setState('uploading', 'Uploading');
      return ctx.api.uploadGarment(body, { cutout: item.cutout });
    }).then(
      (garment) => {
        ctx.store.upsert(garment);
        // An upload with nothing to tag it is the normal one now, so the row
        // reports where the tags come from instead of reading as a failure.
        const status = uploadStatus(garment);
        item.setTagged(status.tagged);
        if (status.note !== null) item.setNote(status.note);
        item.setState('done', status.status);
      },
      (error) => item.setState('failed', error.message),
    );
  }

  function add(files) {
    const skipCutout = cutout.checked;
    for (const file of files) {
      const item = createItem(file, skipCutout);
      items.push(item);
      list.append(item.node);
      start(item);
    }
    refreshBatch();
  }

  for (const input of [library, camera]) {
    input.addEventListener('change', () => {
      if (input.files.length > 0) add([...input.files]);
      input.value = '';
    });
  }

  ctx.setTitle('Add garments', '');
  return {
    node,
    destroy() {
      released = true;
      for (const item of items) item.release?.();
      clear(list);
    },
  };
}
