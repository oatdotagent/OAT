/**
 * Tiny DOM builder. All text goes through text nodes (never innerHTML), so API data can't inject markup.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

type Props = {
  class?: string;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
  dataset?: Record<string, string>;
  text?: string;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  for (const [k, v] of Object.entries(props.attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const [k, v] of Object.entries(props.dataset ?? {})) el.dataset[k] = v;
  for (const [type, handler] of Object.entries(props.on ?? {})) el.addEventListener(type, handler as EventListener);
  if (props.text !== undefined) el.textContent = props.text;
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children.flat(Infinity as 1) as Child[]) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function replace(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icon from the shared sprite (/icons.svg). Decorative by default. */
export function icon(name: string, extraClass = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `/icons.svg#${name}`);
  svg.appendChild(use);
  return svg;
}

export function $(selector: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(selector);
}
