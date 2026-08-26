// ============================================================================
// AgentTracer — step-by-step execution trace that renders as the HTML table
// written to u_ema_audit_trail. Mirrors the _traceLog / _renderTraceHtml
// pattern from the ServiceNow-side RiskInherentAIAssessor Script Include,
// adapted for the Vercel backend.
//
// Usage:
//   const tracer = new AgentTracer();
//   tracer.log('START', { instanceSysId });
//   tracer.log('REQUEST', { label: 'batch_1', prompt_length: 1234, prompt_preview: '...' });
//   tracer.log('RESPONSE', { label: 'batch_1', attempt: 1, status: 200 });
//   tracer.log('END', { outcome: 'assessed' });
//   const html = tracer.renderHtml('ControlEffectivenessAgent', 'RASMT00101272');
// ============================================================================

export interface TraceStep {
  ts: Date;
  elapsed: number;
  step: string;
  data: Record<string, any>;
}

export class AgentTracer {
  private steps: TraceStep[] = [];
  private t0 = Date.now();

  log(step: string, data: Record<string, any> = {}): void {
    this.steps.push({
      ts: new Date(),
      elapsed: Date.now() - this.t0,
      step,
      data
    });
  }

  totalMs(): number {
    return Date.now() - this.t0;
  }

  stepCount(): number {
    return this.steps.length;
  }

  // ── HTML rendering ────────────────────────────────────────────────────────
  // Produces the same visual format as the ServiceNow-side audit trail:
  //   ✅ Processed
  //   Agent: X  ·  Assessment: Y  ·  Total: Zms  ·  N steps
  //   ┌─────────────┬──────┬──────────┬──────────────────────────────────┐
  //   │ TIME        │ +MS  │ STEP     │ DETAILS                          │
  //   ├─────────────┼──────┼──────────┼──────────────────────────────────┤
  //   │ …           │ …    │ …        │ …                                │
  //   └─────────────┴──────┴──────────┴──────────────────────────────────┘
  renderHtml(agentName: string, assessmentNumber: string): string {
    const totalMs = this.totalMs();
    const count = this.steps.length;

    const header = [
      `<div style="font-family:monospace;font-size:13px;padding:12px 0">`,
      `<b style="font-size:15px;color:#2e7d32">&#x2705; Processed</b><br><br>`,
      `<span style="color:#555">Agent: <b>${this.esc(agentName)}</b>`,
      `&nbsp;&middot;&nbsp; Assessment: <b>${this.esc(assessmentNumber)}</b>`,
      `&nbsp;&middot;&nbsp; Total: <b>${totalMs}ms</b>`,
      `&nbsp;&middot;&nbsp; <b>${count} steps</b></span>`,
      `</div>`
    ].join('');

    const tableStyle = `border-collapse:collapse;width:100%;font-size:12px;font-family:monospace;table-layout:fixed`;
    const thStyle    = `padding:6px 10px;text-align:left;background:#1a237e;color:#fff;font-size:12px`;

    const thead = [
      `<table style="${tableStyle}">`,
      `<colgroup>`,
      `  <col style="width:160px">`,
      `  <col style="width:60px">`,
      `  <col style="width:120px">`,
      `  <col>`,
      `</colgroup>`,
      `<thead><tr>`,
      `<th style="${thStyle}">TIME</th>`,
      `<th style="${thStyle}">+MS</th>`,
      `<th style="${thStyle}">STEP</th>`,
      `<th style="${thStyle}">DETAILS</th>`,
      `</tr></thead>`
    ].join('');

    const tbody = `<tbody>` + this.steps.map((s, i) => {
      const bg   = i % 2 === 0 ? '#fafafa' : '#fff';
      const color = this.stepColor(s.step);
      const time  = s.ts.toISOString().replace('T', ' ').substring(0, 19);
      return [
        `<tr style="background:${bg};vertical-align:top">`,
        `<td style="padding:4px 10px;color:#777;white-space:nowrap">${time}</td>`,
        `<td style="padding:4px 10px;color:#aaa;white-space:nowrap">${s.elapsed}ms</td>`,
        `<td style="padding:4px 10px;white-space:nowrap"><b style="color:${color}">${this.esc(s.step)}</b></td>`,
        `<td style="padding:4px 10px;word-break:break-word">${this.renderDetails(s.data)}</td>`,
        `</tr>`
      ].join('');
    }).join('') + `</tbody></table>`;

    return header + thead + tbody;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private stepColor(step: string): string {
    switch (step) {
      case 'START':   return '#4527a0';
      case 'END':     return '#4527a0';
      case 'ERROR':   return '#b71c1c';
      case 'REQUEST': return '#1565c0';
      case 'RESPONSE':return '#2e7d32';
      case 'SALVAGED':return '#e65100';
      case 'RESULT':  return '#e65100';
      case 'QUEUED':  return '#37474f';
      case 'COPIED':  return '#37474f';
      case 'BATCH':   return '#6a1b9a';
      default:        return '#555';
    }
  }

  private renderDetails(data: Record<string, any>): string {
    if (Object.keys(data).length === 0) return '';

    const parts: string[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === null || v === undefined) continue;
      const str = String(v);

      // Render *_preview fields as a collapsible code block
      if (k.endsWith('_preview')) {
        const esc = this.esc(str);
        parts.push(
          `<br><span style="color:#888;font-size:11px">${this.esc(k)}:</span><br>` +
          `<pre style="margin:4px 0 4px 0;padding:6px 8px;background:#e8f0fe;` +
          `border-left:3px solid #1565c0;font-size:11px;max-height:140px;` +
          `overflow:auto;white-space:pre-wrap;word-break:break-word">${esc}</pre>`
        );
      } else {
        parts.push(
          `<span style="color:#888;font-size:11px">${this.esc(k)}:</span> ` +
          `<span>${this.esc(str)}</span>`
        );
      }
    }

    // Inline parts (non-preview) joined with ·; preview blocks go on new lines
    const inline  = parts.filter(p => !p.startsWith('<br>'));
    const preview = parts.filter(p =>  p.startsWith('<br>'));
    return inline.join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;') + preview.join('');
  }

  private esc(s: string): string {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
