import { createTestCliApplication } from '../composition/test-cli.ts';
import { runCliForNoToolFakeTest } from '../interfaces/cli/agentctl-test-only.ts';

const result = await runCliForNoToolFakeTest(process.argv.slice(2), () => createTestCliApplication(
  undefined,
  { holdAgentAfterStart: process.env.AGENTCTL_TEST_HOLD_AGENT === '1' },
));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exitCode = result.exitCode;
