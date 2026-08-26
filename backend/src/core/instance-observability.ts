/**
 * INSTANCE OBSERVABILITY: Traces and spans isolated by instance.
 *
 * CRITICAL ISOLATION GUARANTEE:
 * - Traces from instance_001 NEVER mixed with instance_002
 * - Each instance has separate trace storage
 * - Error messages don't leak instance data
 */

import { recordSpan } from './observability';

export interface Span {
  name: string;
  timestamp: number;
  duration?: number;
  metadata?: any;
}

export interface Trace {
  traceId: string;
  instanceId: string; // ✅ CRITICAL: Every trace tagged with instance
  name: string;
  metadata: any;
  startTime: number;
  endTime?: number;
  spans: Span[];
}

export class InstanceObservabilityService {
  // Traces partitioned by instance: instanceId -> traces[]
  private traces = new Map<string, Trace[]>();
  // Current trace per instance: instanceId -> trace
  private currentTraces = new Map<string, Trace>();

  /**
   * Start a new trace for specific instance
   * ISOLATION: Trace is immediately tagged with instanceId
   */
  startTrace(instanceId: string, traceName: string, metadata: any = {}): string {
    const trace: Trace = {
      traceId: this.generateTraceId(),
      instanceId, // ✅ ISOLATION: Tagged immediately
      name: traceName,
      metadata: {
        ...metadata,
        instanceId // ✅ Double-tag for safety
      },
      startTime: Date.now(),
      spans: []
    };

    // Store in instance-specific array
    if (!this.traces.has(instanceId)) {
      this.traces.set(instanceId, []);
    }
    this.traces.get(instanceId)!.push(trace);

    // Set as current for this instance
    this.currentTraces.set(instanceId, trace);

    return trace.traceId;
  }

  /**
   * Record span in current trace (instance-specific)
   * ISOLATION: Span only added to instance's current trace
   */
  recordSpan(
    instanceId: string,
    spanName: string,
    metadata?: any,
    duration?: number
  ): void {
    const trace = this.currentTraces.get(instanceId);
    if (!trace) {
      console.warn(
        `[InstanceObservability] No active trace for instance '${instanceId}' when recording span '${spanName}'`
      );
      return;
    }

    // ✅ ISOLATION: Span includes instanceId
    const span: Span = {
      name: spanName,
      timestamp: Date.now(),
      duration,
      metadata: {
        ...metadata,
        instanceId // ✅ Double-tag
      }
    };

    trace.spans.push(span);
  }

  /**
   * End trace for instance
   * ISOLATION: Only ends this instance's trace
   */
  endTrace(instanceId: string): void {
    const trace = this.currentTraces.get(instanceId);
    if (trace) {
      trace.endTime = Date.now();
    }
    this.currentTraces.delete(instanceId);
  }

  /**
   * Get traces for SPECIFIC instance only
   * CRITICAL: Never returns traces from other instances
   */
  getTracesForInstance(instanceId: string, limit: number = 20): Trace[] {
    const instanceTraces = this.traces.get(instanceId) || [];
    return instanceTraces.slice(-limit);
  }

  /**
   * Get all traces across instances
   * Used only by admin endpoints - NOT exposed to individual clients
   * Each instance's traces remain partitioned in return value
   */
  getAllTraces(limit: number = 100): Map<string, Trace[]> {
    const result = new Map<string, Trace[]>();

    for (const [instanceId, traces] of this.traces.entries()) {
      result.set(instanceId, traces.slice(-limit));
    }

    return result;
  }

  /**
   * Compute statistics per instance
   * ISOLATION: Stats are per-instance, never mixed
   */
  getStatsForInstance(instanceId: string): {
    instanceId: string;
    traceCount: number;
    avgSpansPerTrace: number;
    oldestTrace?: number;
    newestTrace?: number;
  } {
    const traces = this.traces.get(instanceId) || [];

    if (traces.length === 0) {
      return {
        instanceId,
        traceCount: 0,
        avgSpansPerTrace: 0
      };
    }

    const totalSpans = traces.reduce((sum, t) => sum + t.spans.length, 0);
    const avgSpans = traces.length > 0 ? totalSpans / traces.length : 0;

    return {
      instanceId,
      traceCount: traces.length,
      avgSpansPerTrace: Math.round(avgSpans * 100) / 100,
      oldestTrace: traces[0]?.startTime,
      newestTrace: traces[traces.length - 1]?.startTime
    };
  }

  /**
   * Clear traces for specific instance only
   * Used for cleanup or testing
   * ISOLATION: Never affects other instances
   */
  clearTracesForInstance(instanceId: string): number {
    const count = this.traces.get(instanceId)?.length || 0;
    this.traces.delete(instanceId);
    this.currentTraces.delete(instanceId);
    return count;
  }

  /**
   * Execute function with trace context
   * Automatically starts, records spans, and ends trace
   * ISOLATION: All traces within are tagged with instanceId
   */
  async withTrace<T>(
    instanceId: string,
    traceName: string,
    fn: (recordSpan: (name: string, metadata?: any, duration?: number) => void) => Promise<T>,
    metadata: any = {}
  ): Promise<T> {
    const traceId = this.startTrace(instanceId, traceName, metadata);

    try {
      // Provide convenient span recorder for this instance
      const recordSpanFn = (name: string, meta?: any, duration?: number) => {
        this.recordSpan(instanceId, name, meta, duration);
      };

      const result = await fn(recordSpanFn);
      return result;
    } catch (error) {
      // Record error in trace
      this.recordSpan(instanceId, 'error', {
        message: error instanceof Error ? error.message : String(error),
        // ✅ ISOLATION: Never expose stack traces that might leak data
        type: error instanceof Error ? error.constructor.name : 'unknown'
      });
      throw error;
    } finally {
      this.endTrace(instanceId);
    }
  }

  /**
   * Generate unique trace ID
   */
  private generateTraceId(): string {
    return `trace_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Sanitize trace data for API response
   * CRITICAL: Removes sensitive data before sending to client
   * Never exposes other instances' data
   */
  sanitizeTraceForResponse(trace: Trace): any {
    return {
      traceId: trace.traceId,
      instanceId: trace.instanceId,
      name: trace.name,
      startTime: trace.startTime,
      endTime: trace.endTime,
      duration: trace.endTime ? trace.endTime - trace.startTime : undefined,
      spanCount: trace.spans.length,
      spans: trace.spans.map(s => ({
        name: s.name,
        timestamp: s.timestamp,
        duration: s.duration
        // ✅ ISOLATION: Never include raw metadata that might leak instance data
      }))
    };
  }
}

// Global singleton
export const obsService = new InstanceObservabilityService();
