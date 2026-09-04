import { button, clear, el } from '../dom.js';
import { emptyReport, garmentIds, momentChips, orderPieces, splitRules, warmthLine } from '../outfits.js';
import { imagePath, watchImage } from '../photo.js';

function pieceTile(slot, garment) {
  const image = el('img', {
    class: 'piece__img',
    src: imagePath(garment),
    alt: garment.subtype,
    decoding: 'async',
  });

  const frame = el('div', { class: 'piece__frame' }, image);
  watchImage(frame, image, { retry: true });

  return el('li', { class: 'piece' }, [
    frame,
    el('span', { class: 'piece__slot' }, slot),
    el('span', { class: 'piece__name' }, garment.subtype),
  ]);
}

function ruleList(rules, modifier) {
  return el(
    'ul',
    { class: modifier === null ? 'rules' : `rules ${modifier}` },
    rules.map((rule) =>
      el('li', { class: 'rule' }, [el('p', { class: 'rule__because' }, rule.because), el('span', { class: 'rule__id' }, rule.id)]),
    ),
  );
}

export function mountOutfits(ctx) {
  const node = el('section', { class: 'screen__body' });
  let gone = false;

  function show(...children) {
    clear(node);
    node.append(...children.filter((child) => child !== null));
  }

  function showMessage(text, action = null) {
    show(el('div', { class: 'empty' }, [el('p', { class: 'empty__text' }, text), action]));
  }

  function wearButton(outfit, index) {
    const worn = ctx.moment.isWorn(index);
    const control = button(worn ? 'Worn today' : 'Wore this', {
      class: 'btn btn--wide',
      disabled: worn,
    });
    if (!worn) control.classList.add('btn--primary');

    control.addEventListener('click', async () => {
      if (control.disabled) return;
      control.disabled = true;
      control.textContent = 'Saving';
      try {
        await ctx.api.wear({ garmentIds: garmentIds(outfit), event: ctx.moment.request?.event });
        ctx.moment.markWorn(index);
        control.classList.remove('btn--primary');
        control.textContent = 'Worn today';
      } catch (error) {
        control.disabled = false;
        control.textContent = 'Wore this';
        ctx.toast(error.message, 'error');
      }
    });

    return control;
  }

  function outfitCard(outfit, index) {
    const pieces = orderPieces(outfit.pieces);
    const { cited, missed } = splitRules(outfit);

    const accessories =
      outfit.accessories.length === 0
        ? null
        : el('div', { class: 'accessories' }, [
            el('h4', { class: 'section__title' }, 'With'),
            el(
              'ul',
              { class: 'tags' },
              outfit.accessories.map((garment) => el('li', { class: 'tag' }, garment.subtype)),
            ),
          ]);

    return el('section', { class: 'outfit' }, [
      el('div', { class: 'outfit__head' }, [
        el('h2', { class: 'outfit__title' }, `Option ${index + 1}`),
        el('span', { class: 'outfit__warmth' }, warmthLine(outfit)),
      ]),
      el(
        'ul',
        { class: 'looks' },
        pieces.map((piece) => pieceTile(piece.slot, piece.garment)),
      ),
      accessories,
      el('div', { class: 'rationale' }, [
        el('p', { class: 'rationale__text' }, outfit.rationale),
        el('p', { class: 'source source--model' }, 'The assistant wrote this. It is not from the book.'),
      ]),
      cited.length === 0
        ? null
        : el('section', { class: 'section' }, [
            el('h3', { class: 'section__title' }, 'From the book'),
            ruleList(cited, null),
          ]),
      missed.length === 0
        ? null
        : el('section', { class: 'section section--missed' }, [
            el('h3', { class: 'section__title' }, 'From the book, and missed here'),
            el('p', { class: 'source' }, 'This outfit breaks these on purpose.'),
            ruleList(missed, 'rules--missed'),
          ]),
      wearButton(outfit, index),
    ]);
  }

  function renderEmpty(response) {
    const report = emptyReport(response);
    show(
      momentBar(response),
      el('div', { class: 'card' }, [
        el('h2', { class: 'card__title' }, report.title),
        el('p', { class: 'card__line' }, report.detail),
        report.reasons.length === 0
          ? null
          : el('div', { class: 'section' }, [
              el('h3', { class: 'section__title' }, 'What it tried'),
              el(
                'ul',
                { class: 'reasons' },
                report.reasons.map((reason) => el('li', { class: 'reasons__item' }, reason)),
              ),
            ]),
      ]),
      el('div', { class: 'actionbar' }, [
        button('Change the moment', { class: 'btn btn--primary btn--wide', onclick: () => ctx.go('#/today') }),
        button('Open the wardrobe', { class: 'btn btn--ghost btn--wide', onclick: () => ctx.go('#/wardrobe') }),
      ]),
    );
  }

  function momentBar(response) {
    return el(
      'ul',
      { class: 'tags moment' },
      momentChips(response).map((text) => el('li', { class: 'tag' }, text)),
    );
  }

  function render(response) {
    const outfits = response?.outfits ?? [];
    ctx.setTitle('Outfits', outfits.length === 0 ? '' : `${outfits.length} to pick from`);

    if (outfits.length === 0) {
      renderEmpty(response);
      return;
    }
    show(momentBar(response), ...outfits.map(outfitCard));
  }

  async function load(again) {
    if (ctx.moment.request === null) {
      showMessage('Nothing asked yet.', button('Open Today', { class: 'btn btn--primary', onclick: () => ctx.go('#/today') }));
      return;
    }

    showMessage('Putting outfits together.');
    try {
      const response = await (again ? ctx.moment.again() : ctx.moment.ask());
      if (gone) return;
      render(response);
    } catch (error) {
      if (gone) return;
      // The engine refuses to guess a body type, so a conflict here is almost
      // always the profile. The server's own message is shown either way.
      const actions = [button('Try again', { class: 'btn btn--primary', onclick: () => load(true) })];
      if (error.status === 409) {
        actions.unshift(button('Set up the profile', { class: 'btn btn--ghost', onclick: () => ctx.go('#/profile') }));
      }
      showMessage(error.message, actions);
    }
  }

  ctx.setTitle('Outfits', '');
  ctx.setBack('#/today');
  ctx.onRefresh(() => load(true));
  load(false);

  return {
    node,
    destroy() {
      gone = true;
    },
  };
}
