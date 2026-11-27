import type { LocalRuntimeDiagnostic, LocalRuntimeSmoke, LocalRuntimeSmokePort } from './ports/index.ts';

export const INITIAL_LOCAL_MODEL_TAG = 'qwen2.5-coder:1.5b';

export interface RuntimeApplicationServices {
  diagnose(): Promise<LocalRuntimeDiagnostic>;
  smoke(modelTag: string): Promise<LocalRuntimeSmoke>;
}

/** Keeps the G2.1 smoke bounded to one explicitly approved local model tag. */
export function createRuntimeApplicationServices(runtime: LocalRuntimeSmokePort): RuntimeApplicationServices {
  return Object.freeze({
    diagnose: () => runtime.diagnose(INITIAL_LOCAL_MODEL_TAG),
    smoke: (modelTag: string) => modelTag === INITIAL_LOCAL_MODEL_TAG
      ? runtime.smoke(INITIAL_LOCAL_MODEL_TAG)
      : Promise.resolve(Object.freeze({
        status: 'blocked' as const,
        reasonCode: 'model_not_allowed' as const,
        modelTag: INITIAL_LOCAL_MODEL_TAG,
      })),
  });
}
