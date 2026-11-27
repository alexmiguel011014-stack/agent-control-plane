import { canResumeInterruptedRun } from './recovery-policy.mjs';

export function decideRecovery(run) {
  if (run?.status !== 'interrupted') return 'not_interrupted';
  return canResumeInterruptedRun(run) ? 'resume' : 'await_approval';
}
