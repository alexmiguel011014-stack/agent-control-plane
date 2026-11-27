import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'gerente-painel',
  component: 'Pane',
  requestId: 'gerente-painel',
  props: {
    title: 'Gerente',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const GOALS = [
  '## GOALS 7',
  '',
  '- [ ] **G7.1 Build the thing**',
  '  - tier: standard',
  '  - gate: auto',
  '- [ ] **G7.2 Owner step**',
  '  - tier: user',
  '',
].join('\n')

const ATTEMPT = JSON.stringify({
  runId: 'offload-replay-20261119202657',
  suiteId: 'suite-a',
  startedAtUtc: '2026-11-19T20:26:57Z',
  model: { tag: 'qwen3.5:9b' },
  outcome: { status: 'PASS' },
})

const LEDGER = JSON.stringify({
  ts: new Date().toISOString(),
  kernel: 'me/slug',
  version: 3,
  event: 'status',
  status: 'COMPLETE',
  gpuSeconds: null,
  note: '',
})

const WATCH = JSON.stringify({
  generatedAt: '2026-11-23T10:00:00Z',
  tasks: [],
  runs: [],
  resources: {
    gpu: { status: 'available', usedMiB: 1200, totalMiB: 8192 },
    ramFreeBytes: 8 * 1024 ** 3,
    ramTotalBytes: 16 * 1024 ** 3,
    cpuPercent: 12.4,
  },
})

// The engine hands a relative path over as an absolute one: compare the tail.
function tail(p: string): string {
  return p.split('\\').join('/')
}

// Each hook below stands for the engine: it answers what the host would.
function host(on: (name: string, fn: (...args: any[]) => unknown) => void, watch: () => unknown) {
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // A refused period ends the interval, so the 10 s timer never fires in a test.
  on('clock.every', () => ({ deny: 'no timer in a test' }))
  on('clock.now', () => ({ value: Date.now() }))
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: /ledger/.test(tail(e.path)) }))
  on('fs.list', (_: unknown, e: { path: string }) => {
    const top = { name: 'offload-replay-20261119202657', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }
    const file = { name: 't1-attempt-1.json', kind: 'file', size: 10, mtimeMs: 5, isLink: false }
    if (tail(e.path).endsWith('bench/results/local')) return { value: [top] }
    return { value: [file] }
  })
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 9, isLink: false } }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    const path = tail(e.path)
    if (path.endsWith('/GOALS.md')) return { value: GOALS }
    if (path.endsWith('-attempt-1.json')) return { value: ATTEMPT }
    if (/ledger/.test(path)) return { value: LEDGER }
    return { deny: 'missing' }
  })
  on('process.run', watch)
}

async function texts(ui: { find: (q: object) => Promise<{ text?: string } | undefined> }, re: RegExp) {
  return (await ui.find({ type: 'Text', text: re }))?.text
}

test('the pane shows the queue, a run, a ledger row and the resources', async ($, on) => {
  host(on, () => ({ value: { exitCode: 0, stdout: WATCH, stderr: '' } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await texts(ui, /^QUEUE/)).toBe('QUEUE  executable 1  owner 1')
    expect(await texts(ui, /G7\.1/)).toBe('  G7.1  Build the thing')
    expect(await texts(ui, /G7\.2/)).toBe('  G7.2  Owner step')
    expect(await texts(ui, /19202657/)).toMatch(/19202657  suite-a  qwen3\.5:9b  1\/1/)
    expect(await texts(ui, /me\/slug/)).toBe('  me/slug v3 COMPLETE')
    expect(await texts(ui, /GPU/)).toBe('  GPU 1200/8192 MiB  RAM 8.0 GiB free  CPU 12%')
    await ui.unmount()
  }
})

test('the pane says unavailable when the watch call rejects', async ($, on) => {
  host(on, () => ({ deny: 'cannot start' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await texts(ui, /^RESOURCES/)).toBe('RESOURCES')
  expect(await texts(ui, /unavailable/)).toBe('  unavailable')
  expect(await texts(ui, /G7\.1/)).toBe('  G7.1  Build the thing')
  await ui.unmount()
})

test('the pane says unavailable when the watch call exits non-zero or prints bad JSON', async ($, on) => {
  host(on, () => ({ value: { exitCode: 1, stdout: WATCH, stderr: 'boom' } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const failed = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await texts(failed, /unavailable/)).toBe('  unavailable')
  await failed.unmount()
})

test('a missing file gives an empty section, not an error', async ($, on) => {
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // A refused period ends the interval, so the 10 s timer never fires in a test.
  on('clock.every', () => ({ deny: 'no timer in a test' }))
  on('clock.now', () => ({ value: Date.now() }))
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ deny: 'missing' }))
  on('fs.read', () => ({ deny: 'missing' }))
  on('process.run', () => ({ deny: 'cannot start' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await texts(ui, /^QUEUE/)).toBe('QUEUE  executable 0  owner 0')
  expect(await texts(ui, /^RUNS/)).toBe('RUNS (latest 0)')
  await ui.unmount()
})

const RUN = {
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

test('/painel opens the pane and /fila answers the queue as text', async ($, on) => {
  host(on, () => ({ value: { exitCode: 0, stdout: WATCH, stderr: '' } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Mounting settles the first refresh, which runs unawaited at session start.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.unmount()

  expect((await $.command.run({ ...RUN, command: 'painel' })).text).toBe('Panel opened.')

  const text = (await $.command.run({ ...RUN, command: 'fila' })).text ?? ''
  expect(text).toContain('executable (1)')
  expect(text).toContain('  G7.1  Build the thing')
  expect(text).toContain('owner (1)')
  expect(text).toContain('  G7.2  Owner step')
})
