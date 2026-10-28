import { ApiError } from '../lib/api';
import { h, icon, type Child } from '../lib/dom';
import { humanize, statusTone } from '../lib/format';

export function statusBadge(status: string, label = humanize(status)): HTMLElement {
  const tone = statusTone(status);
  return h('span', { class: `badge${tone === 'neutral' ? '' : ` badge--${tone}`}` }, h('span', { class: 'dot', attrs: { 'aria-hidden': 'true' } }), label);
}

export function badge(text: string, tone: 'ok' | 'warn' | 'err' | 'info' | 'accent' | 'outline' | 'neutral' = 'neutral', title?: string): HTMLElement {
  return h('span', { class: `badge${tone === 'neutral' ? '' : ` badge--${tone}`}`, attrs: { title } }, text);
}

/** Every mock-sourced value is marked; mock output must never pass for real data. */
export function mockBadge(): HTMLElement {
  return badge('MOCK data', 'warn', 'Produced by the development mock provider — not real data');
}

export function pageHead(opts: { title: string; subtitle?: Child; back?: { href: string; label: string }; actions?: Child[] }): HTMLElement {
  return h(
    'div',
    { class: 'page-head' },
    h(
      'div',
      { class: 'page-head__text' },
      opts.back ? h('a', { class: 'back-link', attrs: { href: opts.back.href } }, icon('arrow-left'), opts.back.label) : null,
      h('h1', {}, opts.title),
      opts.subtitle ? h('p', {}, opts.subtitle) : null,
    ),
    opts.actions?.length ? h('div', { class: 'inline-actions' }, ...opts.actions) : null,
  );
}

export function card(opts: { title?: string; icon?: string; actions?: Child[]; class?: string; labelledBy?: string }, ...children: Child[]): HTMLElement {
  const id = opts.title ? `card-${Math.random().toString(36).slice(2, 9)}` : undefined;
  return h(
    'section',
    { class: `card ${opts.class ?? ''}`.trim(), attrs: { 'aria-labelledby': id } },
    opts.title
      ? h(
          'div',
          { class: 'card__header' },
          h('h2', { class: 'card__title', attrs: { id } }, opts.icon ? icon(opts.icon) : null, opts.title),
          opts.actions?.length ? h('div', { class: 'inline-actions' }, ...opts.actions) : null,
        )
      : null,
    ...children,
  );
}

export function loading(text = 'Loading…'): HTMLElement {
  return h('div', { class: 'loading', attrs: { role: 'status' } }, h('span', { class: 'spinner', attrs: { 'aria-hidden': 'true' } }), text);
}

export function emptyState(opts: { icon?: string; title: string; text?: Child; action?: Child }): HTMLElement {
  return h('div', { class: 'empty' }, icon(opts.icon ?? 'inbox'), h('h3', {}, opts.title), opts.text ? h('p', {}, opts.text) : null, opts.action ?? null);
}

export function alert(tone: 'info' | 'warn' | 'err' | 'ok', ...children: Child[]): HTMLElement {
  const name = tone === 'ok' ? 'check' : tone === 'info' ? 'info' : 'alert';
  return h('div', { class: `alert alert--${tone}`, attrs: { role: tone === 'err' ? 'alert' : null } }, icon(name), h('div', {}, ...children));
}

/** Error panel with the server's error code, details and request ID, plus an optional retry. */
export function errorPanel(err: unknown, retry?: () => void): HTMLElement {
  const e = err instanceof ApiError ? err : new ApiError(0, 'unexpected', err instanceof Error ? err.message : 'Something went wrong.');
  const details = Array.isArray(e.details) ? (e.details as Array<Record<string, unknown>>) : [];
  return h(
    'div',
    { class: 'stack' },
    alert(
      'err',
      h('p', {}, h('strong', {}, e.status === 0 ? 'Could not reach the API. ' : `Request failed (${e.code}). `), e.message),
      details.length
        ? h(
            'ul',
            {},
            details.slice(0, 10).map((d) => h('li', {}, [d.path, d.stepId, d.capability].filter(Boolean).join(' · ') || '', d.message ? `: ${String(d.message)}` : '')),
          )
        : null,
      e.requestId ? h('p', { class: 'mono' }, `Request ID: ${e.requestId}`) : null,
    ),
    retry ? h('button', { class: 'btn btn--secondary btn--sm', attrs: { type: 'button' }, on: { click: retry } }, icon('refresh'), 'Try again') : null,
  );
}

export interface Column<T> {
  label: string;
  render: (row: T) => Child;
}

/** Table that stacks into labelled cards below 48rem. */
export function table<T>(columns: Column<T>[], rows: T[], caption?: string): HTMLElement {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'table table--stack' },
      caption ? h('caption', { class: 'visually-hidden' }, caption) : null,
      h('thead', {}, h('tr', {}, columns.map((c) => h('th', { attrs: { scope: 'col' } }, c.label)))),
      h(
        'tbody',
        {},
        rows.map((r) => h('tr', {}, columns.map((c) => h('td', { attrs: { 'data-label': c.label } }, c.render(r))))),
      ),
    ),
  );
}

export function kv(pairs: Array<[string, Child]>): HTMLElement {
  return h('dl', { class: 'kv' }, pairs.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}

export function button(label: Child, opts: { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; small?: boolean; icon?: string; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean } = {}): HTMLButtonElement {
  return h(
    'button',
    {
      class: `btn btn--${opts.variant ?? 'secondary'}${opts.small ? ' btn--sm' : ''}`,
      attrs: { type: opts.type ?? 'button', disabled: opts.disabled },
      on: opts.onClick ? { click: opts.onClick } : {},
    },
    opts.icon ? icon(opts.icon) : null,
    label,
  );
}

export function linkButton(label: Child, href: string, opts: { variant?: 'primary' | 'secondary' | 'ghost'; small?: boolean; icon?: string } = {}): HTMLAnchorElement {
  return h('a', { class: `btn btn--${opts.variant ?? 'secondary'}${opts.small ? ' btn--sm' : ''}`, attrs: { href } }, opts.icon ? icon(opts.icon) : null, label);
}

/** Sets a button into a busy state for the duration of an async action. */
export async function withBusy<T>(btn: HTMLButtonElement, busyLabel: string, fn: () => Promise<T>): Promise<T> {
  const original = [...btn.childNodes];
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.replaceChildren(h('span', { class: 'spinner spinner--xs', attrs: { 'aria-hidden': 'true' } }), busyLabel);
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.replaceChildren(...original);
  }
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  const hintId = hint ? `${id}-hint` : undefined;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'field' }, h('label', { class: 'field__label', attrs: { for: id } }, label), control, hint ? h('p', { class: 'field__hint', attrs: { id: hintId } }, hint) : null);
}
