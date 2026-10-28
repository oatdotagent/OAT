export type Route =
  | { name: 'overview' }
  | { name: 'workflows' }
  | { name: 'workflow-new' }
  | { name: 'workflow'; id: string }
  | { name: 'executions' }
  | { name: 'execution'; id: string }
  | { name: 'metrics' }
  | { name: 'not-found'; path: string };

const ID = /^[a-z]{2}_[a-f0-9]{32}$/;

/** Hash routes: #/overview, #/workflows, #/workflows/new, #/workflows/:id, #/executions[/:id], #/metrics */
export function parseRoute(hash: string): Route {
  // Ignore any query part (e.g. #/executions?status=failed); views read it themselves.
  const path = hash.replace(/^#/, '').split('?')[0]!.replace(/\/+$/, '') || '/overview';
  const parts = path.split('/').filter(Boolean);
  const [section, arg] = parts;
  if (parts.length > 2) return { name: 'not-found', path };
  switch (section) {
    case 'overview':
      return arg ? { name: 'not-found', path } : { name: 'overview' };
    case 'workflows':
      if (!arg) return { name: 'workflows' };
      if (arg === 'new') return { name: 'workflow-new' };
      return ID.test(arg) && arg.startsWith('wf_') ? { name: 'workflow', id: arg } : { name: 'not-found', path };
    case 'executions':
      if (!arg) return { name: 'executions' };
      return ID.test(arg) && arg.startsWith('ex_') ? { name: 'execution', id: arg } : { name: 'not-found', path };
    case 'metrics':
      return arg ? { name: 'not-found', path } : { name: 'metrics' };
    default:
      return { name: 'not-found', path };
  }
}

/** Which top-level nav item a route belongs to. */
export function navSection(route: Route): string {
  switch (route.name) {
    case 'workflows':
    case 'workflow-new':
    case 'workflow':
      return 'workflows';
    case 'executions':
    case 'execution':
      return 'executions';
    case 'metrics':
      return 'metrics';
    default:
      return 'overview';
  }
}
