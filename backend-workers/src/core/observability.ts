import { AsyncLocalStorage } from 'node:async_hooks';

// ============================================================================
// AI Observability — lightweight homegrown tracer (Workers/D1 port)
//
// One TRACE per unit of work; SPANS for every LLM call, embedding call, and
// platform query/write that happens inside it. The current trace travels via
// AsyncLocalStorage exactly as in the original Node version, so instrumented
// code (llm_client.ts, adapters/*) still just calls recordSpan() with zero
// changes — AsyncLocalStorage context is preserved for the full lifetime of
// a single `step.do()` callback (one continuous async call chain), which is
// the only place `withTrace` gets used from now (see workflows/*.ts).
//
// DELIBERATE DESIGN CHANGE from the original: today's app.ts wraps an entire
// agent run (possibly minutes, many steps) in one trace. Cloudflare Workflows
// replays `run()` from the top on resume and only memoizes each step's return
// value — a trace object mutated as a side effect *across* step boundaries
// would silently lose spans from steps that don't re-run and double-count
// spans from steps that do. Rather than thread span data through every step's
// return value (which would require changing agents.ts's call signatures),
// each step wraps ONLY ITS OWN body in withTrace(), so a full agent run now
// produces several small step-scoped traces instead of one big one. Confirmed
// safe to fall back to "no trace active" (recordSpan is already a no-op with
// no trace in flight) if AsyncLocalStorage context turns out not to survive
// step.do()'s internal serialization — verify this live in wrangler dev
// before trusting Observability data from the deployed Workflows.
//
// Persistence: D1 (was append-only JSONL on local disk).
// ============================================================================

export interface Span {
  name: string;                       // e.g. 'llm.generate', 'embeddings.batch', 'sf.query', 'sf.update'
  startedAt: string;
  durationMs: number;
  status: 'ok' | 'error' | 'fallback';
  meta: Record<string, any>;          // call-specific details (model, rows, dropped fields, ...)
}

export interface Trace {
  traceId: string;
  kind: string;                       // e.g. 'run-agent', 'schema-discovery'
  meta: Record<string, any>;          // platform, agent, targetId, ...
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status?: 'ok' | 'error';
  error?: string;
  spans: Span[];
}

const storage = new AsyncLocalStorage<Trace>();

