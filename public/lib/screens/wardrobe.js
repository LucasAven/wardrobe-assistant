import { button, clear, el } from '../dom.js';
import { countTagStates, tagState } from '../garments.js';
import { imagePath, watchImage } from '../photo.js';
import { routeHash } from '../router.js';
import { SLOTS } from '../vocab.js';

/**
 * A gap says what is short in one of two ways, and never both. A rule asking
 * for a garment names the thing, and one about how a garment must look can only
 * name where nothing owned passes.
 */
function shortOf(gap) {
  return gap.needs === null ? `Nothing you own in ${gap.where} works for this.` : `You do not own ${gap.needs}.`;
}

/** A row the screen cannot draw is dropped rather than drawn half empty. */
function readable(gap) {
  return (
    gap !== null &&
    typeof gap === 'object' &&
    typeof gap.id === 'string' &&
    typeof gap.because === 'string' &&
    typeof gap.where === 'string' &&
    (gap.needs === null || typeof gap.needs === 'string')
  );
}

export function mountWardrobe(ctx) {
  const filters = el('div', { class: 'filters' });
  const grid = el('div', { class: 'grid' });
  const banner = el('div', { class: 'banner' });
  const gaps = el('div', { class: 'gaps' });
  const node = el('section', { class: 'screen__body' }, [banner, filters, grid, gaps]);

  let slot = 'all';
  let gone = false;

  function tile(garment) {
    const image = el('img', {
      class: 'tile__img',
      src: imagePath(garment),
      alt: '',
      loading: 'lazy',
      decoding: 'async',
    });

    // Two different jobs, so two different dots: a hollow one waits on Claude,
    // a filled one waits on the user.
    const state = tagState(garment);
    const marks = [];
    if (state === 'untagged') marks.push(el('span', { class: 'tile__dot tile__dot--untagged', title: 'not tagged yet' }));
    if (state === 'unconfirmed') marks.push(el('span', { class: 'tile__dot', title: 'tagged, not confirmed' }));

    const frame = el('div', { class: 'tile__frame' }, [image, ...marks]);
    watchImage(frame, image);

    return el('a', { class: 'tile', href: routeHash('review', garment.id) }, [
      frame,
      el('span', { class: 'tile__name' }, garment.subtype),
      el('span', { class: 'tile__slot' }, garment.slot),
    ]);
  }

  function renderGrid() {
    clear(grid);
    const garments = ctx.store.garments.filter((garment) => slot === 'all' || garment.slot === slot);
    if (garments.length === 0) {
      grid.append(el('p', { class: 'empty__text' }, slot === 'all' ? 'No garments yet.' : `Nothing in ${slot}.`));
      return;
    }
    for (const garment of garments) grid.append(tile(garment));
  }

  function renderFilters() {
    clear(filters);
    const counts = new Map(SLOTS.map((name) => [name, 0]));
    for (const garment of ctx.store.garments) {
      counts.set(garment.slot, (counts.get(garment.slot) ?? 0) + 1);
    }

    const entries = [{ value: 'all', label: `all ${ctx.store.garments.length}` }];
    for (const name of SLOTS) {
      if (counts.get(name) > 0) entries.push({ value: name, label: `${name} ${counts.get(name)}` });
    }

    for (const entry of entries) {
      const chip = button(entry.label, {
        class: 'filter',
        'aria-pressed': String(entry.value === slot),
        onclick: () => {
          slot = entry.value;
          renderFilters();
          renderGrid();
        },
      });
      filters.append(chip);
    }
  }

  function renderBanner() {
    clear(banner);
    const { untagged, unconfirmed } = countTagStates(ctx.store.garments);

    if (untagged > 0) {
      const line =
        untagged === 1
          ? '1 garment has no tags. Ask Claude to tag it through the connector.'
          : `${untagged} garments have no tags. Ask Claude to tag them through the connector.`;
      banner.append(
        el('div', { class: 'note' }, [
          el('p', { class: 'note__text' }, line),
          button(untagged === 1 ? 'Tag it by hand' : 'Tag them by hand', {
            class: 'btn btn--small btn--ghost',
            onclick: () => ctx.go('#/review'),
          }),
        ]),
      );
    }

    if (unconfirmed > 0) {
      banner.append(
        button(unconfirmed === 1 ? '1 garment to confirm' : `${unconfirmed} garments to confirm`, {
          class: 'btn btn--primary btn--wide',
          onclick: () => ctx.go('#/review'),
        }),
      );
    }
  }

  /**
   * What this wardrobe can never do, said once here rather than on every outfit
   * card. The outfit cards drop these, so this is the only place they are said,
   * and it sits under the grid because it is something to read now and then and
   * not something to act on today.
   */
  function renderGaps(found) {
    clear(gaps);
    if (found.length === 0) return;

    gaps.append(
      el('section', { class: 'section section--missed' }, [
        el('h3', { class: 'section__title' }, 'What this wardrobe cannot do'),
        el('p', { class: 'source' }, 'Left off every outfit card'),
        el(
          'ul',
          { class: 'rules rules--missed' },
          found.map((gap) =>
            // What is short leads, because that is the part worth acting on.
            // The guide's own sentence follows as the reason for it, the way it
            // reads on a card, and it is quieter here than the shortfall.
            el('li', { class: 'rule' }, [
              el('p', { class: 'rule__short' }, shortOf(gap)),
              el('p', { class: 'rule__because' }, gap.because),
              el('span', { class: 'rule__id' }, gap.id),
            ]),
          ),
        ),
      ]),
    );
  }

  function renderAll() {
    const total = ctx.store.garments.length;
    ctx.setTitle('Wardrobe', total === 1 ? '1 piece' : `${total} pieces`);
    renderBanner();
    renderFilters();
    renderGrid();
  }

  /**
   * Its own call, and its own failure. A wardrobe nobody can read is the screen
   * being broken, while gaps nobody can read is one section missing, so a fault
   * here leaves the clothes on screen instead of taking them down.
   */
  async function loadGaps() {
    try {
      const body = await ctx.api.listGaps();
      if (gone) return;
      renderGaps(Array.isArray(body?.gaps) ? body.gaps.filter(readable) : []);
    } catch {
      if (!gone) clear(gaps);
    }
  }

  async function load(force) {
    clear(grid);
    grid.append(el('p', { class: 'empty__text' }, 'Loading.'));
    try {
      await (force ? ctx.store.refresh() : ctx.store.ensure());
      if (gone) return;
      ctx.refreshBadge();
      renderAll();
      void loadGaps();
    } catch (error) {
      if (gone) return;
      clear(grid);
      grid.append(
        el('div', { class: 'empty' }, [
          el('p', { class: 'empty__text' }, error.message),
          button('Try again', { class: 'btn btn--primary', onclick: () => load(true) }),
        ]),
      );
    }
  }

  ctx.setTitle('Wardrobe', '');
  ctx.setBack(null);
  ctx.onRefresh(() => load(true));
  load(false);

  return {
    node,
    destroy() {
      gone = true;
    },
  };
}
