import { ACTIVE_STATUSES, ApiError, type Execution, type StepRun, type Verification } from '../../lib/api';
import { h, icon, replace } from '../../lib/dom';
import { formatDateTime, formatDuration, formatRelative, humanize, prettyJson, shortId } from '../../lib/format';
import { toast } from '../../shared/behaviors';
import type { ViewContext } from '../main';
import { alert, badge, button, card, emptyState, errorPanel, field, kv, linkButton, loading, mockBadge, pageHead, statusBadge, withBusy } from '../ui';

const POLL_MS = 1500;
const STATUSES = ['', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
const PAGE = 20;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

// ---------- List ----------

export async function renderExecutions(ctx: ViewContext): Promise<void> {
  const { api, root, signal } = ctx;
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  let status = STATUSES.includes(params.get('status') as (typeof STATUSES)[number]) ? params.get('status')! : '';

  const select = h('select', { class: 'select', attrs: { name: 'status' } }, STATUSES.map((s) => h('option', { attrs: { value: s, selected: s === status } }, s ? humanize(s) : 'All statuses')));
  const listArea = h('div', { attrs: { 'aria-live': 'polite' } });
  let offset = 0;

  const load = async (reset: boolean) => {
    if (reset) {
      offset = 0;
      replace(listArea, loading('Loading executions…'));
    }
    try {
      const res = await api.listExecutions({ status: status || undefined, limit: PAGE, offset });
      if (signal.aborted) return;
      const total = res.meta.page?.total ?? res.data.length;
      if (reset && res.data.length === 0) {
        replace(
          listArea,
          emptyState({
            icon: 'list',
            title: status ? `No ${humanize(status).toLowerCase()} executions` : 'No executions yet',
            text: status ? 'Try another status filter.' : 'Open a workflow and press Run to start one.',
            action: status ? undefined : linkButton('Go to workflows', '#/workflows', { variant: 'primary' }),
          }),
        );
        return;
      }
      const ul = reset ? h('ul', { class: 'rows' }) : (listArea.querySelector('ul.rows') as HTMLElement);
      for (const e of res.data) ul.append(executionRow(e));
      offset += res.data.length;
      const moreBtn: HTMLButtonElement | null = res.meta.page?.hasMore
        ? button(`Load more (${total - offset} remaining)`, { small: true, onClick: () => void withBusy(moreBtn!, 'Loading…', () => load(false)) })
        : null;
      replace(listArea, card({}, ul, h('div', { class: 'section-gap' }, moreBtn ?? h('p', { class: 'field__hint' }, `${total} execution${total === 1 ? '' : 's'}`))));
    } catch (err) {
      if (!signal.aborted) replace(listArea, errorPanel(err, () => void load(true)));
    }
  };

  select.addEventListener('change', () => {
    status = select.value;
    history.replaceState(null, '', `#/executions${status ? `?status=${status}` : ''}`);
    void load(true);
  });

  const refreshBtn = button('Refresh', { small: true, variant: 'ghost', icon: 'refresh', onClick: () => void withBusy(refreshBtn, 'Refreshing…', () => load(true)) });

  replace(
    root,
    pageHead({ title: 'Executions', subtitle: 'Every run of your workflows, newest first.', actions: [refreshBtn] }),
    h('div', { class: 'toolbar' }, field('Status', select)),
    listArea,
  );
  await load(true);
}

function executionRow(e: Execution): HTMLElement {
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'row-link', attrs: { href: `#/executions/${e.id}` } },
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'row__main' }, h('span', { class: 'row__title mono' }, shortId(e.id)), statusBadge(e.status)),
        h(
          'div',
          { class: 'row__meta' },
          h('span', {}, `Workflow ${shortId(e.workflowId)}`),
          h('span', {}, `Started ${formatRelative(e.startedAt ?? e.createdAt)}`),
          h('span', {}, `Duration ${formatDuration(e.durationMs)}`),
          h('span', {}, `Owner ${e.ownerId}`),
        ),
      ),
    ),
  );
}

// ---------- Detail ----------

