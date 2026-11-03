import { ApiError, type DraftValidation, type Execution, type StoredValidation, type Workflow } from '../../lib/api';
import { h, replace } from '../../lib/dom';
import { formatDuration, formatRelative, parseJsonInput, prettyJson, shortId } from '../../lib/format';
import { toast } from '../../shared/behaviors';
import type { ViewContext } from '../main';
import { sampleInput, TEMPLATES } from '../templates';
import { alert, badge, button, card, emptyState, errorPanel, field, kv, linkButton, loading, pageHead, statusBadge, table, withBusy } from '../ui';

const PAGE = 20;

// ---------- List ----------

export async function renderWorkflows(ctx: ViewContext): Promise<void> {
  const { api, root, signal } = ctx;
  const head = pageHead({
    title: 'Workflows',
    subtitle: 'Declarative DAGs of provider calls. Validate before saving; run from the detail page.',
    actions: [linkButton('New workflow', '#/workflows/new', { variant: 'primary', icon: 'plus' })],
  });
  replace(root, head, loading('Loading workflows…'));

  const list = h('ul', { class: 'rows' });
  const more = h('div', { class: 'section-gap' });
  let offset = 0;

  const load = async () => {
    const res = await api.listWorkflows({ limit: PAGE, offset });
    if (signal.aborted) return;
    const total = res.meta.page?.total ?? res.data.length;
    if (offset === 0 && res.data.length === 0) {
      replace(
        root,
        head,
        emptyState({
          icon: 'layers',
          title: 'No workflows yet',
          text: 'Start from a template — research brief, page digest or repository snapshot — and validate it against this server’s providers.',
          action: linkButton('Create your first workflow', '#/workflows/new', { variant: 'primary', icon: 'plus' }),
        }),
      );
      return;
    }
    for (const w of res.data) list.append(workflowRow(w));
    offset += res.data.length;
    replace(
      more,
      res.meta.page?.hasMore
        ? button(`Load more (${total - offset} remaining)`, {
            small: true,
            onClick: () => void withBusy(more.querySelector('button')!, 'Loading…', () => load().catch((err) => replace(more, errorPanel(err)))),
          })
        : h('p', { class: 'field__hint' }, `${total} workflow${total === 1 ? '' : 's'}`),
    );
  };

  try {
    await load();
  } catch (err) {
    if (!signal.aborted) replace(root, head, errorPanel(err, () => void renderWorkflows(ctx)));
    return;
  }
  if (signal.aborted || !list.childElementCount) return;
  replace(root, head, card({}, list, more));
}

function workflowRow(w: Workflow): HTMLElement {
  const caps = [...new Set(w.definition.steps.map((s) => s.capability))];
  return h(
    'li',
    {},
    h(
      'a',
      { class: 'row-link', attrs: { href: `#/workflows/${w.id}` } },
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'row__main' }, h('span', { class: 'row__title' }, w.name), h('span', { class: 'row__badges' }, caps.map((c) => badge(c, 'accent')))),
        h(
          'div',
          { class: 'row__meta' },
          h('span', { class: 'mono' }, shortId(w.id)),
          h('span', {}, `${w.definition.steps.length} step${w.definition.steps.length === 1 ? '' : 's'}`),
          h('span', {}, `Created ${formatRelative(w.createdAt)}`),
          h('span', {}, `Owner ${w.ownerId}`),
        ),
      ),
    ),
  );
}

// ---------- Editor ----------

const workflowNotFound = () =>
  emptyState({ icon: 'alert', title: 'Workflow not found', text: 'It may belong to another user, or the ID is wrong.', action: linkButton('All workflows', '#/workflows', { variant: 'primary' }) });

