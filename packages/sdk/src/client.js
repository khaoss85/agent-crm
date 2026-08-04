// @ts-check

export class AgentCrmClient {
  /** @param {{baseUrl?: string, actor?: {type: string, id: string}, fetchImpl?: typeof fetch}} [options] */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:4000').replace(/\/$/, '');
    this.actor = options.actor ?? { type: 'agent', id: 'sdk-client' };
    this.fetch = options.fetchImpl ?? fetch;
  }

  health() { return this.request('/health'); }
  schema() { return this.request('/api/schema'); }
  listCompanies() { return this.request('/api/companies'); }
  createCompany(input) { return this.request('/api/companies', { method: 'POST', body: input }); }
  listContacts(companyId) {
    return this.request(`/api/contacts${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`);
  }
  createContact(input) { return this.request('/api/contacts', { method: 'POST', body: input }); }
  listOpportunities(filters = {}) {
    const query = new URLSearchParams(filters).toString();
    return this.request(`/api/opportunities${query ? `?${query}` : ''}`);
  }
  createOpportunity(input) { return this.request('/api/opportunities', { method: 'POST', body: input }); }
  requestStageChange(id, targetStage) {
    return this.request(`/api/opportunities/${encodeURIComponent(id)}/stage`, {
      method: 'POST',
      body: { targetStage },
    });
  }
  listApprovals(status) {
    return this.request(`/api/approvals${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  }
  decideApproval(id, decision) {
    const action = decision === 'approved' ? 'approve' : 'reject';
    return this.request(`/api/approvals/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      body: {},
    });
  }
  getTrace(id) { return this.request(`/api/traces/${encodeURIComponent(id)}`); }

  /** @param {string} path @param {{method?: string, body?: unknown}} [options] */
  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'x-actor-type': this.actor.type,
        'x-actor-id': this.actor.id,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body?.error?.message ?? `Agent CRM request failed (${response.status})`);
      Object.assign(error, { status: response.status, details: body?.error?.details });
      throw error;
    }
    return body;
  }
}
