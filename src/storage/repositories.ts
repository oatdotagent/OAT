import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { redactValue } from '../lib/redact.js';
import type { WorkflowDefinition } from '../orchestration/definition.js';
import type { Assessment, CheckResult } from '../verification/engine.js';
import type { ProviderCallRecord } from '../providers/manager.js';
import { schemaVersion, type Database } from './db.js';

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '')}`;
const now = () => new Date().toISOString();
const parse = <T>(s: string | null | undefined): T | null => (s ? (JSON.parse(s) as T) : null);

/** Serialize with a size cap. Oversized values are replaced by a marked preview, never silently cut. */
export function serializeCapped(value: unknown, maxBytes: number): { json: string; truncated: boolean } {
  const json = JSON.stringify(value ?? null);
  if (Buffer.byteLength(json) <= maxBytes) return { json, truncated: false };
  return {
    json: JSON.stringify({ _truncated: true, originalBytes: Buffer.byteLength(json), preview: json.slice(0, Math.min(4096, maxBytes)) }),
    truncated: true,
  };
}

export interface Page {
  limit: number;
  offset: number;
}

// ---------- Workflows ----------

export interface WorkflowRecord {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  version: number;
  definition: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
}

interface WorkflowRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  version: number;
  definition_json: string;
  created_at: string;
  updated_at: string;
}

const toWorkflow = (r: WorkflowRow): WorkflowRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  name: r.name,
  description: r.description,
  version: r.version,
  definition: JSON.parse(r.definition_json) as WorkflowDefinition,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// ---------- Executions ----------

export type ExecutionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  workflowVersion: number;
  ownerId: string;
  status: ExecutionStatus;
  input: unknown;
  error: unknown;
  requestId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

interface ExecutionRow {
  id: string;
  workflow_id: string;
  workflow_version: number;
  owner_id: string;
  status: ExecutionStatus;
  input_json: string;
  error_json: string | null;
  request_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

const toExecution = (r: ExecutionRow): ExecutionRecord => ({
  id: r.id,
  workflowId: r.workflow_id,
  workflowVersion: r.workflow_version,
  ownerId: r.owner_id,
  status: r.status,
  input: parse(r.input_json),
  error: parse(r.error_json),
  requestId: r.request_id,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.duration_ms,
});

export interface StepRunRecord {
  id: string;
  executionId: string;
  stepId: string;
  capability: string;
  status: StepStatus;
  provider: string | null;
  isMock: boolean;
  attempts: number;
  fallbackFrom: string[];
  output: unknown;
  outputTruncated: boolean;
  error: unknown;
  verificationId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

interface StepRunRow {
  id: string;
  execution_id: string;
  step_id: string;
  capability: string;
  status: StepStatus;
  provider: string | null;
  is_mock: number;
  attempts: number;
  fallback_from: string | null;
  output_json: string | null;
  output_truncated: number;
  error_json: string | null;
  verification_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

const toStepRun = (r: StepRunRow): StepRunRecord => ({
  id: r.id,
  executionId: r.execution_id,
  stepId: r.step_id,
  capability: r.capability,
  status: r.status,
  provider: r.provider,
  isMock: r.is_mock === 1,
  attempts: r.attempts,
  fallbackFrom: parse<string[]>(r.fallback_from) ?? [],
  output: parse(r.output_json),
  outputTruncated: r.output_truncated === 1,
  error: parse(r.error_json),
  verificationId: r.verification_id,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  durationMs: r.duration_ms,
});

// ---------- Verifications ----------

export interface VerificationRecord {
  id: string;
  executionId: string;
  stepId: string;
  ownerId: string;
  status: 'passed' | 'failed' | 'error';
  checks: CheckResult[];
  assessment: Assessment;
  createdAt: string;
}

interface VerificationRow {
  id: string;
  execution_id: string;
  step_id: string;
  owner_id: string;
  status: VerificationRecord['status'];
  checks_json: string;
  assessment_json: string;
  created_at: string;
}

// ---------- Audit ----------

export interface AuditEventInput {
  actorId: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  requestId?: string;
  outcome: 'success' | 'denied' | 'failure';
  details?: unknown;
}

/** All persistence lives behind this class so modules can be tested against an in-memory DB. */
export class Repositories {
  constructor(
    private readonly db: Database,
    private readonly maxStoredOutputBytes = 262_144,
  ) {}

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ----- workflows -----
  createWorkflow(ownerId: string, def: WorkflowDefinition): WorkflowRecord {
    const ts = now();
    const id = newId('wf');
    this.db
      .prepare(
        `INSERT INTO workflows (id, owner_id, name, description, version, definition_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, ownerId, def.name, def.description ?? null, JSON.stringify(def), ts, ts);
    return this.getWorkflow(id)!;
  }

  getWorkflow(id: string): WorkflowRecord | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined;
    return row ? toWorkflow(row) : null;
  }

  listWorkflows(ownerId: string | null, page: Page): { items: WorkflowRecord[]; total: number } {
    const where = ownerId ? 'WHERE owner_id = ?' : '';
    const params: SQLInputValue[] = ownerId ? [ownerId] : [];
    const rows = this.db
      .prepare(`SELECT * FROM workflows ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, page.limit, page.offset) as unknown as WorkflowRow[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM workflows ${where}`).get(...params) as { n: number }).n;
    return { items: rows.map(toWorkflow), total };
  }

  // ----- executions -----
  createExecution(params: {
    workflow: WorkflowRecord;
    ownerId: string;
    input: unknown;
    requestId?: string;
  }): ExecutionRecord {
    const id = newId('ex');
    const ts = now();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO executions (id, workflow_id, workflow_version, owner_id, status, input_json, request_id, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(id, params.workflow.id, params.workflow.version, params.ownerId, JSON.stringify(params.input ?? null), params.requestId ?? null, ts);
      const insertStep = this.db.prepare(
        `INSERT INTO step_runs (id, execution_id, step_id, capability, status) VALUES (?, ?, ?, ?, 'pending')`,
      );
      for (const s of params.workflow.definition.steps) insertStep.run(newId('sr'), id, s.id, s.capability);
    });
    return this.getExecution(id)!;
  }

  getExecution(id: string): ExecutionRecord | null {
    const row = this.db.prepare('SELECT * FROM executions WHERE id = ?').get(id) as ExecutionRow | undefined;
    return row ? toExecution(row) : null;
  }

  listExecutions(
    filter: { ownerId: string | null; workflowId?: string; status?: ExecutionStatus },
    page: Page,
  ): { items: ExecutionRecord[]; total: number } {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.ownerId) {
      clauses.push('owner_id = ?');
      params.push(filter.ownerId);
    }
    if (filter.workflowId) {
      clauses.push('workflow_id = ?');
      params.push(filter.workflowId);
    }
    if (filter.status) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM executions ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, page.limit, page.offset) as unknown as ExecutionRow[];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM executions ${where}`).get(...params) as { n: number }).n;
    return { items: rows.map(toExecution), total };
  }

  markExecutionRunning(id: string): void {
    this.db.prepare(`UPDATE executions SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'`).run(now(), id);
  }

  finishExecution(id: string, status: ExecutionStatus, error?: unknown): void {
    const ts = now();
    const row = this.db.prepare('SELECT started_at, created_at FROM executions WHERE id = ?').get(id) as
      | { started_at: string | null; created_at: string }
      | undefined;
    const startedAt = row?.started_at ?? row?.created_at ?? ts;
    this.db
      .prepare(`UPDATE executions SET status = ?, error_json = ?, finished_at = ?, duration_ms = ? WHERE id = ?`)
      .run(
        status,
        error === undefined ? null : JSON.stringify(redactValue(error)),
        ts,
        Date.parse(ts) - Date.parse(startedAt),
        id,
      );
  }

  /** Executions left running by a previous process cannot be resumed safely; mark them. */
  markOrphanedExecutionsInterrupted(): number {
    const ts = now();
    const error = JSON.stringify({ code: 'interrupted', message: 'Server restarted while execution was in progress' });
    this.db
      .prepare(`UPDATE step_runs SET status = 'cancelled', finished_at = ? WHERE status IN ('pending','running')
                AND execution_id IN (SELECT id FROM executions WHERE status IN ('queued','running'))`)
      .run(ts);
    const res = this.db
      .prepare(`UPDATE executions SET status = 'interrupted', finished_at = ?, error_json = ? WHERE status IN ('queued','running')`)
      .run(ts, error);
    return Number(res.changes);
  }

  // ----- step runs -----
  listStepRuns(executionId: string): StepRunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM step_runs WHERE execution_id = ? ORDER BY rowid')
      .all(executionId) as unknown as StepRunRow[];
    return rows.map(toStepRun);
  }

  markStepRunning(executionId: string, stepId: string): void {
    this.db
      .prepare(`UPDATE step_runs SET status = 'running', started_at = ? WHERE execution_id = ? AND step_id = ?`)
      .run(now(), executionId, stepId);
  }

  finishStep(
    executionId: string,
    stepId: string,
    result: {
      status: StepStatus;
      provider?: string;
      isMock?: boolean;
      attempts?: number;
      fallbackFrom?: string[];
      output?: unknown;
      error?: unknown;
      verificationId?: string;
      durationMs?: number;
    },
  ): void {
    const out = result.output === undefined ? null : serializeCapped(result.output, this.maxStoredOutputBytes);
    this.db
      .prepare(
        `UPDATE step_runs SET status = ?, provider = ?, is_mock = ?, attempts = ?, fallback_from = ?, output_json = ?,
           output_truncated = ?, error_json = ?, verification_id = ?, finished_at = ?, duration_ms = ?
         WHERE execution_id = ? AND step_id = ?`,
      )
      .run(
        result.status,
        result.provider ?? null,
        result.isMock ? 1 : 0,
        result.attempts ?? 0,
        result.fallbackFrom?.length ? JSON.stringify(result.fallbackFrom) : null,
        out?.json ?? null,
        out?.truncated ? 1 : 0,
        result.error === undefined ? null : JSON.stringify(redactValue(result.error)),
        result.verificationId ?? null,
        now(),
        result.durationMs ?? null,
        executionId,
        stepId,
      );
  }

  // ----- verifications -----
  createVerification(v: Omit<VerificationRecord, 'id' | 'createdAt'>): VerificationRecord {
    const id = newId('vf');
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO verifications (id, execution_id, step_id, owner_id, status, checks_json, assessment_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, v.executionId, v.stepId, v.ownerId, v.status, JSON.stringify(redactValue(v.checks)), JSON.stringify(v.assessment), ts);
    return { ...v, id, createdAt: ts };
  }

  getVerification(id: string): VerificationRecord | null {
    const r = this.db.prepare('SELECT * FROM verifications WHERE id = ?').get(id) as VerificationRow | undefined;
    if (!r) return null;
    return {
      id: r.id,
      executionId: r.execution_id,
      stepId: r.step_id,
      ownerId: r.owner_id,
      status: r.status,
      checks: JSON.parse(r.checks_json) as CheckResult[],
      assessment: JSON.parse(r.assessment_json) as Assessment,
      createdAt: r.created_at,
    };
  }

  // ----- audit -----
  audit(e: AuditEventInput): void {
    this.db
      .prepare(
        `INSERT INTO audit_events (id, ts, actor_id, action, resource_type, resource_id, request_id, outcome, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('ae'),
        now(),
        e.actorId,
        e.action,
        e.resourceType ?? null,
        e.resourceId ?? null,
        e.requestId ?? null,
        e.outcome,
        e.details === undefined ? null : JSON.stringify(redactValue(e.details)),
      );
  }

  listAudit(page: Page) {
    const rows = this.db
      .prepare('SELECT * FROM audit_events ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?')
      .all(page.limit, page.offset) as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actorId: r.actor_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      requestId: r.request_id,
      outcome: r.outcome,
      details: parse(r.details_json),
    }));
  }

  // ----- provider calls -----
  recordProviderCall(c: ProviderCallRecord): void {
    this.db
      .prepare(
        `INSERT INTO provider_calls (ts, provider, capability, status, error_code, latency_ms, attempts, input_tokens,
           output_tokens, total_tokens, estimated_cost_usd, is_mock, execution_id, request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.ts,
        c.provider,
        c.capability,
        c.status,
        c.errorCode ?? null,
        c.latencyMs,
        c.attempts,
        c.usage?.inputTokens ?? null,
        c.usage?.outputTokens ?? null,
        c.usage?.totalTokens ?? null,
        c.estimatedCostUsd ?? null,
        c.isMock ? 1 : 0,
        c.executionId ?? null,
        c.requestId ?? null,
      );
  }

  providerStats(sinceIso: string) {
    return this.db
      .prepare(
        `SELECT provider, capability,
                COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                SUM(attempts) AS attempts,
                CAST(AVG(latency_ms) AS INTEGER) AS avgLatencyMs,
                MAX(latency_ms) AS maxLatencyMs,
                SUM(input_tokens) AS inputTokens,
                SUM(output_tokens) AS outputTokens,
                SUM(total_tokens) AS totalTokens,
                SUM(estimated_cost_usd) AS estimatedCostUsd,
                MAX(is_mock) AS isMock
         FROM provider_calls WHERE ts >= ? GROUP BY provider, capability ORDER BY provider, capability`,
      )
      .all(sinceIso) as Array<Record<string, number | string | null>>;
  }

  providerErrorBreakdown(sinceIso: string) {
    return this.db
      .prepare(
        `SELECT provider, error_code AS code, COUNT(*) AS count FROM provider_calls
         WHERE ts >= ? AND status = 'error' GROUP BY provider, error_code ORDER BY count DESC`,
      )
      .all(sinceIso) as Array<{ provider: string; code: string; count: number }>;
  }

  executionStatusCounts(sinceIso: string) {
    return this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM executions WHERE created_at >= ? GROUP BY status`)
      .all(sinceIso) as Array<{ status: string; count: number }>;
  }

  ping(): boolean {
    return (this.db.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
  }

  schemaVersion(): number {
    return schemaVersion(this.db);
  }
}