function newTraceId(): string {
  // crypto.randomBytes(8) equivalent using Web Crypto, which is what's
  // actually available in the Workers runtime (no Node `crypto` module).
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function persist(db: D1Database, trace: Trace): Promise<void> {
  try {
    await db.prepare(
      `INSERT INTO traces (trace_id, kind, meta, started_at, ended_at, duration_ms, status, error, spans)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      trace.traceId,
      trace.kind,
      JSON.stringify(trace.meta),
      trace.startedAt,
      trace.endedAt || null,
      trace.durationMs ?? null,
      trace.status || null,
      trace.error || null,
      JSON.stringify(trace.spans)
    ).run();
  } catch (e: any) {
    console.warn(`[Observability] Failed to persist trace ${trace.traceId}: ${e.message}`);
  }
}

/** Runs fn inside a new trace context; ends + persists the trace when fn settles. */
export async function withTrace<T>(db: D1Database, kind: string, meta: Record<string, any>, fn: () => Promise<T>): Promise<T> {
  const trace: Trace = {
    traceId: newTraceId(),
    kind,
    meta,
    startedAt: new Date().toISOString(),
    spans: []
  };
  const t0 = Date.now();
  return storage.run(trace, async () => {
    try {
      const result = await fn();
      trace.status = 'ok';
      return result;
    } catch (e: any) {
      trace.status = 'error';
      trace.error = e.message;
      throw e;
    } finally {
      trace.endedAt = new Date().toISOString();
      trace.durationMs = Date.now() - t0;
      await persist(db, trace);
    }
  });
}

/** The trace currently in flight on this async path, if any. */
export function currentTrace(): Trace | undefined {
  return storage.getStore();
}

/**
 * Records a span on the current trace. Safe to call with no trace active
 * (e.g. one-off scripts, or a plain Worker request outside any withTrace) —
 * the span is simply dropped. UNCHANGED from the original — callers
 * (llm_client.ts, adapters/*) need no modification for this port.
 */
export function recordSpan(name: string, startedMs: number, status: Span['status'], meta: Record<string, any> = {}): void {
  const trace = storage.getStore();
  if (!trace) return;
  trace.spans.push({
    name,
    startedAt: new Date(startedMs).toISOString(),
    durationMs: Date.now() - startedMs,
    status,
    meta
  });
}

/** Convenience wrapper: time fn as a span named `name`. UNCHANGED from the original. */
export async function span<T>(name: string, meta: Record<string, any>, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    recordSpan(name, t0, 'ok', meta);
    return result;
  } catch (e: any) {
    recordSpan(name, t0, 'error', { ...meta, error: e.message });
    throw e;
  }
}

// ----------------------------------------------------------------------------
// Query API for the dashboard — reads from D1 instead of the in-memory ring.
// ----------------------------------------------------------------------------

function rowToTrace(row: Record<string, unknown>): Trace {
  return {
    traceId: row.trace_id as string,
    kind: row.kind as string,
    meta: JSON.parse((row.meta as string) || '{}'),
    startedAt: row.started_at as string,
    endedAt: (row.ended_at as string) || undefined,
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
    status: (row.status as Trace['status']) || undefined,
    error: (row.error as string) || undefined,
    spans: JSON.parse((row.spans as string) || '[]')
  };
}

export async function recentTraces(db: D1Database, limit: number = 20): Promise<Trace[]> {
  const { results } = await db.prepare(
    'SELECT * FROM traces ORDER BY started_at DESC LIMIT ?'
  ).bind(limit).all();
  return (results as Record<string, unknown>[]).map(rowToTrace);
}

export interface ObservabilityStats {
  totalRuns: number;
  errorRuns: number;
  avgRunMs: number;
  llmCalls: number;
  llmFallbacks: number;
  llmAvgMs: number;
  embeddingCalls: number;
  embeddingFallbacks: number;
  platformQueries: number;
  platformQueryErrors: number;
  platformWrites: number;
  platformWriteErrors: number;
  selfHeals: number;
}

// Aggregates over the most recent 500 traces — same cap-and-aggregate-in-JS
// approach as the original ring buffer, just sourced from D1 instead of memory.
const STATS_WINDOW = 500;

export async function computeStats(db: D1Database): Promise<ObservabilityStats> {
  const stats: ObservabilityStats = {
    totalRuns: 0, errorRuns: 0, avgRunMs: 0,
    llmCalls: 0, llmFallbacks: 0, llmAvgMs: 0,
    embeddingCalls: 0, embeddingFallbacks: 0,
    platformQueries: 0, platformQueryErrors: 0,
    platformWrites: 0, platformWriteErrors: 0,
    selfHeals: 0
  };
  let runMsSum = 0, llmMsSum = 0;

  const traces = await recentTraces(db, STATS_WINDOW);

  for (const t of traces) {
    stats.totalRuns++;
    if (t.status === 'error') stats.errorRuns++;
    runMsSum += t.durationMs || 0;

    for (const s of t.spans) {
      if (s.name.startsWith('llm.')) {
        stats.llmCalls++;
        llmMsSum += s.durationMs;
        if (s.status === 'fallback') stats.llmFallbacks++;
      } else if (s.name.startsWith('embeddings.')) {
        stats.embeddingCalls++;
        if (s.status === 'fallback') stats.embeddingFallbacks++;
      } else if (s.name === 'platform.query') {
        stats.platformQueries++;
        if (s.status === 'error') stats.platformQueryErrors++;
      } else if (s.name === 'platform.create' || s.name === 'platform.update') {
        stats.platformWrites++;
        if (s.status === 'error') stats.platformWriteErrors++;
        if (s.meta.selfHeal) stats.selfHeals++;
      }
    }
  }

  stats.avgRunMs = stats.totalRuns > 0 ? Math.round(runMsSum / stats.totalRuns) : 0;
  stats.llmAvgMs = stats.llmCalls > 0 ? Math.round(llmMsSum / stats.llmCalls) : 0;
  return stats;
}