export async function renderWorkflowEditor(ctx: ViewContext, editId?: string): Promise<void> {
  const { api, root, signal } = ctx;
  let editing: Workflow | null = null;
  if (editId) {
    replace(root, pageHead({ title: 'Edit workflow', back: { href: `#/workflows/${editId}`, label: 'Workflow' } }), loading('Loading workflow…'));
    try {
      editing = (await api.getWorkflow(editId)).data;
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof ApiError && err.status === 404) {
        replace(root, workflowNotFound());
        return;
      }
      throw err;
    }
    if (signal.aborted) return;
  }
  const target = editing;
  let selected = TEMPLATES[0]!;
  const textarea = h('textarea', {
    class: 'textarea',
    attrs: { rows: 22, wrap: 'off', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-describedby': 'editor-hint' },
  });
  textarea.value = prettyJson(target ? target.definition : selected.definition);
  const notValidated = () => h('p', { class: 'muted' }, 'Not validated yet. Press Validate to check this definition against the server.');
  const results = h('div', { class: 'stack', attrs: { 'aria-live': 'polite' } }, notValidated());

  // Any edit invalidates the previous server validation result.
  textarea.addEventListener('input', () => {
    textarea.removeAttribute('aria-invalid');
    replace(results, notValidated());
  });

  const picker = h(
    'div',
    { class: 'template-picker', attrs: { role: 'group', 'aria-label': 'Templates' } },
    TEMPLATES.map((t) =>
      h(
        'button',
        {
          class: 'template',
          attrs: { type: 'button', 'aria-pressed': String(t === selected) },
          on: {
            click: (e) => {
              const current = parseJsonInput(textarea.value);
              const isPristine = current.ok && JSON.stringify(current.value) === JSON.stringify(selected.definition);
              if (!isPristine && !window.confirm('Replace your edits with this template?')) return;
              selected = t;
              textarea.value = prettyJson(t.definition);
              picker.querySelectorAll('.template').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
              replace(results, notValidated());
            },
          },
        },
        h('span', { class: 'template__name' }, t.name),
        h('span', { class: 'template__desc' }, t.description),
      ),
    ),
  );

  const parse = (): unknown | undefined => {
    const r = parseJsonInput(textarea.value);
    if (!r.ok) {
      textarea.setAttribute('aria-invalid', 'true');
      replace(results, alert('err', h('p', {}, r.error)));
      textarea.focus();
      return undefined;
    }
    textarea.removeAttribute('aria-invalid');
    return r.value;
  };

  const validateBtn = button('Validate', {
    icon: 'check',
    onClick: () =>
      void withBusy(validateBtn, 'Validating…', async () => {
        const def = parse();
        if (def === undefined) return;
        try {
          const res = await api.validateDraft(def);
          if (!signal.aborted) replace(results, validationResult(res.data));
        } catch (err) {
          replace(results, errorPanel(err));
        }
      }),
  });

  const createBtn = button(target ? 'Save changes' : 'Create workflow', {
    variant: 'primary',
    icon: target ? 'check' : 'plus',
    onClick: () =>
      void withBusy(createBtn, target ? 'Saving…' : 'Creating…', async () => {
        const def = parse();
        if (def === undefined) return;
        try {
          const res = target ? await api.updateWorkflow(target.id, def) : await api.createWorkflow(def);
          toast(target ? `Saved “${res.data.name}” as version ${res.data.version}` : `Created “${res.data.name}”`);
          ctx.navigate(`#/workflows/${res.data.id}`);
        } catch (err) {
          if (err instanceof ApiError && err.code === 'invalid_workflow') {
            textarea.setAttribute('aria-invalid', 'true');
            replace(results, validationResult({ valid: false, errors: (err.details as DraftValidation['errors']) ?? [], stages: [], readiness: [] }));
          } else replace(results, errorPanel(err));
        }
      }),
  });

  replace(
    root,
    target
      ? pageHead({ title: `Edit ${target.name}`, subtitle: `Saving creates version ${target.version + 1}. Past executions keep the version they ran.`, back: { href: `#/workflows/${target.id}`, label: target.name } })
      : pageHead({ title: 'New workflow', subtitle: 'Pick a template, edit the JSON, validate, then create.', back: { href: '#/workflows', label: 'Workflows' } }),
    h(
      'div',
      { class: 'grid grid--sidebar' },
      card(
        { title: 'Definition', icon: 'layers' },
        target ? null : picker,
        field('Workflow JSON', textarea),
        h('p', { class: 'field__hint', attrs: { id: 'editor-hint' } }, 'Reference inputs with {{input.name}} and earlier steps with {{steps.<id>.output.<path>}}. Referenced steps must be listed in dependsOn.'),
        h('div', { class: 'editor-actions' }, validateBtn, createBtn),
      ),
      card({ title: 'Validation', icon: 'shield-check' }, results, h('p', { class: 'field__hint' }, 'Validation runs on the server: structure, dependency cycles, template references, schema safety, and whether a configured provider can serve each step.')),
    ),
  );
}

function validationResult(v: DraftValidation): HTMLElement {
  if (!v.valid) {
    return alert(
      'err',
      h('p', {}, h('strong', {}, `${v.errors.length} problem${v.errors.length === 1 ? '' : 's'} found`)),
      h('ul', {}, v.errors.map((e) => h('li', {}, h('code', {}, e.path), ` ${e.message}`))),
    );
  }
  const notReady = v.readiness.filter((r) => !r.ready || !r.allowed);
  return h(
    'div',
    { class: 'stack' },
    alert('ok', h('p', {}, h('strong', {}, 'Definition is valid.'), notReady.length ? ' Some steps cannot run on this server yet — see below.' : ' Every step has a configured provider.')),
    h('h3', {}, 'Execution plan'),
    stagesList(v.stages),
    v.readiness.length ? readinessTable(v.readiness) : null,
  );
}

