import { ApiError, createApi, type Api, type Me } from '../lib/api';
import { h, icon, replace } from '../lib/dom';
import { clearToken, getToken } from '../lib/session';
import { initMobileNav } from '../shared/behaviors';
import { navSection, parseRoute, type Route } from './router';
import { card, errorPanel, loading } from './ui';
import { renderConnect } from './views/connect';
import { renderExecution, renderExecutions } from './views/executions';
import { renderMetrics } from './views/metrics';
import { renderOverview } from './views/overview';
import { renderNotFound } from './views/not-found';
import { renderWorkflow, renderWorkflowEditor, renderWorkflows } from './views/workflows';

export interface ViewContext {
  api: Api;
  me: Me;
  root: HTMLElement;
  /** Aborted when the user navigates away — stops polling and ignores late responses. */
  signal: AbortSignal;
  navigate: (hash: string) => void;
}

const app = document.getElementById('app')!;
const api = createApi({ getToken });
const NAV = [
  { id: 'overview', label: 'Overview', href: '#/overview', icon: 'gauge' },
  { id: 'workflows', label: 'Workflows', href: '#/workflows', icon: 'layers' },
  { id: 'executions', label: 'Executions', href: '#/executions', icon: 'list' },
  { id: 'metrics', label: 'Metrics', href: '#/metrics', icon: 'activity', permission: 'metrics:read' },
];

let me: Me | null = null;
let viewController: AbortController | null = null;
let navInitialised = false;

void boot();

async function boot(): Promise<void> {
  replace(app, loading('Connecting to the API…'));
  try {
    me = (await api.me()).data;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      // A stale or wrong token: forget it and ask again.
      const hadToken = Boolean(getToken());
      clearToken();
      showConnect(hadToken ? 'Your saved token was not accepted. Paste a valid token to continue.' : undefined);
      return;
    }
    // A static host answers /api with a page instead of JSON: this build has no backend behind it yet.
    if (err instanceof ApiError && err.code === 'invalid_response') {
      showComingSoon();
      return;
    }
    replace(app, h('div', { class: 'connect' }, errorPanel(err, () => void boot())));
    return;
  }
  renderChrome();
  window.addEventListener('hashchange', route);
  route();
}

function showComingSoon(): void {
  replace(
    app,
    h(
      'div',
      { class: 'connect' },
      card(
        { title: 'The Console is coming soon', icon: 'info' },
        h(
          'div',
          { class: 'stack' },
          h('p', { class: 'muted' }, 'This site is a preview. The OAT Console will open here once the API goes live: define workflows, run them across AI providers and verify every output.'),
          h(
            'div',
            { class: 'inline-actions' },
            h('a', { class: 'btn btn--primary', attrs: { href: 'https://x.com/getoatsh', target: '_blank', rel: 'noopener noreferrer' } }, icon('brand-x'), 'Follow @getoatsh'),
            h('a', { class: 'btn btn--secondary', attrs: { href: '/' } }, icon('arrow-left'), 'Back to overview'),
          ),
        ),
      ),
    ),
  );
}

function showConnect(notice?: string): void {
  viewController?.abort();
  renderChrome();
  const controller = new AbortController();
  viewController = controller;
  renderConnect({
    api,
    root: app,
    signal: controller.signal,
    notice,
    onConnected: () => {
      window.removeEventListener('hashchange', route);
      void boot();
    },
  });
}

function signOut(): void {
  clearToken();
  me = null;
  window.removeEventListener('hashchange', route);
  history.replaceState(null, '', window.location.pathname);
  showConnect();
}

function renderChrome(): void {
  const desktop = document.querySelector<HTMLElement>('[data-console-nav]')!;
  const mobile = document.querySelector<HTMLElement>('[data-console-mobile-nav]')!;
  const mobileFooter = document.querySelector<HTMLElement>('[data-console-mobile-footer]')!;
  const chip = document.querySelector<HTMLElement>('[data-user-chip]')!;
  const toggle = document.querySelector<HTMLElement>('[data-nav-toggle]')!;

  if (!me) {
    replace(desktop);
    replace(mobile);
    replace(mobileFooter);
    chip.hidden = true;
    toggle.hidden = true;
    return;
  }
  const items = NAV.filter((n) => !n.permission || me!.permissions.includes(n.permission));
  replace(desktop, items.map((n) => h('li', {}, h('a', { class: 'nav__link', attrs: { href: n.href }, dataset: { section: n.id } }, n.label))));
  replace(mobile, items.map((n) => h('li', {}, h('a', { attrs: { href: n.href }, dataset: { section: n.id } }, icon(n.icon), ' ', n.label))));

  const who = [h('span', { class: 'badge badge--accent' }, me.role), h('span', {}, me.userId), me.devBypass ? h('span', { class: 'badge badge--warn' }, 'Dev bypass') : null];
  const signOutBtn = (extra = '') =>
    h('button', { class: `btn btn--ghost btn--sm ${extra}`.trim(), attrs: { type: 'button', hidden: me!.devBypass }, on: { click: signOut } }, icon('logout'), 'Sign out');
  replace(chip, ...who, signOutBtn());
  replace(mobileFooter, h('div', { class: 'inline-actions' }, ...who), signOutBtn());
  chip.hidden = false;
  toggle.hidden = false;

  if (!navInitialised) {
    initMobileNav();
    navInitialised = true;
  }
}

function markNav(r: Route): void {
  const section = navSection(r);
  document.querySelectorAll<HTMLAnchorElement>('[data-section]').forEach((a) => {
    if (a.dataset.section === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function route(): void {
  if (!me) return;
  viewController?.abort();
  const controller = new AbortController();
  viewController = controller;
  const r = parseRoute(window.location.hash);
  markNav(r);
  const ctx: ViewContext = {
    api,
    me,
    root: app,
    signal: controller.signal,
    navigate: (hash) => {
      window.location.hash = hash;
    },
  };

  const titles: Record<Route['name'], string> = {
    overview: 'Overview',
    workflows: 'Workflows',
    'workflow-new': 'New workflow',
    workflow: 'Workflow',
    executions: 'Executions',
    execution: 'Execution',
    metrics: 'Metrics',
    'not-found': 'Not found',
  };
  document.title = `${titles[r.name]} — OAT Console`;

  const handleAuthLoss = (err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      signOut();
      return true;
    }
    return false;
  };

  const run = async () => {
    switch (r.name) {
      case 'overview':
        return renderOverview(ctx);
      case 'workflows':
        return renderWorkflows(ctx);
      case 'workflow-new':
        return renderWorkflowEditor(ctx);
      case 'workflow':
        return renderWorkflow(ctx, r.id);
      case 'executions':
        return renderExecutions(ctx);
      case 'execution':
        return renderExecution(ctx, r.id);
      case 'metrics':
        return me!.permissions.includes('metrics:read') ? renderMetrics(ctx) : renderNotFound(ctx, 'Metrics are available to admins only.');
      case 'not-found':
        return renderNotFound(ctx);
    }
  };

  run().catch((err) => {
    if (controller.signal.aborted || handleAuthLoss(err)) return;
    replace(app, errorPanel(err, route));
  });
  // Move focus to the new content for keyboard and screen-reader users (not on first load).
  if (document.activeElement && document.activeElement !== document.body) app.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}
