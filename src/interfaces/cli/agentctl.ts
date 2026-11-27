import { runCliInternal, type CliApplication, type CliExecutionResult } from './agentctl-core.ts';

export { parseCliArgs } from './agentctl-core.ts';
export type {
  CliApplication,
  CliCommand,
  CliExecutionResult,
  CliFormat,
  CliParseResult,
  CliStartup,
} from './agentctl-core.ts';

/** Production CLI entry: task execution remains closed until G2.2. */
export function runCli(
  argv: readonly string[],
  createApplication: () => Promise<CliApplication>,
): Promise<CliExecutionResult> {
  return runCliInternal(argv, createApplication, false);
}
