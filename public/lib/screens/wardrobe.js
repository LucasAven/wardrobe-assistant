import { button, clear, el } from '../dom.js';
import { imagePath, watchImage } from '../photo.js';
import { routeHash } from '../router.js';
import { SLOTS } from '../vocab.js';

export function mountWardrobe(ctx) {
  const filters = el('div', { class: 'filters' });
  const grid = el('div', { class: 'grid' });
  const banner = el('div', { class: 'banner' });
  const node = el('section', { class: 'screen__body' }, [banner, filters, grid]);

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

    const marks = [];
    if (!garment.reviewed) marks.push(el('span', { class: 'tile__dot', title: 'not reviewed yet' }));

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
    const left = ctx.store.unreviewed.length;
    if (left === 0) return;
    banner.append(
      button(left === 1 ? '1 garment to review' : `${left} garments to review`, {
        class: 'btn btn--primary btn--wide',
        onclick: () => ctx.go('#/review'),
      }),
    );
  }

  function renderAll() {
    const total = ctx.store.garments.length;
    ctx.setTitle('Wardrobe', total === 1 ? '1 piece' : `${total} pieces`);
    renderBanner();
    renderFilters();
    renderGrid();
  }

  async function load(force) {
    clear(grid);
    grid.append(el('p', { class: 'empty__text' }, 'Loading.'));
    try {
      await (force ? ctx.store.refresh() : ctx.store.ensure());
      if (gone) return;
      ctx.refreshBadge();
      renderAll();
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
