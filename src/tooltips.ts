/**
 * Site-wide hover tooltips: rest the pointer on a control for 1.5 s and a small label appears.
 * The text comes from `data-tip`, else `title` (moved here so the browser's own, slower tooltip
 * does not double up), else the `aria-label` of a control that shows no text of its own.
 */
const DELAY_MS = 1500;
const SELECTOR = '[data-tip], [title], button[aria-label], a[aria-label], [role="button"][aria-label], input[aria-label]';

function tipFor(el: Element): string {
  if (el.hasAttribute('title')) {
    const title = el.getAttribute('title')?.trim() ?? '';
    el.removeAttribute('title');
    if (title) {
      el.setAttribute('data-tip', title);
    }
  }
  const explicit = el.getAttribute('data-tip')?.trim();
  if (explicit) {
    return explicit;
  }
  const label = el.getAttribute('aria-label')?.trim();
  if (label && !(el.textContent ?? '').trim()) {
    return label;
  }
  return '';
}

export function installTooltips() {
  if (typeof document === 'undefined') {
    return;
  }
  const bubble = document.createElement('div');
  bubble.className = 'tooltip';
  bubble.setAttribute('role', 'tooltip');
  document.body.appendChild(bubble);

  let timer = 0;
  let current: Element | null = null;

  const hide = () => {
    window.clearTimeout(timer);
    current = null;
    bubble.classList.remove('is-visible');
  };

  const show = (el: Element, text: string, x: number) => {
    // Inside the themed shell so it picks up the light/dark colours.
    const host = el.closest('.shell') ?? document.body;
    if (bubble.parentElement !== host) {
      host.appendChild(bubble);
    }
    bubble.textContent = text;
    bubble.classList.add('is-visible');
    const rect = el.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;
    const left = Math.min(Math.max(8, x - width / 2), window.innerWidth - width - 8);
    const below = rect.bottom + 8 + height <= window.innerHeight;
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(below ? rect.bottom + 8 : rect.top - 8 - height)}px`;
  };

  document.addEventListener(
    'pointerover',
    (event) => {
      if (event.pointerType !== 'mouse' || !(event.target instanceof Element)) {
        return;
      }
      const el = event.target.closest(SELECTOR);
      if (el === current) {
        return;
      }
      hide();
      if (!el) {
        return;
      }
      const text = tipFor(el);
      if (!text) {
        return;
      }
      current = el;
      const x = event.clientX;
      timer = window.setTimeout(() => {
        if (current === el && el.isConnected) {
          show(el, text, x);
        }
      }, DELAY_MS);
    },
    true
  );
  document.addEventListener('pointerout', (event) => {
    if (current && !(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))) {
      hide();
    }
  });
  ['pointerdown', 'wheel', 'keydown'].forEach((name) => window.addEventListener(name, hide, true));
  window.addEventListener('blur', hide);
}