function stagesList(stages: string[][]): HTMLElement {
  return h(
    'ol',
    { class: 'stages', attrs: { 'aria-label': 'Stages; steps within a stage run in parallel' } },
    stages.map((s, i) => h('li', {}, h('span', { class: 'stages__label' }, `Stage ${i + 1}`), s.map((id) => badge(id, 'accent')))),
  );
}

function readinessTable(rows: DraftValidation['readiness']): HTMLElement {
  return table(
    [
      { label: 'Step', render: (r) => h('code', {}, r.stepId) },
      { label: 'Capability', render: (r) => h('span', { class: 'mono' }, r.capability) },
      { label: 'Provider', render: (r) => r.provider ?? 'Auto' },
      {
        label: 'Ready',
        render: (r) => (!r.allowed ? statusBadge('failed', 'Not permitted') : r.ready ? statusBadge('ready', 'Ready') : statusBadge('degraded', 'No provider')),
      },
    ],
    rows,
    'Step readiness',
  );
}

// ---------- Detail ----------

export async function renderWorkflow(ctx: ViewContext, id: string): Promise<void> {
  const { api, root, signal } = ctx;
  replace(root, pageHead({ title: 'Workflow', back: { href: '#/workflows', label: 'Workflows' } }), loading('Loading workflow…'));

  let wf: Workflow;
  try {
    wf = (await api.getWorkflow(id)).data;
  } catch (err) {
    if (signal.aborted) return;
    if (err instanceof ApiError && err.status === 404) {
      replace(root, workflowNotFound());
      return;
    }
    throw err;
  }
  if (signal.aborted) return;

  const checkArea = h('div', { attrs: { 'aria-live': 'polite' } }, loading('Checking readiness…'));
  const runFeedback = h('div', { attrs: { 'aria-live': 'polite' } });
  const inputArea = h('textarea', { class: 'textarea', attrs: { rows: 8, wrap: 'off', spellcheck: 'false', autocapitalize: 'off' } });
  inputArea.value = prettyJson(sampleInput(wf.definition.inputSchema));

  const readInput = (): unknown | undefined => {
    const r = parseJsonInput(inputArea.value);
    if (!r.ok) {
      inputArea.setAttribute('aria-invalid', 'true');
      replace(runFeedback, alert('err', h('p', {}, r.error)));
      return undefined;
    }
    inputArea.removeAttribute('aria-invalid');
    return r.value;
  };

  const checkBtn = button('Check input', {
    icon: 'check',
    onClick: () =>
      void withBusy(checkBtn, 'Checking…', async () => {
        const input = readInput();
        if (input === undefined) return;
        try {
          const res = await api.validateWorkflow(wf.id, input);
          if (signal.aborted) return;
          replace(runFeedback, inputResult(res.data));
        } catch (err) {
          replace(runFeedback, errorPanel(err));
        }
      }),
  });

  const runBtn = button('Run workflow', {
    variant: 'primary',
    icon: 'play',
    onClick: () =>
      void withBusy(runBtn, 'Starting…', async () => {
        const input = readInput();
        if (input === undefined) return;
        try {
          const res = await api.startExecution(wf.id, input);
          toast('Execution started');
          ctx.navigate(`#/executions/${res.data.id}`);
        } catch (err) {
          replace(runFeedback, errorPanel(err));
        }
      }),
  });

  const deleteBtn = button('Delete', {
    variant: 'danger',
    icon: 'trash',
    onClick: () => {
      if (!window.confirm(`Permanently delete “${wf.name}” and all of its executions, verifications and evidence? This cannot be undone.`)) return;
      void withBusy(deleteBtn, 'Deleting…', async () => {
        try {
          const res = await api.deleteWorkflow(wf.id);
          const n = res.data.executionsDeleted;
          toast(`Deleted “${wf.name}” and ${n} execution${n === 1 ? '' : 's'}`);
          ctx.navigate('#/workflows');
        } catch (err) {
          replace(runFeedback, errorPanel(err));
        }
      });
    },
  });

  const recent = h('div', {}, loading('Loading recent runs…'));

  replace(
    root,
    pageHead({
      title: wf.name,
      subtitle: wf.description ?? undefined,
      back: { href: '#/workflows', label: 'Workflows' },
      actions: [linkButton('Edit', `#/workflows/${wf.id}/edit`, { icon: 'edit' }), deleteBtn],
    }),
    h(
      'div',
      { class: 'grid grid--sidebar' },
      h(
        'div',
        { class: 'grid' },
        card(
          { title: 'Run', icon: 'play' },
          field('Execution input (JSON)', inputArea, wf.definition.inputSchema ? 'Validated against the workflow’s inputSchema before the run starts.' : 'This workflow declares no inputSchema; any JSON object is accepted.'),
          h('div', { class: 'editor-actions' }, checkBtn, runBtn),
          h('div', { class: 'section-gap' }, runFeedback),
        ),
        card({ title: 'Steps', icon: 'layers' }, stepsTable(wf)),
        card({ title: 'Recent executions', icon: 'list', actions: [linkButton('All', `#/executions`, { small: true, variant: 'ghost' })] }, recent),
      ),
      h(
        'div',
        { class: 'grid' },
        card({ title: 'Readiness', icon: 'shield-check' }, checkArea),
        card(
          { title: 'Details', icon: 'info' },
          kv([
            ['ID', h('span', { class: 'mono' }, wf.id)],
            ['Owner', wf.ownerId],
            ['Version', String(wf.version)],
            ['Max parallelism', String(wf.definition.maxParallelism)],
            ['Created', formatRelative(wf.createdAt)],
          ]),
          h('details', { class: 'disclosure section-gap' }, h('summary', {}, 'Show definition JSON'), h('pre', { class: 'pre' }, prettyJson(wf.definition))),
        ),
      ),
    ),
  );

  void api
    .validateWorkflow(wf.id)
    .then((res) => {
      if (signal.aborted) return;
      replace(checkArea, readinessSummary(res.data));
      if (!res.data.executable) runBtn.setAttribute('aria-describedby', 'not-executable');
    })
    .catch((err) => !signal.aborted && replace(checkArea, errorPanel(err)));

  void api
    .listExecutions({ workflowId: wf.id, limit: 5 })
    .then((res) => {
      if (signal.aborted) return;
      replace(recent, res.data.length ? recentList(res.data) : emptyState({ icon: 'list', title: 'No runs yet', text: 'Run the workflow to see its executions here.' }));
    })
    .catch((err) => !signal.aborted && replace(recent, errorPanel(err)));
}

