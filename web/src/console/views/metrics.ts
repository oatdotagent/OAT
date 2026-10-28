import type { Metrics, ProviderStatRow } from '../../lib/api';
import { h, replace } from '../../lib/dom';
import { formatCost, formatDateTime, formatNumber, formatUptime, humanize } from '../../lib/format';
import type { ViewContext } from '../main';
import { badge, button, card, emptyState, errorPanel, field, loading, pageHead, statusBadge, table, withBusy } from '../ui';

const WINDOWS = [
  { hours: 1, label: 'Last hour' },
  { hours: 24, label: 'Last 24 hours' },
  { hours: 24 * 7, label: 'Last 7 days' },
  { hours: 24 * 30, label: 'Last 30 days' },
];

export async function renderMetrics(ctx: ViewContext): Promise<void> {
  const { api, root, signal } = ctx;
  let windowHours = 24;
  const select = h('select', { class: 'select', attrs: { name: 'window' } }, WINDOWS.map((w) => h('option', { attrs: { value: w.hours, selected: w.hours === windowHours } }, w.label)));
  const area = h('div', { attrs: { 'aria-live': 'polite' } });

  const load = async () => {
    replace(area, loading('Loading metrics…'));
    try {
      const res = await api.metrics(windowHours);
      if (!signal.aborted) replace(area, metricsBody(res.data));
    } catch (err) {
      if (!signal.aborted) replace(area, errorPanel(err, () => void load()));
    }
  };
  select.addEventListener('change', () => {
    windowHours = Number(select.value);
    void load();
  });
  const refreshBtn = button('Refresh', { small: true, variant: 'ghost', icon: 'refresh', onClick: () => void withBusy(refreshBtn, 'Refreshing…', load) });

  replace(
    root,
    pageHead({ title: 'Metrics', subtitle: 'Recorded by this server. Nothing here is sampled, estimated by the UI, or simulated.', actions: [refreshBtn] }),
    h('div', { class: 'toolbar' }, field('Window', select)),
    area,
  );
  await load();
}

function metricsBody(m: Metrics): HTMLElement {
  const rows = m.providers.byCapability;
  const totalCalls = rows.reduce((n, r) => n + r.calls, 0);
  const totalErrors = rows.reduce((n, r) => n + r.errors, 0);
  const costRows = rows.filter((r) => r.estimatedCostUsd !== null);
  const totalCost = costRows.length ? costRows.reduce((n, r) => n + (r.estimatedCostUsd ?? 0), 0) : null;
  const execTotal = m.executions.byStatus.reduce((n, r) => n + r.count, 0);
  const anyMock = rows.some((r) => r.isMock);

  const stat = (label: string, value: string, sub?: string) =>
    h('div', { class: 'card stat' }, h('span', { class: 'stat__label' }, label), h('span', { class: 'stat__value' }, value), sub ? h('span', { class: 'stat__sub' }, sub) : null);

  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'field__hint' }, `Window since ${formatDateTime(m.window.since)}. HTTP figures cover this process since ${formatDateTime(m.http.since)} (up ${formatUptime(m.http.uptimeSeconds)}).`),
    h(
      'div',
      { class: 'grid grid--3' },
      stat('Provider calls', formatNumber(totalCalls), `${formatNumber(totalErrors)} errors`),
      stat('Executions', formatNumber(execTotal), `${m.executions.coordinator.active} active · ${m.executions.coordinator.queued} queued`),
      stat('Estimated cost', totalCost === null ? 'Not reported' : formatCost(totalCost), 'Only where a provider reports cost or publishes per-token rates'),
    ),
    card(
      { title: 'Providers', icon: 'plug', actions: anyMock ? [badge('Includes MOCK calls', 'warn')] : [] },
      rows.length ? providerTable(rows) : emptyState({ icon: 'plug', title: 'No provider calls in this window', text: 'Run a workflow to generate provider traffic.' }),
    ),
    h(
      'div',
      { class: 'grid grid--2' },
      card(
        { title: 'Executions by status', icon: 'list' },
        m.executions.byStatus.length
          ? table([{ label: 'Status', render: (r) => statusBadge(r.status) }, { label: 'Count', render: (r) => formatNumber(r.count) }], m.executions.byStatus, 'Executions by status')
          : emptyState({ icon: 'list', title: 'No executions in this window' }),
      ),
      card(
        { title: 'Provider errors', icon: 'alert' },
        m.providers.errors.length
          ? table([{ label: 'Provider', render: (r) => r.provider }, { label: 'Code', render: (r) => h('code', {}, r.code) }, { label: 'Count', render: (r) => formatNumber(r.count) }], m.providers.errors, 'Provider errors')
          : emptyState({ icon: 'check', title: 'No provider errors in this window' }),
      ),
    ),
    card({ title: 'HTTP routes (p95 latency)', icon: 'activity' }, m.http.routes.length ? latencyBars(m.http.routes) : emptyState({ title: 'No requests recorded yet' })),
  );
}

function providerTable(rows: ProviderStatRow[]): HTMLElement {
  return table(
    [
      { label: 'Provider', render: (r) => h('span', { class: 'row__badges' }, h('strong', {}, r.provider), r.isMock ? badge('MOCK', 'warn') : null) },
      { label: 'Capability', render: (r) => h('span', { class: 'mono' }, r.capability) },
      { label: 'Calls', render: (r) => `${formatNumber(r.calls)} (${formatNumber(r.attempts)} attempts)` },
      { label: 'Errors', render: (r) => (r.errors ? h('span', { class: 'badge badge--err' }, formatNumber(r.errors)) : '0') },
      { label: 'Latency', render: (r) => (r.avgLatencyMs === null ? '—' : `avg ${r.avgLatencyMs} ms · max ${r.maxLatencyMs} ms`) },
      { label: 'Tokens', render: (r) => formatTokens(r) },
      { label: 'Est. cost', render: (r) => formatCost(r.estimatedCostUsd) },
    ],
    rows,
    'Provider statistics',
  );
}

function formatTokens(r: ProviderStatRow): string {
  if (r.totalTokens !== null) return formatNumber(r.totalTokens);
  if (r.inputTokens === null && r.outputTokens === null) return 'Not reported';
  return formatNumber((r.inputTokens ?? 0) + (r.outputTokens ?? 0));
}

function latencyBars(routes: Metrics['http']['routes']): HTMLElement {
  const sorted = [...routes].filter((r) => r.latencyMs.p95 !== null).sort((a, b) => (b.latencyMs.p95 ?? 0) - (a.latencyMs.p95 ?? 0)).slice(0, 12);
  const max = Math.max(1, ...sorted.map((r) => r.latencyMs.p95 ?? 0));
  return h(
    'div',
    { class: 'bars', attrs: { role: 'list' } },
    sorted.map((r) => {
      const fill = h('span', { class: 'bars__fill' });
      fill.style.width = `${Math.max(2, ((r.latencyMs.p95 ?? 0) / max) * 100)}%`;
      return h(
        'div',
        { class: 'bars__row', attrs: { role: 'listitem', 'aria-label': `${r.route}: p95 ${Math.round(r.latencyMs.p95 ?? 0)} ms over ${r.count} requests` } },
        h('span', { attrs: { title: r.route } }, humanizeRoute(r.route)),
        h('span', { class: 'bars__track', attrs: { 'aria-hidden': 'true' } }, fill),
        h('span', { class: 'mono' }, `${Math.round(r.latencyMs.p95 ?? 0)} ms`),
      );
    }),
  );
}

function humanizeRoute(route: string): string {
  return route === 'unmatched' ? humanize(route) : route.replace('/api/v1', '');
}
