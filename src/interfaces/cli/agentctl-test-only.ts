import { runCliInternal, type CliApplication, type CliExecutionResult } from './agentctl-core.ts';

/** Used only by the isolated G1.9 no-tool fake CLI composition. */
export function runCliForNoToolFakeTest(
  argv: readonly string[],
  createApplication: () => Promise<CliApplication>,
): Promise<CliExecutionResult> {
  return runCliInternal(argv, createApplication, true);
}
