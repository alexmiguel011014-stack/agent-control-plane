const operation = (kind, modulePath, exportName, extra = {}) => Object.freeze({
  kind,
  modulePath,
  exportName,
  ...extra,
});

const invoke = (modulePath, exportName, extra) => operation('call', modulePath, exportName, extra);
const read = (modulePath, exportName) => operation('read-export', modulePath, exportName);

export const TASK_OPERATION_REGISTRY = Object.freeze({
  P01: Object.freeze({ call: invoke('src/range.mjs', 'isWithinRange') }),
  P02: Object.freeze({ call: invoke('src/duration.mjs', 'durationToMinutes') }),
  P03: Object.freeze({ call: invoke('src/priority.mjs', 'sortByPriority') }),
  P04: Object.freeze({ call: invoke('src/unique.mjs', 'uniqueInOrder') }),
  B01: Object.freeze({ call: invoke('src/sum-range.mjs', 'sumRange') }),
  B02: Object.freeze({ call: invoke('src/limit.mjs', 'getLimit') }),
  B03: Object.freeze({ call: invoke('src/ratio.mjs', 'ratio') }),
  B04: Object.freeze({ call: invoke('src/slugify.mjs', 'slugify') }),
  B05: Object.freeze({ call: invoke('src/cache.mjs', 'invalidate', { mutatedArgumentIndexes: Object.freeze([0]) }) }),
  B06: Object.freeze({ call: invoke('src/config.mjs', 'mergeConfig') }),
  I01: Object.freeze({ call: invoke('src/startup-config.mjs', 'buildRuntimeOptions') }),
  I02: Object.freeze({ call: invoke('src/date-parser.mjs', 'toUtcIsoDate') }),
  I03: Object.freeze({ call: invoke('src/serialize-row.mjs', 'serializeCsvRow') }),
  I04: Object.freeze({
    call: invoke('src/error-response.mjs', 'toErrorResponse', {
      errorConstructors: Object.freeze({
        AppError: Object.freeze({
          modulePath: 'src/app-error.mjs',
          exportName: 'AppError',
          argumentOrder: Object.freeze(['code', 'message', 'status']),
        }),
      }),
    }),
  }),
  I05: Object.freeze({
    'create-startup-config': invoke('src/startup.mjs', 'createStartupConfig'),
    'read-defaults': read('src/defaults.mjs', 'defaults'),
    'read-runtime-config': read('src/config.mjs', 'runtimeConfig'),
  }),
  I06: Object.freeze({ call: invoke('src/cli-output.mjs', 'serializeCliOutput') }),
  I07: Object.freeze({ call: invoke('src/reserve.mjs', 'reserveStock') }),
  I08: Object.freeze({ call: invoke('src/tags.mjs', 'normalizeTags') }),
  I09: Object.freeze({ call: invoke('src/pagination.mjs', 'pageWindow') }),
  I10: Object.freeze({ call: invoke('src/range.mjs', 'satisfies') }),
  I11: Object.freeze({ call: invoke('src/merge-intervals.mjs', 'mergeIntervals') }),
  I12: Object.freeze({ call: invoke('src/backoff.mjs', 'nextDelay') }),
  I13: Object.freeze({ call: invoke('src/wrap.mjs', 'wrapText') }),
  I14: Object.freeze({ call: invoke('src/percentile.mjs', 'percentile') }),
  I15: Object.freeze({ call: invoke('src/query.mjs', 'buildQuery') }),
  I16: Object.freeze({ call: invoke('src/status-label.mjs', 'statusLabel') }),
  I17: Object.freeze({ call: invoke('src/discount.mjs', 'applyDiscount') }),
  I18: Object.freeze({ call: invoke('src/parse-lines.mjs', 'parseKeyValueLines') }),
  I19: Object.freeze({ call: invoke('src/chunk-budget.mjs', 'chunkByBudget') }),
  I20: Object.freeze({ call: invoke('src/rank.mjs', 'rankScores') }),
  I21: Object.freeze({ call: invoke('src/bytes.mjs', 'formatBytes') }),
  I22: Object.freeze({ call: invoke('src/group-by-day.mjs', 'groupByDay') }),
  I23: Object.freeze({ call: invoke('src/access.mjs', 'canAccess') }),
  I24: Object.freeze({ call: invoke('src/template.mjs', 'renderTemplate') }),
  I25: Object.freeze({ call: invoke('src/latest.mjs', 'latestByKey') }),
  I26: Object.freeze({ call: invoke('src/compress.mjs', 'compressRanges') }),
  I27: Object.freeze({ call: invoke('src/redact.mjs', 'redactConfig') }),
  I28: Object.freeze({ call: invoke('src/duration-text.mjs', 'formatDuration') }),
  I29: Object.freeze({ call: invoke('src/weighted.mjs', 'weightedAverage') }),
  I30: Object.freeze({ call: invoke('src/route.mjs', 'matchRoute') }),
  S01: Object.freeze({ call: invoke('src/path-policy.mjs', 'isPathWithinRoot') }),
  S02: Object.freeze({ call: invoke('src/build-event.mjs', 'buildEvent') }),
  S03: Object.freeze({ call: invoke('src/tool-authorization.mjs', 'authorizeToolOperation') }),
  S04: Object.freeze({ call: invoke('src/run-recovery.mjs', 'decideRecovery') }),
});

export function getTaskOperation(taskId, operationId) {
  if (typeof taskId !== 'string' || typeof operationId !== 'string') return undefined;
  if (!Object.hasOwn(TASK_OPERATION_REGISTRY, taskId)) return undefined;
  const operations = TASK_OPERATION_REGISTRY[taskId];
  if (!Object.hasOwn(operations, operationId)) return undefined;
  return operations[operationId];
}

export function isRegisteredTaskId(taskId) {
  return typeof taskId === 'string' && Object.hasOwn(TASK_OPERATION_REGISTRY, taskId);
}
