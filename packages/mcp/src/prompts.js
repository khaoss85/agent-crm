// @ts-check

/** @param {{app: any}} dependencies */
export function createPromptRegistry({ app }) {
  const prompts = [
    {
      name: 'build-crm-feature',
      title: 'Build an Agent CRM Feature',
      description: 'Turn a business request into a safe module/workflow implementation plan.',
      arguments: [
        { name: 'business_request', description: 'The commercial outcome to implement.', required: true },
      ],
      get(args) {
        return {
          description: 'Repository-aware implementation prompt',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Implement this Agent CRM request: ${args.business_request}\n\nRead AGENTS.md, PRODUCT.md, ARCHITECTURE.md and DECISIONS.md. Use module services for state and a named workflow for cross-module behavior. Preserve validation, audit and trace. Create an ExecPlan for multi-file work and finish with npm run verify.`,
              },
            },
          ],
        };
      },
    },
    {
      name: 'debug-crm-run',
      title: 'Debug a CRM Workflow Run',
      description: 'Inspect a workflow trace and produce a minimal regression-safe fix.',
      arguments: [
        { name: 'run_id', description: 'Workflow run UUID.', required: true },
      ],
      get(args) {
        const trace = app.workflows.getRun(args.run_id);
        return {
          description: 'Trace-aware debugging prompt',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Diagnose this Agent CRM workflow run. Find the first incorrect step, reproduce it in a test, fix the smallest responsible layer and run npm run verify.\n\n${JSON.stringify(trace, null, 2)}`,
              },
            },
          ],
        };
      },
    },
  ];
  const byName = new Map(prompts.map((prompt) => [prompt.name, prompt]));
  return {
    list: () => prompts.map(({ get: _get, ...prompt }) => prompt),
    get(name, args = {}) {
      const prompt = byName.get(name);
      if (!prompt) throw new Error(`Unknown MCP prompt: ${name}`);
      return prompt.get(args);
    },
  };
}
