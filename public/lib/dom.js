const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'multiple']);

const ALIASES = { class: 'className', text: 'textContent', for: 'htmlFor' };

function appendChild(node, child) {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const item of child) appendChild(node, item);
    return;
  }
  node.append(child instanceof Node ? child : String(child));
}

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined) continue;
    if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (key.startsWith('on')) {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in ALIASES) {
      node[ALIASES[key]] = value;
    } else if (PROPERTY_KEYS.has(key)) {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChild(node, children);
  return node;
}

export function clear(node) {
  node.replaceChildren();
}

export function button(label, props = {}) {
  return el('button', { type: 'button', ...props }, label);
}
