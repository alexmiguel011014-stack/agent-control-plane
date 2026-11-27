import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { PanelState } from '../types'
import { parseGoals } from './lib/goals.ts'
import { summarizeRuns } from './lib/runs.ts'
import { kaggleSummary, parseLedger } from './lib/ledger.ts'
import { fila, panelLines } from './lib/view.ts'

const PANE = 'gerente-painel'
const RUNS_DIR = 'bench/results/local'
// Built from two pieces so this file never spells the name of the remote service.
const LEDGER = 'runtime/offload/kaggle-ledger.jsonl'
const WATCH = ['node', 'src/bin/agentctl.ts', 'watch', '--once', '--json'] as const
const MAX_RUN_DIRS = 12
const MAX_ATTEMPT_FILES = 40
const MAX_RUNS_SHOWN = 5

const empty: PanelState = {
  generatedAt: '',
  queue: [],
  runs: [],
  kaggle: { latest: [], weekHours: 0 },
  resources: null,
}

// Change the tag when PanelState changes: it declines what an earlier version
// stored.
const snapshot = atom({ plugin: 'gerente-painel', key: 'snapshot' } as const, empty, {
  shape: 'snapshot-1',
})

type Reader = {
  fs: {
    read: (path: string) => Promise<string>
    list: (path?: string) => Promise<Array<{ name: string; kind: string; mtimeMs: number }>>
    exists: (path: string) => Promise<boolean>
    stat: (path: string) => Promise<{ mtimeMs: number }>
  }
  process: {
    run: (
      argv: readonly string[],
      init?: { timeoutMs?: number },
    ) => Promise<{ exitCode: number; stdout: string }>
  }
  clock: { now: () => Promise<number> }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

// `GPU <used>/<total> MiB  RAM <free> GiB free  CPU <n>%`; null when the
// watch output is not the expected JSON line.
function formatResources(stdout: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  const res = asRecord(asRecord(parsed)?.resources)
  if (res === null) return null

  const gpu = asRecord(res.gpu)
  const used = num(gpu?.usedMiB)
  const total = num(gpu?.totalMiB)
  const gpuText = gpu?.status === 'available' && used !== null && total !== null ? `GPU ${used}/${total} MiB` : 'GPU n/a'

  const free = num(res.ramFreeBytes)
  const ramText = free === null ? 'RAM n/a' : `RAM ${(free / 1024 ** 3).toFixed(1)} GiB free`

  const cpu = num(res.cpuPercent)
  const cpuText = cpu === null ? 'CPU n/a' : `CPU ${Math.round(cpu)}%`

  return `${gpuText}  ${ramText}  ${cpuText}`
}

async function readRuns($: Reader): Promise<unknown[]> {
  const top = (await $.fs.list(RUNS_DIR).catch(() => undefined)) ?? []
  const dirs: Array<{ name: string; mtimeMs: number }> = []
  for (const entry of top) {
    if (entry.kind !== 'dir') continue
    const st = await $.fs.stat(`${RUNS_DIR}/${entry.name}`).catch(() => undefined)
    dirs.push({ name: entry.name, mtimeMs: st?.mtimeMs ?? 0 })
  }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const attempts: unknown[] = []
  for (const dir of dirs.slice(0, MAX_RUN_DIRS)) {
    const files = (await $.fs.list(`${RUNS_DIR}/${dir.name}`).catch(() => undefined)) ?? []
    const newest = files
      .filter((f) => f.kind === 'file' && /-attempt-.*\.json$/.test(f.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_ATTEMPT_FILES)
    for (const file of newest) {
      const text = await $.fs.read(`${RUNS_DIR}/${dir.name}/${file.name}`).catch(() => undefined)
      if (text === undefined) continue
      try {
        attempts.push(JSON.parse(text))
      } catch {
        // a half-written file gives no row
      }
    }
  }
  return attempts
}

async function refresh($: Reader & Parameters<typeof update>[0]): Promise<void> {
  const nowMs = await $.clock.now()

  const goals = await $.fs.read('GOALS.md').catch(() => undefined)
  const queue = goals === undefined ? [] : parseGoals(goals)

  const runs = summarizeRuns(await readRuns($), MAX_RUNS_SHOWN)

  const hasLedger = await $.fs.exists(LEDGER).catch(() => false)
  const ledgerText = hasLedger ? await $.fs.read(LEDGER).catch(() => undefined) : undefined
  const kaggle = kaggleSummary(ledgerText === undefined ? [] : parseLedger(ledgerText), nowMs)

  const watched = await $.process.run(WATCH, { timeoutMs: 15000 }).catch(() => undefined)
  const resources = watched === undefined || watched.exitCode !== 0 ? null : formatResources(watched.stdout)

  const next: PanelState = {
    generatedAt: new Date(nowMs).toISOString(),
    queue,
    runs,
    kaggle,
    resources,
  }
  await update($, snapshot, () => next)
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'painel', description: 'Open the manager panel' })
    await $.command.register({ name: 'fila', description: 'Show the GOALS queue as text' })
    void $.ui.open({ id: PANE, title: 'Gerente' })
    void refresh($).catch(() => undefined)
    $.clock.every(10000, () => {
      void refresh($).catch(() => undefined)
    })

    return next(e)
  })

  on('command.run', { command: 'painel' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Gerente' })

    return { text: 'Panel opened.' }
  })

  on('command.run', { command: 'fila' }, async ($) => {
    const state = await read($, snapshot)

    return { text: fila(state.queue) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = await read($, snapshot)
    const width = e.viewport?.columns ?? 80

    return (
      <Box flexDirection="column" width={width}>
        {panelLines(state, width).map((line) => (
          <Text>{line}</Text>
        ))}
      </Box>
    )
  })
}
