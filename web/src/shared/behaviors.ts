/**
 * Progressive-enhancement behaviours shared by the landing page and the console:
 * mobile navigation, copy-to-clipboard, accessible tabs and toasts.
 */

const DESKTOP = window.matchMedia('(min-width: 60rem)');

export function initMobileNav(root: ParentNode = document): void {
  const toggle = root.querySelector<HTMLButtonElement>('[data-nav-toggle]');
  const menu = root.querySelector<HTMLElement>('[data-nav-menu]');
  if (!toggle || !menu) return;

  const setOpen = (open: boolean, { focus = false } = {}) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    menu.hidden = !open;
    document.body.dataset.menuOpen = String(open);
    if (open && focus) menu.querySelector<HTMLElement>('a, button')?.focus();
  };

  setOpen(false);
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true', { focus: true }));
  // Following a link (including in-page anchors) closes the menu.
  menu.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    if (toggle.getAttribute('aria-expanded') === 'true' && !menu.contains(t) && !toggle.contains(t)) setOpen(false);
  });
  DESKTOP.addEventListener('change', (e) => {
    if (e.matches) setOpen(false);
  });
}

/** Copy text; falls back to selecting the text when the Clipboard API is unavailable. */
export async function copyText(text: string, fallbackTarget?: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallbackTarget) {
      const range = document.createRange();
      range.selectNodeContents(fallbackTarget);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    return false;
  }
}

/** Buttons with [data-copy-target="#id"] copy that element's text. */
export function initCopyButtons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLButtonElement>('[data-copy-target]').forEach((btn) => {
    const label = btn.querySelector<HTMLElement>('[data-copy-label]');
    const original = label?.textContent ?? 'Copy';
    btn.addEventListener('click', async () => {
      const target = document.querySelector<HTMLElement>(btn.dataset.copyTarget!);
      if (!target) return;
      const ok = await copyText(target.textContent ?? '', target);
      if (label) label.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      btn.dataset.state = ok ? 'copied' : 'manual';
      announce(ok ? 'Copied to clipboard' : 'Text selected; press Ctrl+C or Cmd+C to copy');
      window.setTimeout(() => {
        if (label) label.textContent = original;
        delete btn.dataset.state;
      }, 2000);
    });
  });
}

/** WAI-ARIA tabs: [role=tablist] containing [role=tab][aria-controls]. Arrow keys, Home and End move between tabs. */
export function initTabs(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[role="tablist"]').forEach((list) => {
    const tabs = [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const select = (tab: HTMLButtonElement, focus = false) => {
      for (const t of tabs) {
        const selected = t === tab;
        t.setAttribute('aria-selected', String(selected));
        t.tabIndex = selected ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls')!);
        if (panel) panel.hidden = !selected;
      }
      if (focus) tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab));
      tab.addEventListener('keydown', (e) => {
        const next =
          e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i - 1 + tabs.length) % tabs.length] : e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : undefined;
        if (next) {
          e.preventDefault();
          select(next, true);
        }
      });
    });
    const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0];
    if (initial) select(initial);
  });
}

let liveRegion: HTMLElement | null = null;
/** Screen-reader announcement via a polite live region. */
export function announce(message: string): void {
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'visually-hidden';
    liveRegion.setAttribute('aria-live', 'polite');
    document.body.appendChild(liveRegion);
  }
  liveRegion.textContent = '';
  window.setTimeout(() => {
    if (liveRegion) liveRegion.textContent = message;
  }, 30);
}

let toastRegion: HTMLElement | null = null;
export function toast(message: string, tone: 'default' | 'err' = 'default'): void {
  if (!toastRegion) {
    toastRegion = document.createElement('div');
    toastRegion.className = 'toast-region';
    toastRegion.setAttribute('role', 'status');
    toastRegion.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastRegion);
  }
  const el = document.createElement('div');
  el.className = tone === 'err' ? 'toast toast--err' : 'toast';
  el.textContent = message;
  toastRegion.appendChild(el);
  window.setTimeout(() => el.remove(), 4000);
}
