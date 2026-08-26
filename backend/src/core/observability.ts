import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { put, list, get } from '@vercel/blob';

// ============================================================================
// AI Observability — lightweight homegrown tracer
//
// One TRACE per agent run; SPANS for every LLM call, embedding call, and
// platform query/write that happens inside it. The current trace travels via
// AsyncLocalStorage, so instrumented code just calls recordSpan() without
// any trace-ID threading through function signatures.
//
// Persistence: append-only JSONL (one trace per line, written when the trace
// ends) + an in-memory ring buffer for fast API queries. This is the
// "flight recorder" the debugging sessions kept re-deriving by hand:
// silent LLM fallbacks, Salesforce self-heal actions, latency, drop-offs.
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

// Persistence has two backends:
// - Local dev: append-only JSONL file under data/ (unchanged from before).
// - Vercel: individual JSON blobs in Vercel Blob storage, one per trace. NOT
//   /tmp — Vercel's /tmp is wiped on every cold start and isn't guaranteed to
//   survive between requests either, so scan/run history disappeared on every
//   redeploy until this was in place. Blob storage is durable and survives
//   redeploys, matching the "old scans should stay visible" requirement.
const HAS_BLOB = !!process.env.BLOB_READ_WRITE_TOKEN;
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TRACES_PATH = path.join(DATA_DIR, 'traces.jsonl');
const BLOB_PREFIX = 'traces/';
const RING_SIZE = 200;

const storage = new AsyncLocalStorage<Trace>();
const ring: Trace[] = [];

function loadRecentFromDiskSync(): void {
  try {
    if (!fs.existsSync(TRACES_PATH)) return;
    const lines = fs.readFileSync(TRACES_PATH, 'utf-8').trim().split('\n');
    for (const line of lines.slice(-RING_SIZE)) {
      try { ring.push(JSON.parse(line) as Trace); } catch { /* skip corrupt line */ }
    }
  } catch (e: any) {
    console.warn(`[Observability] Could not load prior traces: ${e.message}`);
  }
}

async function loadRecentFromBlob(): Promise<void> {
  try {
    const { blobs } = await list({ prefix: BLOB_PREFIX, limit: RING_SIZE });
    // Oldest first, so ring ends up in the same append order as live pushes.
    const sorted = blobs.slice().sort((a, b) => new Date(a.uploadedAt).getTime() - new Date(b.uploadedAt).getTime());
    const fetched = await Promise.all(sorted.map(async b => {
      try {
        const result = await get(b.pathname, { access: 'private' });
        if (!result || result.statusCode !== 200) return null;
        const text = await new Response(result.stream).text();
        return JSON.parse(text) as Trace;
      } catch {
        return null; // one corrupt/missing blob shouldn't drop the rest of history
      }
    }));
    for (const t of fetched) if (t) ring.push(t);
  } catch (e: any) {
    console.warn(`[Observability] Could not load prior traces from Blob: ${e.message}`);
  }
}

// Hydrates the in-memory ring from durable storage exactly once per warm
// instance — memoized so every withTrace/recentTraces/computeStats call
// after the first just awaits an already-resolved promise.
let hydratePromise: Promise<void> | null = null;
function ensureHydrated(): Promise<void> {
  if (!hydratePromise) {
    hydratePromise = HAS_BLOB ? loadRecentFromBlob() : Promise.resolve(loadRecentFromDiskSync());
  }
  return hydratePromise;
}

async function persist(trace: Trace): Promise<void> {
  if (HAS_BLOB) {
    try {
      await put(`${BLOB_PREFIX}${trace.traceId}.json`, JSON.stringify(trace), {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false
      });
    } catch (e: any) {
      console.warn(`[Observability] Failed to persist trace ${trace.traceId} to Blob: ${e.message}`);
    }
    return;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(TRACES_PATH, JSON.stringify(trace) + '\n', 'utf-8');
  } catch (e: any) {
    console.warn(`[Observability] Failed to persist trace ${trace.traceId}: ${e.message}`);
  }
}

/** Runs fn inside a new trace context; ends + persists the trace when fn settles. */
export async function withTrace<T>(kind: string, meta: Record<string, any>, fn: () => Promise<T>): Promise<T> {
  await ensureHydrated();
  const trace: Trace = {
    traceId: crypto.randomBytes(8).toString('hex'),
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
      ring.push(trace);
      if (ring.length > RING_SIZE) ring.shift();
      await persist(trace);
    }
  });
}

/** The trace currently in flight on this async path, if any. */
export function currentTrace(): Trace | undefined {
  return storage.getStore();
}

/**
 * Records a span on the current trace. Safe to call with no trace active
 * (e.g. one-off CLI scripts) — the span is simply dropped.
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

/** Convenience wrapper: time fn as a span named `name`. */
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
// Query API for the dashboard
// ----------------------------------------------------------------------------
export async function recentTraces(limit: number = 20, kind?: string): Promise<Trace[]> {
  await ensureHydrated();
  const pool = kind ? ring.filter(t => t.kind === kind) : ring;
  return pool.slice(-limit).reverse();
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

export async function computeStats(): Promise<ObservabilityStats> {
  await ensureHydrated();
  const stats: ObservabilityStats = {
    totalRuns: 0, errorRuns: 0, avgRunMs: 0,
    llmCalls: 0, llmFallbacks: 0, llmAvgMs: 0,
    embeddingCalls: 0, embeddingFallbacks: 0,
    platformQueries: 0, platformQueryErrors: 0,
    platformWrites: 0, platformWriteErrors: 0,
    selfHeals: 0
  };
  let runMsSum = 0, llmMsSum = 0;

  for (const t of ring) {
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
