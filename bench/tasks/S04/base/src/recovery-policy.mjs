export function canResumeInterruptedRun(run) {
  return run?.status === 'interrupted';
}