export async function renderExecution(ctx: ViewContext, id: string): Promise<void> {
  const { api, root, signal } = ctx;
  replace(root, pageHead({ title: 'Execution', back: { href: '#/executions', label: 'Executions' } }), loading('Loading execution…'));

  // UI state preserved across poll refreshes.
  const openOutputs = new Set<string>();
  const verifications = new Map<string, Verification | Error>();
  const header = h('div');
  const body = h('div');
  let first = true;

  const paint = (ex: Execution) => {
    const active = ACTIVE_STATUSES.has(ex.status);
    const steps = ex.steps ?? [];
    const anyMock = steps.some((s) => s.isMock);

    const cancelBtn: HTMLButtonElement | null = active
      ? button('Cancel run', {
          variant: 'danger',
          small: true,
          icon: 'stop',
          onClick: () =>
            void withBusy(cancelBtn!, 'Cancelling…', async () => {
              if (!window.confirm('Cancel this execution? Running steps will be aborted.')) return;
              try {
                await api.cancelExecution(ex.id);
                toast('Cancellation requested');
              } catch (err) {
                toast(err instanceof ApiError ? err.message : 'Could not cancel', 'err');
              }
            }),
        })
      : null;

    replace(
      header,
      pageHead({
        title: shortId(ex.id),
        subtitle: h('span', { class: 'row__badges' }, statusBadge(ex.status), active ? badge('Live · refreshing', 'info') : null, anyMock ? mockBadge() : null),
        back: { href: '#/executions', label: 'Executions' },
        actions: [cancelBtn, linkButton('Workflow', `#/workflows/${ex.workflowId}`, { small: true, variant: 'ghost', icon: 'layers' })].filter(Boolean) as HTMLElement[],
      }),
    );

    replace(
      body,
      h(
        'div',
        { class: 'grid grid--sidebar' },
        h(
          'div',
          { class: 'stack' },
          anyMock ? alert('warn', h('p', {}, h('strong', {}, 'Mock data. '), 'One or more steps were served by the development mock provider. Their output is fake and labelled [MOCK].')) : null,
          ex.error ? alert(ex.status === 'cancelled' ? 'warn' : 'err', h('p', {}, h('strong', {}, `${humanize(ex.error.code)}: `), ex.error.message)) : null,
          card({ title: 'Steps', icon: 'layers' }, steps.length ? h('div', {}, steps.map((s) => stepCard(s))) : emptyState({ title: 'No steps recorded' })),
        ),
        card(
          { title: 'Details', icon: 'info' },
          kv([
            ['Execution', h('span', { class: 'mono' }, ex.id)],
            ['Workflow', h('a', { attrs: { href: `#/workflows/${ex.workflowId}` } }, shortId(ex.workflowId))],
            ['Version', String(ex.workflowVersion)],
            ['Owner', ex.ownerId],
            ['Created', formatDateTime(ex.createdAt)],
            ['Started', formatDateTime(ex.startedAt)],
            ['Finished', formatDateTime(ex.finishedAt)],
            ['Duration', formatDuration(ex.durationMs)],
          ]),
          h('details', { class: 'disclosure section-gap' }, h('summary', {}, 'Show input'), h('pre', { class: 'pre' }, prettyJson(ex.input ?? {}))),
        ),
      ),
    );
    if (first) {
      replace(root, header, body);
      first = false;
    }
  };

  const stepCard = (s: StepRun): HTMLElement => {
    const outputKey = `out:${s.stepId}`;
    const outputDetails = h('details', { class: 'disclosure', attrs: { open: openOutputs.has(outputKey) } }, h('summary', {}, s.outputTruncated ? 'Show output (truncated for storage)' : 'Show output'), h('pre', { class: 'pre' }, prettyJson(s.output)));
    outputDetails.addEventListener('toggle', () => (outputDetails.open ? openOutputs.add(outputKey) : openOutputs.delete(outputKey)));

    const verificationArea = h('div', { attrs: { 'aria-live': 'polite' } });
    if (s.verificationId) {
      const v = verifications.get(s.verificationId);
      if (v instanceof Error) replace(verificationArea, errorPanel(v));
      else if (v) replace(verificationArea, verificationPanel(v));
      else {
        const vBtn: HTMLButtonElement = button('View verification', {
          small: true,
          icon: 'shield-check',
          onClick: () =>
            void withBusy(vBtn, 'Loading…', async () => {
              try {
                const res = await api.getVerification(s.verificationId!);
                verifications.set(s.verificationId!, res.data);
                if (!signal.aborted) replace(verificationArea, verificationPanel(res.data));
              } catch (err) {
                verifications.set(s.verificationId!, err as Error);
                replace(verificationArea, errorPanel(err));
              }
            }),
        });
        replace(verificationArea, vBtn);
      }
    }

    return h(
      'article',
      { class: 'step-card', attrs: { 'aria-label': `Step ${s.stepId}` } },
      h(
        'div',
        { class: 'step-card__head' },
        h('div', { class: 'step-card__title' }, h('code', {}, s.stepId), badge(s.capability, 'accent'), s.isMock ? mockBadge() : null),
        statusBadge(s.status),
      ),
      h(
        'div',
        { class: 'step-card__body' },
        h(
          'div',
          { class: 'row__meta' },
          h('span', {}, `Provider: ${s.provider ?? '—'}`),
          s.fallbackFrom.length ? h('span', {}, `Fell back from ${s.fallbackFrom.join(', ')}`) : null,
          h('span', {}, `Attempts: ${s.attempts}`),
          h('span', {}, `Duration: ${formatDuration(s.durationMs)}`),
        ),
        s.error ? alert(s.status === 'skipped' || s.status === 'cancelled' ? 'warn' : 'err', h('p', {}, h('strong', {}, `${s.error.code}`), s.error.provider ? ` (${s.error.provider})` : '', `: ${s.error.message}`)) : null,
        s.output !== null && s.output !== undefined ? outputDetails : null,
        verificationArea.childElementCount ? verificationArea : null,
      ),
    );
  };

  // Load, then poll while the execution is active.
  for (;;) {
    let ex: Execution;
    try {
      ex = (await api.getExecution(id)).data;
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof ApiError && err.status === 404) {
        replace(root, emptyState({ icon: 'alert', title: 'Execution not found', text: 'It may belong to another user, or the ID is wrong.', action: linkButton('All executions', '#/executions', { variant: 'primary' }) }));
        return;
      }
      if (first) throw err;
      // Transient failure while polling: keep the last view and retry.
      toast('Lost contact with the API; retrying…', 'err');
      await sleep(POLL_MS * 2, signal);
      if (signal.aborted) return;
      continue;
    }
    if (signal.aborted) return;
    paint(ex);
    if (!ACTIVE_STATUSES.has(ex.status)) return;
    await sleep(POLL_MS, signal);
    if (signal.aborted) return;
  }
}