function stepsTable(wf: Workflow): HTMLElement {
  return table(
    [
      { label: 'Step', render: (s) => h('code', {}, s.id) },
      { label: 'Capability', render: (s) => h('span', { class: 'mono' }, s.capability) },
      { label: 'Depends on', render: (s) => (s.dependsOn.length ? s.dependsOn.join(', ') : '—') },
      {
        label: 'Verification',
        render: (s) => (s.verification ? h('span', {}, `${s.verification.criteria.length} criteria${s.verification.schema ? ' + schema' : ''}`, s.verification.required ? ' · required' : '') : 'None'),
      },
    ],
    wf.definition.steps,
    'Workflow steps',
  );
}

function readinessSummary(v: StoredValidation): HTMLElement {
  return h(
    'div',
    { class: 'stack' },
    v.executable
      ? alert('ok', h('p', {}, 'All steps can run on this server.'))
      : h('div', { attrs: { id: 'not-executable' } }, alert('warn', h('p', {}, v.valid ? 'Some steps have no configured provider or are not permitted for your role. Runs will be refused until that changes.' : 'This stored definition no longer validates.'))),
    v.stages.length ? stagesList(v.stages) : null,
    v.readiness.length ? readinessTable(v.readiness) : null,
  );
}

function inputResult(v: StoredValidation): HTMLElement {
  if (!v.input) return alert('info', h('p', {}, 'No input was checked.'));
  if (v.input.ok) return alert('ok', h('p', {}, v.executable ? 'Input is valid and the workflow is ready to run.' : 'Input is valid, but some steps cannot run on this server yet.'));
  return alert('err', h('p', {}, h('strong', {}, 'Input does not match the inputSchema')), h('ul', {}, v.input.errors.map((e) => h('li', {}, h('code', {}, e.path), ` ${e.message}`))));
}

function recentList(items: Execution[]): HTMLElement {
  return h(
    'ul',
    { class: 'rows' },
    items.map((e) =>
      h(
        'li',
        {},
        h(
          'a',
          { class: 'row-link', attrs: { href: `#/executions/${e.id}` } },
          h('div', { class: 'row' }, h('div', { class: 'row__main' }, h('span', { class: 'row__title mono' }, shortId(e.id)), statusBadge(e.status)), h('div', { class: 'row__meta' }, h('span', {}, formatRelative(e.createdAt)), h('span', {}, formatDuration(e.durationMs)))),
        ),
      ),
    ),
  );
}

