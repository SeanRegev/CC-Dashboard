// @ts-check
/** Tiny DOM helpers. No framework. */

/**
 * h('div', { class: 'x', onclick: fn, dataset: { id } }, 'text', child)
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...(Node|string|number|null|undefined|false|Array<Node|string|null|undefined|false>)} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [p, val] of Object.entries(v)) {
          if (p.startsWith('--')) el.style.setProperty(p, String(val));
          else /** @type {any} */ (el.style)[p] = val;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

/** @param {Element} el @param {any[]} children */
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Replace all children. @param {Element} el @param {...any} children */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/** Inline SVG icons (stroke = currentColor), 16px grid. */
const ICONS = {
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  split: '<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M8 3v10"/>',
  unsplit: '<rect x="2.5" y="3" width="11" height="10" rx="2"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.3 3.3"/>',
  folder: '<path d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.5 1.6H12A1.5 1.5 0 0 1 13.5 6.6v4.9A1.5 1.5 0 0 1 12 13H4a1.5 1.5 0 0 1-1.5-1.5z"/>',
  stop: '<rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/>',
  play: '<path d="M5.5 4v8l6.5-4z"/>',
  bolt: '<path d="M9 2.5L4 9h3.5L7 13.5 12 7H8.5z"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5l2 1.5-2 1.5M8.5 10h2.5"/>',
  keyboard: '<rect x="1.8" y="4" width="12.4" height="8" rx="1.6"/><path d="M4.5 6.5h.01M7 6.5h.01M9.5 6.5h.01M12 6.5h.01M5 9.5h6"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
};

/** @param {keyof typeof ICONS} name @param {string} [cls] */
export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

/** Keyboard hint chip(s): kbd('Ctrl', 'K'). @param {...string} keys */
export function kbd(...keys) {
  return h('span', { class: 'kbd' }, ...keys.map((k) => h('kbd', null, k)));
}
