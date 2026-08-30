// @ts-check

import { NotFoundError, normalizeError } from '../../core/src/errors.js';
import { createExecutionRunStore } from '../../core/src/execution-run-store.js';

/**
 * @typedef {{
 *   name: string,
 *   description: string,
 *   steps: Array<{
 *     name: string,
 *     execute: (context: WorkflowStepContext) => unknown | Promise<unknown>,
 *     compensate?: (context: WorkflowStepContext & {stepOutput: unknown}) => unknown | Promise<unknown>
 *   }>
 * }} WorkflowDefinition
 *
 * @typedef {{
 *   input: any,
 *   state: Record<string, any>,
 *   actor: unknown,
 *   runId: string,
 *   services: Record<string, any>,
 *   database: any,
 *   config: Record<string, any>
 * }} WorkflowStepContext
 */

export class WorkflowEngine {
  /** @type {ReturnType<typeof createExecutionRunStore>} */
  #runs;

  /** @param {{database: any, services: Record<string, any>, config?: Record<string, any>}} dependencies */
  constructor({ database, services, config = {} }) {
    this.database = database;
    this.services = services;
    this.config = config;
    // Run and span persistence, owned by the kernel rather than by this
    // engine. Built once because `this.database` is: `packages/app/src/create-app.js`
    // is the only construction site and never hands over a second handle.
    // Genuinely private, so composing an application does not put a persistence
    // object on the engine every in-process caller already holds.
    this.#runs = createExecutionRunStore(database);
    /** @type {Map<string, WorkflowDefinition>} */
    this.workflows = new Map();
  }

  /** @param {WorkflowDefinition} definition */
  register(definition) {
    if (this.workflows.has(definition.name)) {
      throw new Error(`Workflow already registered: ${definition.name}`);
    }
    this.workflows.set(definition.name, definition);
    return definition;
  }

  list() {
    return [...this.workflows.values()].map((workflow) => ({
      name: workflow.name,
      description: workflow.description,
      steps: workflow.steps.map((step) => step.name),
    }));
  }

  /** @param {string} name @param {any} input @param {{actor?: unknown}} [context] */
  async run(name, input, context = {}) {
    const workflow = this.workflows.get(name);
    if (!workflow) throw new NotFoundError('Workflow', name);
    const runId = await this.#runs.startRun({ workflowName: name, input });

    /** @type {Record<string, any>} */
    let state = {};
    /** @type {Array<{definition: WorkflowDefinition['steps'][number], output: unknown}>} */
    const completed = [];

    try {
      for (const step of workflow.steps) {
        const spanId = await this.#runs.startSpan({ runId, name: step.name, input: { input, state } });

        try {
          const output = await step.execute({
            input,
            state,
            actor: context.actor,
            runId,
            services: this.services,
            database: this.database,
            config: this.config,
          });
          if (output && typeof output === 'object' && !Array.isArray(output)) {
            state = { ...state, ...output };
          } else if (output !== undefined) {
            state = { ...state, [step.name]: output };
          }
          completed.push({ definition: step, output });
          await this.#runs.completeSpan({ spanId, output });
        } catch (error) {
          const normalized = normalizeError(error);
          await this.#runs.failSpan({ spanId, error: normalized.message });
          throw normalized;
        }
      }

      const output = state;
      await this.#runs.completeRun({ runId, output });
      return { runId, status: 'completed', output };
    } catch (error) {
      const normalized = normalizeError(error);
      for (const item of [...completed].reverse()) {
        if (!item.definition.compensate) continue;
        try {
          await item.definition.compensate({
            input,
            state,
            actor: context.actor,
            runId,
            services: this.services,
            database: this.database,
            config: this.config,
            stepOutput: item.output,
          });
        } catch (compensationError) {
          const compensation = normalizeError(compensationError);
          console.error(`[accordo] compensation failed in ${item.definition.name}: ${compensation.message}`);
        }
      }
      await this.#runs.failRun({ runId, error: normalized.message, output: state });
      normalized.details = {
        ...(normalized.details && typeof normalized.details === 'object' ? normalized.details : {}),
        workflowRunId: runId,
      };
      throw normalized;
    }
  }

  /** @param {{status?: string, workflowName?: string, limit?: number}} [filters] */
  listRuns(filters = {}) {
    return this.#runs.listRuns({
      status: filters.status,
      workflowName: filters.workflowName,
      limit: filters.limit,
    });
  }

  /** @param {string} id */
  getRun(id) {
    const run = this.#runs.getRun(id);
    if (run && typeof run.then === 'function') {
      return run.then((resolved) => {
        if (!resolved) throw new NotFoundError('Workflow run', id);
        return resolved;
      });
    }
    if (!run) throw new NotFoundError('Workflow run', id);
    return run;
  }
}
