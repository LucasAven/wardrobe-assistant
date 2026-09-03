import { el } from './dom.js';
import { formatColors, parseColors } from './patch.js';
import { ANCHORS } from './vocab.js';

function encode(field, value) {
  if (value === null || value === undefined) return '';
  if (field.type === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function decode(field, raw) {
  if (raw === '') return field.type === 'string' && !field.nullable ? '' : null;
  if (field.type === 'boolean') return raw === 'true';
  if (field.type === 'number') return Number(raw);
  return raw;
}

function buildSelect(field, value) {
  const select = el('select', { class: 'control control--select', id: `f-${field.name}` });
  if (field.nullable) select.append(el('option', { value: '' }, 'not set'));
  for (const option of field.options) {
    select.append(el('option', { value: option.value }, option.label));
  }
  select.value = encode(field, value);
  return select;
}

function buildAnchors(field, value) {
  const anchor = ANCHORS[field.anchors];
  const list = el('ul', { class: 'anchors__list' });
  const steps = new Map();

  for (const step of anchor.steps) {
    const item = el('li', { class: 'anchors__step' }, [
      el('span', { class: 'anchors__value' }, String(step.value)),
      el('span', { class: 'anchors__text' }, step.text),
    ]);
    steps.set(step.value, item);
    list.append(item);
  }

  const node = el('div', { class: 'anchors' }, [
    el('p', { class: 'anchors__scale' }, anchor.scale),
    list,
  ]);

  const highlight = (current) => {
    for (const [stepValue, item] of steps) {
      item.classList.toggle('is-current', stepValue === current);
    }
  };
  highlight(value);
  return { node, highlight };
}

function buildChips(field, value) {
  const selected = new Set(value ?? []);
  const node = el('div', { class: 'chips' });
  const inputs = [];

  for (const option of field.options) {
    const input = el('input', {
      type: 'checkbox',
      class: 'chip__input',
      value: option,
      checked: selected.has(option),
      id: `f-${field.name}-${option}`,
    });
    inputs.push(input);
    node.append(el('label', { class: 'chip', for: `f-${field.name}-${option}` }, [input, el('span', {}, option)]));
  }

  return { node, read: () => inputs.filter((input) => input.checked).map((input) => input.value) };
}

/**
 * One labelled control plus, for warmth and formality, the tagger's own scale.
 * Grading against a different scale than the model used is how these two fields
 * end up wrong in a way nothing downstream can detect.
 */
export function createField(field, value, { flagged = false, onChange }) {
  const head = el('div', { class: 'field__head' }, [
    el('label', { class: 'field__label', for: `f-${field.name}` }, field.label),
    flagged ? el('span', { class: 'field__flag' }, 'check this') : null,
  ]);

  const node = el('div', { class: flagged ? 'field field--flagged' : 'field', dataset: { field: field.name } }, head);
  let read;

  if (field.control === 'chips') {
    const chips = buildChips(field, value);
    read = chips.read;
    node.append(chips.node);
    chips.node.addEventListener('change', () => onChange(field.name, read()));
  } else if (field.control === 'text' || field.control === 'textarea') {
    const isArea = field.control === 'textarea';
    const control = el(isArea ? 'textarea' : 'input', {
      class: `control control--${isArea ? 'area' : 'text'}`,
      id: `f-${field.name}`,
      type: isArea ? null : 'text',
      rows: isArea ? '3' : null,
      placeholder: field.placeholder ?? null,
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'done',
    });
    control.value = field.type === 'colors' ? formatColors(value ?? []) : (value ?? '');
    read = () => (field.type === 'colors' ? parseColors(control.value) : decode(field, control.value.trim()));
    node.append(control);
    control.addEventListener('input', () => onChange(field.name, read()));
  } else {
    const control = buildSelect(field, value);
    read = () => decode(field, control.value);
    node.append(control);

    if (field.anchors !== undefined) {
      const anchors = buildAnchors(field, value);
      node.append(anchors.node);
      control.addEventListener('change', () => {
        anchors.highlight(read());
        onChange(field.name, read());
      });
    } else {
      control.addEventListener('change', () => onChange(field.name, read()));
    }
  }

  if (field.hint !== undefined) node.append(el('p', { class: 'field__hint' }, field.hint));
  return { node, read };
}

export function summaryChips(garment) {
  const seasons = garment.seasons.length === 0 ? 'no season' : garment.seasons.join(', ');
  return [garment.slot, `warmth ${garment.warmth}`, `formality ${garment.formality}`, seasons];
}