function verificationPanel(v: Verification): HTMLElement {
  const a = v.assessment;
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'row__badges' }, statusBadge(v.status, `Verification ${v.status}`), a.isMock ? mockBadge() : null, badge(a.contentSource === 'model_generated' ? 'Model-generated' : 'Provider data'), a.groundingStatus !== 'not_checked' ? badge(humanize(a.groundingStatus), a.groundingStatus === 'citations_traced' ? 'ok' : 'err') : null),
    // The backend's own wording: it states exactly what was and was not verified.
    alert('info', h('p', {}, a.summary)),
    v.checks.length
      ? h(
          'ul',
          { class: 'checks' },
          v.checks.map((c) =>
            h(
              'li',
              { class: `check ${c.passed ? 'check--pass' : 'check--fail'}` },
              icon(c.passed ? 'check' : 'x'),
              h(
                'div',
                {},
                h('p', {}, h('span', { class: 'visually-hidden' }, c.passed ? 'Passed: ' : 'Failed: '), c.message),
                h('p', { class: 'check__name' }, c.name),
                c.description ? h('p', { class: 'field__hint' }, c.description) : null,
                c.evidence !== undefined ? h('details', { class: 'disclosure' }, h('summary', {}, 'Evidence'), h('pre', { class: 'pre' }, prettyJson(c.evidence))) : null,
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No checks were declared for this step.'),
  );
}
