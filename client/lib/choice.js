import { el } from './dom.js';

/**
 * A one-choice chip row. Radios rather than buttons, so the browser owns which
 * one is selected and a re-render is never needed to move it.
 */
export function chipChoice({ name, options, value, onPick }) {
  const node = el('div', { class: 'chips' });

  for (const option of options) {
    const id = `c-${name}-${String(option.value)}`;
    const input = el('input', {
      type: 'radio',
      class: 'chip__input',
      name,
      id,
      value: String(option.value),
      checked: option.value === value,
      onchange: () => onPick(option.value),
    });
    node.append(el('label', { class: 'chip', for: id }, [input, el('span', {}, option.label)]));
  }

  return node;
}
