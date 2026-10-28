import { type CapabilityInfo, type ProbeResult, type ProviderInfo, type Readiness } from '../../lib/api';
import { h, replace } from '../../lib/dom';
import { formatRelative, formatUptime, humanize } from '../../lib/format';
import { toast } from '../../shared/behaviors';
import type { ViewContext } from '../main';
import { alert, badge, button, card, emptyState, errorPanel, kv, linkButton, loading, pageHead, statusBadge, table, withBusy } from '../ui';

export async function renderOverview(ctx: ViewContext): Promise<void> {
  const { api, root, signal } = ctx;
  replace(root, pageHead({ title: 'Overview', subtitle: 'Live status of this server and its provider integrations.' }), loading('Loading server status…'));

  const [health, ready, providers] = await Promise.allSettled([api.health(), api.ready(), api.providers()]);
  if (signal.aborted) return;

  const readiness: Readiness | null =
    ready.status === 'fulfilled' ? ready.value.data : null;
  const isAdmin = ctx.me.permissions.includes('providers:probe');

  const serverCard = card(
    { title: 'Server', icon: 'gauge' },
    health.status === 'fulfilled'
      ? kv([
          ['API', statusBadge('healthy', 'Responding')],
          ['Uptime', formatUptime(health.value.data.uptimeSeconds)],
          ['Readiness', readiness ? statusBadge(readiness.status === 'ready' ? 'ready' : 'degraded', readiness.status === 'ready' ? 'Ready' : 'Not ready') : statusBadge('unknown', 'Unknown')],
          ...(readiness
            ? Object.entries(readiness.checks).map(([k, c]) => [humanize(k), c.ok ? 'OK' : (c.detail ?? 'Failing')] as [string, string])
            : []),
        ])
      : errorPanel(health.reason),
  );

  if (providers.status === 'rejected') {
    replace(root, pageHead({ title: 'Overview' }), h('div', { class: 'grid grid--sidebar' }, serverCard, card({ title: 'Providers', icon: 'plug' }, errorPanel(providers.reason, () => void renderOverview(ctx)))));
    return;
  }
  const { providers: list, capabilities } = providers.value.data;
  const real = list.filter((p) => !p.isMock);
  const configuredReal = real.filter((p) => p.configured);
  const mockOn = list.some((p) => p.isMock && p.configured);

  const probeResults = h('div', { attrs: { 'aria-live': 'polite' } });
  const probeBtn = isAdmin
    ? button('Run active probe', {
        small: true,
        icon: 'refresh',
        onClick: () =>
          void withBusy(probeBtn!, 'Probing…', async () => {
            try {
              const res = await api.probeProviders();
              if (signal.aborted) return;
              replace(probeResults, renderProbe(res.data.results));
              toast('Probe complete');
            } catch (err) {
              replace(probeResults, errorPanel(err));
            }
          }),
      })
    : null;

  const providerCard = card(
    { title: 'Providers', icon: 'plug', actions: [probeBtn, linkButton('Refresh', '#/overview', { small: true, variant: 'ghost' })].filter(Boolean) as HTMLElement[] },
    h(
      'div',
      { class: 'stack' },
      mockOn
        ? alert('warn', h('p', {}, h('strong', {}, 'Mock providers are enabled. '), 'Any step served by “mock” returns fake, labelled data. Do not treat those results as real.'))
        : null,
      configuredReal.length === 0
        ? emptyState({
            icon: 'plug',
            title: 'No real providers configured',
            text: 'Add provider keys (for example GEMINI_API_KEY or TAVILY_API_KEY) to the server environment and restart it. Keys are never sent to the browser.',
          })
        : null,
      providerTable(list),
      h('p', { class: 'field__hint' }, 'Health is passive — derived from recent calls on this server — unless an active probe has run. “Unknown” means no calls yet.'),
      probeResults,
    ),
  );

  replace(
    root,
    pageHead({
      title: 'Overview',
      subtitle: 'Live status of this server and its provider integrations.',
      actions: [linkButton('New workflow', '#/workflows/new', { variant: 'primary', icon: 'plus' })],
    }),
    h('div', { class: 'grid grid--sidebar' }, providerCard, h('div', { class: 'grid' }, serverCard, capabilityCard(capabilities))),
  );
}

function providerTable(list: ProviderInfo[]): HTMLElement {
  return table(
    [
      {
        label: 'Provider',
        render: (p) => h('span', { class: 'row__badges' }, h('strong', {}, p.displayName), p.isMock ? badge('Dev only', 'warn') : null),
      },
      { label: 'Status', render: (p) => statusBadge(p.health.status) },
      { label: 'Capabilities', render: (p) => h('span', { class: 'row__badges' }, p.capabilities.map((c) => badge(c.name, c.ready ? 'accent' : 'outline', c.ready ? 'Ready' : 'Not configured'))) },
      {
        label: 'Recent calls',
        render: (p) =>
          p.health.totalCalls === 0
            ? h('span', { class: 'muted' }, 'None yet')
            : h('span', {}, `${p.health.totalCalls} calls · ${p.health.totalErrors} errors`, p.health.lastError ? h('span', { class: 'field__hint' }, ` · last error ${p.health.lastError.code} ${formatRelative(p.health.lastErrorAt)}`) : null),
      },
    ],
    list,
    'Providers',
  );
}

function capabilityCard(caps: CapabilityInfo[]): HTMLElement {
  return card(
    { title: 'Capabilities', icon: 'layers' },
    h(
      'ul',
      { class: 'rows' },
      caps.map((c) =>
        h(
          'li',
          { class: 'row' },
          h(
            'div',
            { class: 'row__main' },
            h('span', { class: 'row__title mono' }, c.name),
            c.available ? statusBadge('ready', 'Available') : statusBadge('disabled', 'Unavailable'),
          ),
          h('p', { class: 'row__meta' }, c.description),
          h(
            'div',
            { class: 'row__meta' },
            h('span', {}, c.providers.length ? `Providers: ${c.providers.join(' → ')}` : 'No configured provider'),
            h('span', {}, c.contentSource === 'model_generated' ? 'Model-generated' : 'Provider data'),
            c.fallbackCompatible ? h('span', {}, 'Fallback allowed') : null,
            c.allowedForCaller ? null : h('span', {}, 'Not permitted for your role'),
          ),
        ),
      ),
    ),
  );
}

function renderProbe(results: ProbeResult[]): HTMLElement {
  return h(
    'div',
    { class: 'stack section-gap' },
    h('h3', {}, 'Probe results'),
    table(
      [
        { label: 'Provider', render: (r) => h('strong', {}, r.id) },
        { label: 'Mode', render: (r) => (r.mode === 'skipped' ? 'Skipped (not configured)' : humanize(r.mode)) },
        { label: 'Status', render: (r) => statusBadge(r.status) },
        { label: 'Detail', render: (r) => (r.error ? `${r.error.code}: ${r.error.message}` : r.latencyMs !== undefined ? `${r.latencyMs} ms` : '—') },
      ],
      results,
      'Probe results',
    ),
  );
}

