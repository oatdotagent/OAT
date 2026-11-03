/**
 * Typed client for the backend's /api/v1 routes. Same-origin by default; the only credential the
 * browser ever holds is the user's own API token. Provider keys never leave the server.
 */

export interface Envelope<T> {
  data: T;
  meta: { requestId: string; page?: { limit: number; offset: number; total: number; hasMore: boolean } };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ----- Response types (mirror the backend contracts) -----

export type ExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';
export type HealthStatus = 'disabled' | 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

export interface Me {
  userId: string;
  role: 'admin' | 'user';
  devBypass: boolean;
  permissions: string[];
}

export interface Health {
  status: string;
  uptimeSeconds: number;
}

export interface Readiness {
  status: 'ready' | 'not_ready';
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
  isMock: boolean;
  configured: boolean;
  unavailableReason: string | null;
  capabilities: Array<{ name: string; ready: boolean }>;
  docsUrl: string | null;
  health: {
    status: HealthStatus;
    consecutiveFailures: number;
    totalCalls: number;
    totalErrors: number;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastError: { code: string; message: string } | null;
    probe: 'active' | 'passive';
  };
}

export interface CapabilityInfo {
  name: string;
  description: string;
  contentSource: 'model_generated' | 'provider_data';
  fallbackCompatible: boolean;
  available: boolean;
  unavailableReason: string | null;
  routedTo: string[] | null;
  allowedForCaller: boolean;
  providers: string[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ReadinessCheck {
  stepId: string;
  capability: string;
  provider: string | null;
  ready: boolean;
  allowed: boolean;
  reason: string | null;
}

export interface WorkflowStep {
  id: string;
  name?: string;
  capability: string;
  provider?: string;
  dependsOn: string[];
  continueOnError: boolean;
  input: Record<string, unknown>;
  verification?: { required: boolean; criteria: unknown[]; schema?: unknown };
}

export interface Workflow {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  version: number;
  definition: { name: string; description?: string; inputSchema?: Record<string, unknown>; maxParallelism: number; steps: WorkflowStep[] };
  createdAt: string;
  updatedAt: string;
}

export interface DraftValidation {
  valid: boolean;
  errors: ValidationIssue[];
  stages: string[][];
  readiness: ReadinessCheck[];
}

export interface StoredValidation extends DraftValidation {
  workflowId: string;
  executable: boolean;
  input: { ok: boolean; errors: ValidationIssue[] } | null;
}

export interface StepRun {
  id: string;
  stepId: string;
  capability: string;
  status: StepStatus;
  provider: string | null;
  isMock: boolean;
  attempts: number;
  fallbackFrom: string[];
  output: unknown;
  outputTruncated: boolean;
  error: { code: string; message: string; provider?: string } | null;
  verificationId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface Execution {
  id: string;
  workflowId: string;
  workflowVersion: number;
  ownerId: string;
  status: ExecutionStatus;
  input?: unknown;
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  steps?: StepRun[];
}

export interface Verification {
  id: string;
  executionId: string;
  stepId: string;
  status: 'passed' | 'failed' | 'error';
  checks: Array<{ name: string; type: string; passed: boolean; message: string; description?: string; evidence?: unknown }>;
  assessment: {
    contentSource: 'model_generated' | 'provider_data';
    provider: string;
    isMock: boolean;
    structuralStatus: string;
    groundingStatus: string;
    factualClaimsVerified: false;
    summary: string;
  };
  createdAt: string;
}

export interface ProviderStatRow {
  provider: string;
  capability: string;
  calls: number;
  errors: number;
  attempts: number;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostUsd: number | null;
  isMock: number;
}

export interface Metrics {
  window: { hours: number; since: string };
  http: { since: string; uptimeSeconds: number; routes: Array<{ route: string; count: number; status: Record<string, number>; latencyMs: { p50: number | null; p95: number | null; p99: number | null } }> };
  providers: { byCapability: ProviderStatRow[]; errors: Array<{ provider: string; code: string; count: number }> };
  executions: { byStatus: Array<{ status: string; count: number }>; coordinator: { active: number; queued: number } };
}

export interface ProbeResult {
  id: string;
  mode: 'active' | 'passive' | 'skipped';
  status: HealthStatus;
  latencyMs?: number;
  error?: { code: string; message: string };
}

// ----- Client -----

export interface ApiClientOptions {
  baseUrl?: string;
  getToken?: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createApi(opts: ApiClientOptions = {}) {
  const base = opts.baseUrl ?? '';
  const doFetch = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = opts.timeoutMs ?? 20_000;

  async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Envelope<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = opts.getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await doFetch(`${base}/api/v1${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        credentials: 'omit',
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
      throw new ApiError(0, timedOut ? 'timeout' : 'network_error', timedOut ? 'The server took too long to respond.' : 'Could not reach the API server.');
    }

    let payload: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError(res.status, 'invalid_response', `Unexpected non-JSON response (HTTP ${res.status}).`);
      }
    }
    if (!res.ok) {
      const e = (payload as { error?: { code?: string; message?: string; details?: unknown }; meta?: { requestId?: string } } | null) ?? {};
      throw new ApiError(res.status, e.error?.code ?? 'http_error', e.error?.message ?? `Request failed (HTTP ${res.status}).`, e.error?.details, e.meta?.requestId);
    }
    return payload as Envelope<T>;
  }

  const get = <T>(path: string) => request<T>('GET', path);
  const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
  const qs = (params: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
    const out = s.toString();
    return out ? `?${out}` : '';
  };

  return {
    health: () => get<Health>('/health'),
    ready: () => get<Readiness>('/health/ready'),
    me: () => get<Me>('/me'),
    providers: () => get<{ providers: ProviderInfo[]; capabilities: CapabilityInfo[] }>('/providers'),
    probeProviders: () => post<{ results: ProbeResult[] }>('/providers/health/probe'),
    validateDraft: (definition: unknown) => post<DraftValidation>('/workflows/validate', definition),
    createWorkflow: (definition: unknown) => post<Workflow & { stages: string[][] }>('/workflows', definition),
    listWorkflows: (page: { limit?: number; offset?: number } = {}) => get<Workflow[]>(`/workflows${qs(page)}`),
    getWorkflow: (id: string) => get<Workflow>(`/workflows/${encodeURIComponent(id)}`),
    updateWorkflow: (id: string, definition: unknown) => request<Workflow & { stages: string[][] }>('PUT', `/workflows/${encodeURIComponent(id)}`, definition),
    deleteWorkflow: (id: string) => request<{ id: string; deleted: boolean; executionsDeleted: number }>('DELETE', `/workflows/${encodeURIComponent(id)}`),
    validateWorkflow: (id: string, input?: unknown) =>
      post<StoredValidation>(`/workflows/${encodeURIComponent(id)}/validate`, input === undefined ? {} : { input }),
    startExecution: (id: string, input: unknown) => post<{ id: string; status: ExecutionStatus }>(`/workflows/${encodeURIComponent(id)}/executions`, { input }),
    listExecutions: (q: { workflowId?: string; status?: string; limit?: number; offset?: number } = {}) => get<Execution[]>(`/executions${qs(q)}`),
    getExecution: (id: string) => get<Execution>(`/executions/${encodeURIComponent(id)}`),
    cancelExecution: (id: string) => post<{ id: string; cancelRequested: boolean }>(`/executions/${encodeURIComponent(id)}/cancel`),
    getVerification: (id: string) => get<Verification>(`/verifications/${encodeURIComponent(id)}`),
    metrics: (windowHours: number) => get<Metrics>(`/metrics${qs({ windowHours })}`),
  };
}

export type Api = ReturnType<typeof createApi>;

export const ACTIVE_STATUSES: ReadonlySet<ExecutionStatus> = new Set(['queued', 'running']);
