export type PanelState = {
  generatedAt: string
  queue: Array<{
    id: string
    title: string
    kind: 'executable' | 'owner'
    tier: string | null
    gate: string | null
    plan: string | null
  }>
  runs: Array<{
    shortId: string
    suiteId: string
    modelTag: string
    attempts: number
    pass: number
    fail: number
    other: number
    startedAtUtc: string
  }>
  kaggle: {
    latest: Array<{
      kernel: string
      version: number | null
      status: string | null
      ts: string
    }>
    weekHours: number
  }
  resources: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'gerente-painel': { snapshot: Shaped<PanelState> }
  }
}
