import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalRuntimeSmokePort } from './ports/index.ts';
import { createRuntimeApplicationServices, INITIAL_LOCAL_MODEL_TAG } from './runtime-services.ts';

test('runtime application service fixes the diagnostic model and denies unapproved smoke tags', async () => {
  const calls: Array<{ method: string; modelTag: string }> = [];
  const runtime: LocalRuntimeSmokePort = {
    async diagnose(modelTag) {
      calls.push({ method: 'diagnose', modelTag });
      return { status: 'model_missing', runtimeVersion: '0.12.0', modelTag };
    },
    async smoke(modelTag) {
      calls.push({ method: 'smoke', modelTag });
      return { status: 'blocked', reasonCode: 'model_missing', modelTag };
    },
  };
  const services = createRuntimeApplicationServices(runtime);

  assert.deepEqual(await services.diagnose(), {
    status: 'model_missing', runtimeVersion: '0.12.0', modelTag: INITIAL_LOCAL_MODEL_TAG,
  });
  assert.deepEqual(await services.smoke('another/model:latest'), {
    status: 'blocked', reasonCode: 'model_not_allowed', modelTag: INITIAL_LOCAL_MODEL_TAG,
  });
  assert.deepEqual(calls, [{ method: 'diagnose', modelTag: INITIAL_LOCAL_MODEL_TAG }]);
  assert.deepEqual(await services.smoke(INITIAL_LOCAL_MODEL_TAG), {
    status: 'blocked', reasonCode: 'model_missing', modelTag: INITIAL_LOCAL_MODEL_TAG,
  });
  assert.deepEqual(calls.at(-1), { method: 'smoke', modelTag: INITIAL_LOCAL_MODEL_TAG });
});
