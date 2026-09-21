// @ts-check

export class AccordoClient {
  /**
   * @param {{
   *   baseUrl?: string,
   *   actor?: {type: string, id: string},
   *   headers?: Record<string, string>,
   *   fetchImpl?: typeof fetch,
   * }} [options]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:4000').replace(/\/$/, '');
    const actor = options.actor ?? { type: 'agent', id: 'sdk-client' };
    // Frozen copy: mutating the caller's object cannot silently change the
    // identity sent with every subsequent request.
    this.actor = Object.freeze({ type: actor.type, id: actor.id });

    /**
     * Headers sent with every request (ADR-038).
     *
     * The actor pair is an *assertion*, and against a Production Spine in
     * production mode it buys nothing — a caller has to present whatever the
     * deployment's identity verifier actually reads, and only that deployment
     * knows what that is. Without this the SDK could not talk to an
     * authorizing server at all: every call would come back 401.
     *
     * **The SDK still holds no credential of its own.** It forwards what the
     * caller hands it, exactly as a browser forwards a header, and it never
     * stores, logs or defaults one.
     */
    this.headers = Object.freeze({ ...(options.headers ?? {}) });
    this.fetch = options.fetchImpl ?? fetch;
  }

  health() { return this.request('/health'); }
  metrics() { return this.request('/api/admin/metrics'); }
  schema() { return this.request('/api/schema'); }
  listCompanies() { return this.request('/api/companies'); }
  createCompany(input, options = {}) {
    return this.request('/api/companies', { method: 'POST', body: input, idempotencyKey: options.idempotencyKey });
  }
  listContacts(companyId) {
    return this.request(`/api/contacts${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`);
  }
  createContact(input, options = {}) {
    return this.request('/api/contacts', { method: 'POST', body: input, idempotencyKey: options.idempotencyKey });
  }
  listOpportunities(filters = {}) {
    const query = new URLSearchParams(filters).toString();
    return this.request(`/api/opportunities${query ? `?${query}` : ''}`);
  }
  createOpportunity(input, options = {}) {
    return this.request('/api/opportunities', { method: 'POST', body: input, idempotencyKey: options.idempotencyKey });
  }
  requestStageChange(id, targetStage, options = {}) {
    return this.request(`/api/opportunities/${encodeURIComponent(id)}/stage`, {
      method: 'POST',
      body: { targetStage },
      idempotencyKey: options.idempotencyKey,
    });
  }
  listApprovals(status) {
    return this.request(`/api/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  }
  decideApproval(id, decision, options = {}) {
    const action = decision === 'approved' ? 'approve' : 'reject';
    return this.request(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }
  lookupWrite(key) {
    return this.request(`/api/write-outcomes/${encodeURIComponent(key)}`);
  }
  listUnacknowledgedWrites() {
    return this.request('/api/write-outcomes');
  }
  acknowledgeWrite(key, options = {}) {
    return this.request(`/api/write-outcomes/${encodeURIComponent(key)}/ack`, {
      method: 'POST',
      body: {},
      idempotencyKey: options.idempotencyKey,
    });
  }
  reconcileWrite(key, body = {}, options = {}) {
    return this.request(`/api/write-outcomes/${encodeURIComponent(key)}/reconcile`, {
      method: 'POST',
      body,
      idempotencyKey: options.idempotencyKey,
    });
  }
  getTrace(id) { return this.request(`/api/traces/${encodeURIComponent(id)}`); }

  /**
   * Resource client for a generated module (ADR-008): metadata, list, create,
   * get and update over the uniform /api/modules surface. The returned object
   * is frozen; the module name and all ids/query values are URL-encoded.
   *
   * @param {string} name
   */
  module(name) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new Error('module(name) requires a non-empty module name');
    }
    const base = `/api/modules/${encodeURIComponent(name.trim())}`;
    const client = this;
    return Object.freeze({
      /** Module metadata: fields, capabilities, paths. */
      metadata() { return client.request(base); },
      /** @param {{limit?: number}} [options] */
      list(options = {}) {
        if (options.limit !== undefined && !Number.isInteger(options.limit)) {
          throw new Error('list({limit}) requires an integer limit');
        }
        const query = options.limit === undefined ? '' : `?limit=${encodeURIComponent(String(options.limit))}`;
        return client.request(`${base}/records${query}`);
      },
      /** @param {Record<string, unknown>} input */
      create(input, options = {}) {
        return client.request(`${base}/records`, { method: 'POST', body: input, idempotencyKey: options.idempotencyKey });
      },
      /** @param {string} id */
      get(id) { return client.request(`${base}/records/${encodeURIComponent(id)}`); },
      /** @param {string} id @param {Record<string, unknown>} patch */
      update(id, patch, options = {}) {
        return client.request(`${base}/records/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: patch,
          idempotencyKey: options.idempotencyKey,
        });
      },
      /**
       * Run a code-first action on a record (ADR-011). `input` must be a plain
       * object matching the action's declared input schema. Errors preserve the
       * server's status/code/details (400 bad input, 404 unknown action, 409
       * invalid transition), so callers can branch on them.
       *
       * @param {string} id @param {string} actionName @param {Record<string, unknown>} [input]
       */
      action(id, actionName, input = {}, options = {}) {
        if (typeof actionName !== 'string' || !actionName.trim()) {
          throw new Error('action(id, name, input) requires a non-empty action name');
        }
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw new Error('action(id, name, input) requires input to be a plain object');
        }
        return client.request(
          `${base}/records/${encodeURIComponent(id)}/actions/${encodeURIComponent(actionName.trim())}`,
          { method: 'POST', body: input, idempotencyKey: options.idempotencyKey },
        );
      },
    });
  }

  /** @param {string} path @param {{method?: string, body?: unknown, idempotencyKey?: string, headers?: Record<string, string>}} [options] */
  async request(path, options = {}) {
    // Network failures (fetch rejections) propagate as-is and stay
    // distinguishable from framework HTTP errors, which always carry status.
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': 'application/json',
      'x-actor-type': this.actor.type,
      'x-actor-id': this.actor.id,
      // Last, so a caller presenting a verified identity is not overridden
      // by the actor assertion the client would otherwise send.
      ...this.headers,
      ...(options.headers ?? {}),
    };
    if (typeof options.idempotencyKey === 'string' && options.idempotencyKey !== '') {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    // Parse defensively: a non-JSON error response must surface the server's
    // status and a snippet, never be replaced by a JSON parse error.
    const text = await response.text();
    let body;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const message = body?.error?.message
        ?? `Accordo request failed (${response.status})${text && body === undefined ? `: ${text.slice(0, 200)}` : ''}`;
      const error = new Error(message);
      Object.assign(error, {
        status: response.status,
        code: body?.error?.code ?? 'UNKNOWN',
        details: body?.error?.details ?? null,
      });
      throw error;
    }
    if (body === undefined) {
      const error = new Error(`Accordo returned invalid JSON for ${path}`);
      Object.assign(error, { status: response.status, code: 'INVALID_RESPONSE', details: null });
      throw error;
    }
    return body;
  }
}
