import { BaseGRCAdapter } from '../adapters/base';
import { recordSpan } from './observability';

export interface IntegrityFinding {
  recordId: string;
  recordType: string;
  issue: string;
  context: string;
}

export interface IntegrityScanResult {
  platform: string;
  scannedAt: string;
  supported: boolean;
  findings: IntegrityFinding[];
}

// ============================================================================
// Async integrity scan — the safety net for the failure pattern confirmed live
// twice on this project: a platform reporting a write as successful while
// silently dropping the field (risk-control mapping links, then instance
// justification narratives). The synchronous writeVerified() check in
// agents.ts catches this the instant it happens; this catches DRIFT — a field
// that was fine right after the write but got cleared by something else
// afterward. Runs on a schedule (Vercel Cron), not per-request.
//
// Duck-typed like the write methods: only runs when the adapter exposes
// scanForIntegrityIssues — most platforms have no known silent-write failure
// mode to guard against, so this is opt-in per adapter, not a base-class
// requirement.
// ============================================================================
export async function runIntegrityScan(adapter: BaseGRCAdapter, sinceHours: number = 6): Promise<IntegrityScanResult> {
  const platform = adapter.getPlatformName();
  const t0 = Date.now();
  const scan = (adapter as any).scanForIntegrityIssues;

  if (typeof scan !== 'function') {
    // Recorded as a span too (not just skipped silently) so the dashboard's
    // history view can show "not applicable" for this platform rather than
    // nothing at all — same generic per-platform shape either way.
    recordSpan('integrity.scan', t0, 'ok', { platform, supported: false, sinceHours, findingsCount: 0 });
    return { platform, scannedAt: new Date().toISOString(), supported: false, findings: [] };
  }

  const findings: IntegrityFinding[] = await scan.call(adapter, sinceHours);

  if (findings.length > 0) {
    console.warn(`[IntegrityScan] ${findings.length} integrity issue(s) found on ${platform} (last ${sinceHours}h):`, findings);
  } else {
    console.log(`[IntegrityScan] No integrity issues found on ${platform} (last ${sinceHours}h).`);
  }

  recordSpan('integrity.scan', t0, findings.length > 0 ? 'fallback' : 'ok', {
    platform, supported: true, sinceHours, findingsCount: findings.length, findings
  });

  return { platform, scannedAt: new Date().toISOString(), supported: true, findings };
}
