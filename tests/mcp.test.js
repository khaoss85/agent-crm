import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createMcpServer } from '../packages/mcp/src/index.js';

test('MCP exposes project context, tools and resources for coding agents', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  await app.runDemo();
  const mcp = createMcpServer({ app });

  const initialize = await mcp.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  });
  assert.equal(initialize.result.serverInfo.name, 'accordo');

  const list = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.ok(list.result.tools.some((tool) => tool.name === 'crm_request_stage_change'));
  assert.ok(list.result.tools.some((tool) => tool.name === 'crm_scaffold_module'));
  const contextTool = list.result.tools.find((tool) => tool.name === 'crm_project_context');
  const approvalTool = list.result.tools.find((tool) => tool.name === 'crm_decide_approval');
  assert.equal(contextTool.annotations.readOnlyHint, true);
  assert.equal(approvalTool.annotations.readOnlyHint, false);
  assert.equal(approvalTool._meta['anthropic/requiresUserInteraction'], true);

  const context = await mcp.handle({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'crm_project_context', arguments: {} },
  });
  assert.equal(context.result.isError, false);
  assert.match(context.result.content[0].text, /deterministic/);

  const architecture = await mcp.handle({
    jsonrpc: '2.0', id: 4, method: 'resources/read',
    params: { uri: 'crm://project/architecture' },
  });
  assert.match(architecture.result.contents[0].text, /Core rule/);

  const modern = await mcp.handle({
    jsonrpc: '2.0',
    id: 5,
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  });
  assert.deepEqual(modern.result.supportedVersions, ['2026-07-28']);
});

test('MCP approval tool requires an explicit human identity', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  await app.runDemo();
  const approval = app.services.approvals.list({ status: 'pending' })[0];
  const mcp = createMcpServer({ app });

  const response = await mcp.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'crm_decide_approval',
      arguments: { approvalId: approval.id, decision: 'approved', decidedBy: 'manager-mcp' },
    },
  });

  assert.equal(response.result.isError, false);
  assert.equal(app.services.approvals.get(approval.id).decidedBy, 'manager-mcp');
});


test('MCP cannot infer or invent the human approval identity', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  await app.runDemo();
  const approval = app.services.approvals.list({ status: 'pending' })[0];
  const mcp = createMcpServer({ app });

  const response = await mcp.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'crm_decide_approval',
      arguments: { approvalId: approval.id, decision: 'approved' },
    },
  });

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /decidedBy/);
  assert.equal(app.services.approvals.get(approval.id).status, 'pending');
});
