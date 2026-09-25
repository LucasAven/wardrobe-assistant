import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Screen } from './Screen.js';
import { uploadStatus } from '../lib/garments.js';
import { createLimiter } from '../lib/limiter.js';
import { normalizeForUpload } from '../lib/normalize.js';
import { api, upsertGarment } from '../lib/queries.js';
import { go } from '../lib/route.js';
import { useScreenChrome } from '../lib/shell.js';
import { createThumbnail } from '../lib/thumb.js';
import { errorMessage } from '../lib/write.js';

const UPLOAD_CONCURRENCY = 3;
const THUMBNAIL_CONCURRENCY = 2;

type ShotState = 'queued' | 'uploading' | 'done' | 'failed';

type Shot = {
  id: number;
  name: string;
  state: ShotState;
  status: string;
  note: string | null;
  tagged: boolean | null;
  thumb: string | null;
};

/**
 * What a row needs that React should not re-render on. The prepared body is
 * kept so a retry does not decode the photo a second time, and the release is
 * the object URL `createThumbnail` falls back to when a canvas is not available.
 */
type Work = { file: File; cutout: boolean; body: Blob | null; release: (() => void) | null };

function finishedLine(total: number, done: number, failed: number, untagged: number) {
  if (failed > 0) return `${done} saved, ${failed} failed. Retry them above.`;
  if (untagged === 0) return `All ${total} uploaded and tagged.`;
  return `All ${total} saved. ${untagged} still waiting on tags.`;
}

export function Upload() {
  useScreenChrome({ title: 'Add garments' });

  const [shots, setShots] = useState<Shot[]>([]);
  const [cutout, setCutout] = useState(false);

  const work = useRef(new Map<number, Work>());
  const nextId = useRef(0);
  const released = useRef(false);
  const limiters = useMemo(
    () => ({ uploads: createLimiter(UPLOAD_CONCURRENCY), thumbnails: createLimiter(THUMBNAIL_CONCURRENCY) }),
    [],
  );

  useEffect(() => {
    const rows = work.current;
    // Lowered on the way in, not only raised on the way out. A second mount of
    // the same component (StrictMode, which this app does not use today) would
    // otherwise start with the flag still up and release every thumbnail it
    // decoded, with nothing on screen to say why.
    released.current = false;
    return () => {
      released.current = true;
      for (const row of rows.values()) row.release?.();
      rows.clear();
    };
  }, []);

  const patch = useCallback((id: number, fields: Partial<Shot>) => {
    setShots((rows) => rows.map((row) => (row.id === id ? { ...row, ...fields } : row)));
  }, []);

  const start = useCallback(
    (id: number) => {
      const row = work.current.get(id);
      if (row === undefined) return;
      patch(id, { state: 'queued', status: 'Waiting' });

      limiters.uploads
        .run(async () => {
          patch(id, { state: 'uploading', status: 'Preparing' });
          let body = row.body;
          if (body === null) {
            const prepared = await normalizeForUpload(row.file, { cutout: row.cutout });
            body = prepared.body;
            row.body = body;
            if (!prepared.normalized) patch(id, { note: 'Sent full size.' });
          }
          patch(id, { state: 'uploading', status: 'Uploading' });
          return api.uploadGarment(body, { cutout: row.cutout });
        })
        .then(
          (garment) => {
            upsertGarment(garment);
            const status = uploadStatus(garment);
            patch(id, {
              state: 'done',
              status: status.status,
              tagged: status.tagged,
              ...(status.note === null ? {} : { note: status.note }),
            });
          },
          (error: unknown) => patch(id, { state: 'failed', status: errorMessage(error) }),
        );
    },
    [limiters, patch],
  );

  const add = useCallback(
    (files: File[]) => {
      const skipCutout = cutout;
      const added: Shot[] = [];
      for (const file of files) {
        const id = nextId.current++;
        work.current.set(id, { file, cutout: skipCutout, body: null, release: null });
        added.push({
          id,
          name: file.name || 'photo',
          state: 'queued',
          status: 'Waiting',
          note: null,
          tagged: null,
          thumb: null,
        });

        void limiters.thumbnails.run(async () => {
          const thumb = await createThumbnail(file);
          const row = work.current.get(id);
          if (released.current || row === undefined) {
            thumb.release();
            return;
          }
          row.release = thumb.release;
          patch(id, { thumb: thumb.src });
        });
      }
      setShots((rows) => [...rows, ...added]);
      for (const shot of added) start(shot.id);
    },
    [cutout, limiters, patch, start],
  );

  const done = shots.filter((shot) => shot.state === 'done').length;
  const failed = shots.filter((shot) => shot.state === 'failed').length;
  const untagged = shots.filter((shot) => shot.state === 'done' && shot.tagged === false).length;
  const left = shots.length - done - failed;

  let summary: string;
  if (shots.length === 0) summary = 'Pick photos of one garment each.';
  else if (left > 0) summary = `${done + failed} of ${shots.length} finished, ${left} to go.`;
  else summary = finishedLine(shots.length, done, failed, untagged);

  const showReview = shots.length > 0 && left === 0 && done > 0;

  return (
    <Screen>
      <label className="switch" htmlFor="cutout">
        <input
          className="switch__input"
          type="checkbox"
          id="cutout"
          checked={cutout}
          onChange={(event) => setCutout(event.target.checked)}
        />
        <span className="switch__body">
          <span className="switch__label">Already cut out in Photos</span>
          <span className="switch__hint">Keeps the subject you lifted instead of removing the background again.</span>
        </span>
      </label>

      <ul className="shots">
        {shots.map((shot) => (
          <li
            className="shot"
            key={shot.id}
            data-state={shot.state}
            data-tagged={shot.tagged === null ? undefined : shot.tagged ? 'yes' : 'no'}
          >
            <div className="shot__thumb">
              <img className="shot__img" alt="" decoding="async" src={shot.thumb ?? undefined} />
            </div>
            <div className="shot__body">
              <p className="shot__name">{shot.name}</p>
              <p className="shot__status">{shot.status}</p>
              <p className="shot__name" hidden={shot.note === null}>
                {shot.note}
              </p>
            </div>
            <button className="btn btn--small" type="button" hidden={shot.state !== 'failed'} onClick={() => start(shot.id)}>
              Retry
            </button>
          </li>
        ))}
      </ul>

      <div className="uploadbar">
        <p className="batch__summary">{summary}</p>
        <button className="btn btn--primary" type="button" hidden={!showReview} onClick={() => go('#/review')}>
          {done === 1 ? 'Review 1 garment' : `Review ${done} garments`}
        </button>
        <div className="picker">
          <label className="btn btn--big" htmlFor="pick-library">
            Choose photos
          </label>
          <input
            className="picker__input"
            type="file"
            accept="image/*"
            id="pick-library"
            multiple
            onChange={(event) => {
              if (event.target.files !== null && event.target.files.length > 0) add([...event.target.files]);
              event.target.value = '';
            }}
          />
          <label className="btn btn--big btn--ghost" htmlFor="pick-camera">
            Take a photo
          </label>
          <input
            className="picker__input"
            type="file"
            accept="image/*"
            id="pick-camera"
            capture="environment"
            onChange={(event) => {
              if (event.target.files !== null && event.target.files.length > 0) add([...event.target.files]);
              event.target.value = '';
            }}
          />
        </div>
      </div>
    </Screen>
  );
}
