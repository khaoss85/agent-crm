// @ts-check

import { randomUUID } from 'node:crypto';
import { NotFoundError, normalizeError } from '../../core/src/errors.js';
import { nowIso } from '../../core/src/time.js';

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
  /** @param {{database: any, services: Record<string, any>, config?: Record<string, any>}} dependencies */
  constructor({ database, services, config = {} }) {
    this.database = database;
    this.services = services;
    this.config = config;
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
    const runId = randomUUID();
    const startedAt = nowIso();
    this.database.raw.prepare(`
      INSERT INTO workflow_runs(
        id, workflow_name, status, input_json, output_json, error, started_at, finished_at
      ) VALUES (?, ?, 'running', ?, NULL, NULL, ?, NULL)
    `).run(runId, name, stringify(input), startedAt);

    /** @type {Record<string, any>} */
    let state = {};
    /** @type {Array<{definition: WorkflowDefinition['steps'][number], output: unknown}>} */
    const completed = [];

    try {
      for (const step of workflow.steps) {
        const spanId = randomUUID();
        const stepStartedAt = nowIso();
        this.database.raw.prepare(`
          INSERT INTO trace_spans(
            id, run_id, parent_span_id, name, status, input_json, output_json, error,
            started_at, finished_at
          ) VALUES (?, ?, NULL, ?, 'running', ?, NULL, NULL, ?, NULL)
        `).run(spanId, runId, step.name, stringify({ input, state }), stepStartedAt);

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
          this.database.raw.prepare(`
            UPDATE trace_spans
            SET status = 'completed', output_json = ?, finished_at = ?
            WHERE id = ?
          `).run(stringify(output), nowIso(), spanId);
        } catch (error) {
          const normalized = normalizeError(error);
          this.database.raw.prepare(`
            UPDATE trace_spans
            SET status = 'failed', error = ?, finished_at = ?
            WHERE id = ?
          `).run(normalized.message, nowIso(), spanId);
          throw normalized;
        }
      }

      const output = state;
      this.database.raw.prepare(`
        UPDATE workflow_runs
        SET status = 'completed', output_json = ?, finished_at = ?
        WHERE id = ?
      `).run(stringify(output), nowIso(), runId);
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
      this.database.raw.prepare(`
        UPDATE workflow_runs
        SET status = 'failed', error = ?, output_json = ?, finished_at = ?
        WHERE id = ?
      `).run(normalized.message, stringify(state), nowIso(), runId);
      normalized.details = {
        ...(normalized.details && typeof normalized.details === 'object' ? normalized.details : {}),
        workflowRunId: runId,
      };
      throw normalized;
    }
  }

  /** @param {{status?: string, workflowName?: string, limit?: number}} [filters] */
  listRuns(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    if (filters.workflowName) {
      clauses.push('workflow_name = ?');
      params.push(filters.workflowName);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    return this.database.raw.prepare(`
      SELECT * FROM workflow_runs ${where}
      ORDER BY started_at DESC LIMIT ?
    `).all(...params, limit).map(mapRunRow);
  }

  /** @param {string} id */
  getRun(id) {
    const row = this.database.raw.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('Workflow run', id);
    const spans = this.database.raw.prepare(`
      SELECT * FROM trace_spans WHERE run_id = ? ORDER BY started_at ASC
    `).all(id).map(mapSpanRow);
    return { ...mapRunRow(row), spans };
  }
}

/** @param {unknown} value */
function stringify(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

/** @param {string | null | undefined} value */
function parse(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** @param {any} row */
function mapRunRow(row) {
  return {
    id: row.id,
    workflowName: row.workflow_name,
    status: row.status,
    input: parse(row.input_json),
    output: parse(row.output_json),
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** @param {any} row */
function mapSpanRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    parentSpanId: row.parent_span_id,
    name: row.name,
    status: row.status,
    input: parse(row.input_json),
    output: parse(row.output_json),
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
