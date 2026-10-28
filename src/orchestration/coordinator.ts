import { capabilityDefs, type CapabilityName } from '../providers/capabilities.js';
import { ProviderError } from '../providers/errors.js';
import type { ProviderManager } from '../providers/manager.js';
import type { ExecutionRecord, Repositories, StepStatus, WorkflowRecord } from '../storage/repositories.js';
import { verifyOutput } from '../verification/engine.js';
import type { StepDefinition } from './definition.js';
import { resolveTemplates, TemplateError } from './template.js';

export interface CoordinatorLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface CoordinatorOptions {
  repos: Repositories;
  providers: ProviderManager;
  logger: CoordinatorLogger;
  maxConcurrentExecutions: number;
  executionTimeoutMs: number;
}

interface StepFailure {
  code: string;
  message: string;
  provider?: string;
  retryable?: boolean;
}

/**
 * Coordinates workflow executions: dependency ordering, bounded parallelism, cancellation,
 * timeouts and state tracking. It deliberately contains no planning or model-driven control
 * flow — every step and edge is fixed by the stored definition. Work itself is delegated to
 * external providers through the ProviderManager.
 */
export class WorkflowCoordinator {
  private readonly controllers = new Map<string, AbortController>();
  private readonly inflight = new Map<string, Promise<void>>();
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private shuttingDown = false;

  constructor(private readonly opts: CoordinatorOptions) {}

  /** Starts an execution in the background. Returns immediately; state is persisted as it progresses. */
  start(execution: ExecutionRecord, workflow: WorkflowRecord, requestId?: string): void {
    if (this.shuttingDown) throw new Error('Coordinator is shutting down');
    const controller = new AbortController();
    this.controllers.set(execution.id, controller);
    const p = this.run(execution, workflow, controller, requestId)
      .catch((err) => {
        this.opts.logger.error({ err, executionId: execution.id }, 'execution crashed');
        this.opts.repos.finishExecution(execution.id, 'failed', { code: 'internal_error', message: 'Execution failed unexpectedly' });
      })
      .finally(() => {
        this.controllers.delete(execution.id);
        this.inflight.delete(execution.id);
      });
    this.inflight.set(execution.id, p);
  }

  cancel(executionId: string): boolean {
    const c = this.controllers.get(executionId);
    if (!c) return false;
    c.abort(new Error('cancelled'));
    return true;
  }

  isActive(executionId: string): boolean {
    return this.controllers.has(executionId);
  }

