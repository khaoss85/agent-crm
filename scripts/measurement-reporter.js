// @ts-check

/**
 * A second reporter beside spec. These are the runner's own per-file and root
 * counters, not a reconstruction from test names, nesting or printed symbols.
 * stdout/stderr from tests never enters this channel. The reader refuses a
 * truncated stream or a runner without per-file summaries.
 */
export default async function* measurementReporter(source) {
  for await (const event of source) {
    if (event.type === 'test:summary') {
      yield `${JSON.stringify({ measurementSummary: 1, ...event.data })}\n`;
    }
  }
}