  /** Resolves once the given (or every) in-flight execution settles. Used by tests and shutdown. */
  async whenSettled(executionId?: string): Promise<void> {
    if (executionId) {
      await this.inflight.get(executionId);
      return;
    }
    await Promise.all([...this.inflight.values()]);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const c of this.controllers.values()) c.abort(new Error('shutdown'));
    await this.whenSettled();
  }

  stats() {
    return { active: this.active, queued: this.waiters.length };
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (this.active < this.opts.maxConcurrentExecutions) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(grant);
        if (i !== -1) this.waiters.splice(i, 1);
        reject(new Error('aborted while queued'));
      };
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      this.waiters.push(grant);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    this.active--;
    this.waiters.shift()?.();
  }

  private async run(
    execution: ExecutionRecord,
    workflow: WorkflowRecord,
    controller: AbortController,
    requestId?: string,
  ): Promise<void> {
    const { repos, logger } = this.opts;
    const def = workflow.definition;
    try {
      await this.acquire(controller.signal);
    } catch {
      repos.finishExecution(execution.id, 'cancelled', { code: 'cancelled', message: 'Cancelled before start' });
      this.cancelPending(execution.id, def.steps);
      return;
    }

    const timeoutSignal = AbortSignal.timeout(this.opts.executionTimeoutMs);
    const signal = AbortSignal.any([controller.signal, timeoutSignal]);
    const started = Date.now();
    repos.markExecutionRunning(execution.id);
    logger.info({ executionId: execution.id, workflowId: workflow.id, requestId }, 'execution started');

    const status = new Map<string, StepStatus>(def.steps.map((s) => [s.id, 'pending']));
    const outputs: Record<string, { output: unknown }> = {};
    const running = new Map<string, Promise<void>>();

    try {
      for (;;) {
        if (signal.aborted) break;
        // Skip steps whose dependencies can no longer succeed.
        for (const s of def.steps) {
          if (status.get(s.id) !== 'pending') continue;
          if (s.dependsOn.some((d) => ['failed', 'skipped', 'cancelled'].includes(status.get(d)!))) {
            status.set(s.id, 'skipped');
            repos.finishStep(execution.id, s.id, {
              status: 'skipped',
              error: { code: 'dependency_failed', message: 'A dependency did not succeed' },
            });
          }
        }
        const ready = def.steps.filter(
          (s) => status.get(s.id) === 'pending' && !running.has(s.id) && s.dependsOn.every((d) => status.get(d) === 'succeeded'),
        );
        for (const s of ready) {
          if (running.size >= def.maxParallelism) break;
          status.set(s.id, 'running');
          const p = this.runStep(execution, s, outputs, signal, requestId).then((st) => {
            status.set(s.id, st);
            running.delete(s.id);
          });
          running.set(s.id, p);
        }
        if (running.size === 0) break; // nothing runnable and nothing in flight → done
        await Promise.race(running.values());
      }
      await Promise.all(running.values());
    } finally {
      this.release();
    }

    // Anything never started is cancelled (abort/timeout path).
    for (const s of def.steps) {
      if (status.get(s.id) === 'pending') {
        status.set(s.id, 'cancelled');
        repos.finishStep(execution.id, s.id, { status: 'cancelled' });
      }
    }

    const durationMs = Date.now() - started;
    if (controller.signal.aborted) {
      repos.finishExecution(execution.id, 'cancelled', { code: 'cancelled', message: 'Execution was cancelled' });
    } else if (timeoutSignal.aborted) {
      repos.finishExecution(execution.id, 'failed', {
        code: 'execution_timeout',
        message: `Execution exceeded ${this.opts.executionTimeoutMs}ms`,
      });
    } else {
      // continueOnError steps may fail (or be skipped) without failing the execution.
      const fatal = def.steps.filter((s) => status.get(s.id) !== 'succeeded' && !s.continueOnError);
      if (fatal.length > 0) {
        repos.finishExecution(execution.id, 'failed', {
          code: 'steps_failed',
          message: 'One or more steps did not succeed',
          steps: fatal.map((s) => ({ stepId: s.id, status: status.get(s.id) })),
        });
      } else {
        repos.finishExecution(execution.id, 'succeeded');
      }
    }
    logger.info({ executionId: execution.id, durationMs, requestId }, 'execution finished');
  }

  private cancelPending(executionId: string, steps: StepDefinition[]): void {
    for (const s of steps) this.opts.repos.finishStep(executionId, s.id, { status: 'cancelled' });
  }

  private async runStep(
    execution: ExecutionRecord,
    step: StepDefinition,
    outputs: Record<string, { output: unknown }>,
    signal: AbortSignal,
    requestId?: string,
  ): Promise<StepStatus> {
    const { repos, providers } = this.opts;
    const started = Date.now();
    repos.markStepRunning(execution.id, step.id);

    const fail = (error: StepFailure, extra: { provider?: string; attempts?: number; output?: unknown; verificationId?: string } = {}) => {
      const st: StepStatus = error.code === 'cancelled' ? 'cancelled' : 'failed';
      repos.finishStep(execution.id, step.id, { status: st, error, durationMs: Date.now() - started, ...extra });
      return st;
    };

    let input: unknown;
    try {
      input = resolveTemplates(step.input, { input: execution.input, steps: outputs });
    } catch (err) {
      if (err instanceof TemplateError) return fail({ code: 'template_error', message: err.message });
      throw err;
    }

    try {
      const res = await providers.invoke(step.capability, input, {
        provider: step.provider,
        signal,
        timeoutMs: step.timeoutMs,
        maxRetries: step.maxRetries,
        executionId: execution.id,
        requestId,
      });

      let verificationId: string | undefined;
      let verificationFailed = false;
      if (step.verification) {
        const outcome = verifyOutput({
          output: res.output,
          spec: step.verification,
          contentSource: capabilityDefs[step.capability as CapabilityName].contentSource,
          provider: res.provider,
          isMock: res.isMock,
          stepOutputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, v.output])),
        });
        const record = repos.createVerification({
          executionId: execution.id,
          stepId: step.id,
          ownerId: execution.ownerId,
          ...outcome,
        });
        verificationId = record.id;
        verificationFailed = step.verification.required && outcome.status !== 'passed';
      }

      const common = {
        provider: res.provider,
        isMock: res.isMock,
        attempts: res.attempts,
        fallbackFrom: res.fallbackFrom,
        output: res.output,
        verificationId,
      };
      if (verificationFailed) {
        return fail({ code: 'verification_failed', message: 'Required verification did not pass' }, common);
      }
      outputs[step.id] = { output: res.output };
      repos.finishStep(execution.id, step.id, { status: 'succeeded', durationMs: Date.now() - started, ...common });
      return 'succeeded';
    } catch (err) {
      if (err instanceof ProviderError) {
        return fail({ code: err.code, message: err.message, provider: err.provider, retryable: err.retryable });
      }
      this.opts.logger.error({ err, executionId: execution.id, stepId: step.id }, 'step crashed');
      return fail({ code: 'internal_error', message: 'Step failed unexpectedly' });
    }
  }
}
