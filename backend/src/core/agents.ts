import { BaseGRCAdapter } from '../adapters/base';
import { BaseLLMClient, ToolDeclaration } from '../llm/llm_client';
import { Risk, Control, TestEvidence, Factor } from './models';
import { AgentTracer } from './tracer';
import { FieldMetadataUtils } from './field_metadata_utils';

// ============================================================================
// Helper: Determinstic Evidence Fingerprinting
// ============================================================================
function buildEvidenceFingerprint(evidence: TestEvidence): string {
  const parts: string[] = [evidence.sysId];

  // Cast and read internal tests sub-evidence if present
  const tests: any[] = (evidence as any).tests || [];
  for (const t of tests) {
    const openCount = t.openIssues?.length || 0;
    const closedCount = t.closedIssues || 0;
    parts.push(
      [
        t.name,
        t.state,
        t.effectiveness,
        t.status,
        t.latestResult,
        t.resultDate,
        `open:${openCount}`,
        `closed:${closedCount}`
      ].join('~')
    );
  }


  return parts.sort().join('||');
}

// Helper: run asynchronous task on items in parallel batches with a concurrency limit
async function runInParallelBatches<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(item => fn(item)));
    results.push(...batchResults);
  }
  return results;
}

// Helper: retry a tool-calling loop before giving up. A transient Gemini/network
// hiccup on one attempt no longer means the item falls straight to a "please
// retry" placeholder — it gets one more full attempt first. Only retries on a
// null result (loop didn't finalize); never re-runs a successful attempt.
async function withRetry<T>(fn: () => Promise<T | null>, attempts: number): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const result = await fn();
    if (result) return result;
  }
  return null;
}

// Helper: a write may report success (HTTP 200/201) while the platform silently
// drops the field — confirmed live twice this project (risk-control mapping
// links, instance justification narratives). One retry of the SAME write (not
// a fresh Gemini call — the content was fine, the platform write wasn't) before
// logging a loud, visible failure instead of a silent gap in the audit trail.
async function writeVerified(tracer: AgentTracer, label: string, write: () => Promise<boolean>): Promise<boolean> {
  let verified = await write();
  if (!verified) {
    tracer.log('WARN', { message: `Write not verified for ${label} — retrying once` });
    verified = await write();
  }
  if (!verified) {
    tracer.log('ERROR', { message: `Write still not verified for ${label} after retry — platform may have silently dropped the field` });
  }
  return verified;
}

// ============================================================================
// Shared HTML formatting for rich-text ServiceNow fields
//
// Confirmed live via sys_dictionary: u_rationale_auditing_purpose,
// u_ai_recommendation, and u_issue_summarize_ema are `html` type — the only
// three fields any agent writes into that can render markup at all.
// additional_comments, inherent_justification, control_justification,
// residual_justification, and the GRC task/issue `description` fields are
// plain `string` — putting a tag in one of those renders the literal
// characters "<b>", not bold text, so those stay plain text everywhere.
//
// One small, consistent style reused across every HTML field rather than a
// different look per agent: a single label color for section headers, plus
// green/red only where a decision is genuinely binary (matched vs rejected).
// ============================================================================
export const HTML_LABEL_COLOR = '#1a3d7c';
export const HTML_POSITIVE_COLOR = '#1a7f52';
export const HTML_NEGATIVE_COLOR = '#b23a2e';

/** Bold, colored section label — e.g. htmlLabel('Rating:') */
export function htmlLabel(text: string): string {
  return `<b style="color:${HTML_LABEL_COLOR}">${text}</b>`;
}

/** Escapes plain text for an HTML field and turns newlines into <br>. */
export function htmlEscape(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/** One line in a matched/rejected control or factor breakdown. */
export function htmlChoiceLine(name: string, reason: string, positive: boolean): string {
  const color = positive ? HTML_POSITIVE_COLOR : HTML_NEGATIVE_COLOR;
  const mark = positive ? '✓' : '✗';
  return `<span style="color:${color}"><b>${mark} ${htmlEscape(name)}</b></span> — ${htmlEscape(reason)}`;
}

// One-line, plain-text (no markup — u_ema_audit_summary is a plain string
// field, not HTML) rating tally for the u_ema_audit_trail summary column.
// Shared by Control Effectiveness and Inherent Assessment, whose per-row
// results both carry a `rating` and a `verified` flag.
function buildAssessmentSummary(nounPlural: string, results: Array<{ rating?: string | null; verified?: boolean }>, outcome: string): string {
  const tally: Record<string, number> = {};
  let unverified = 0;
  for (const r of results) {
    if (r.rating) tally[r.rating] = (tally[r.rating] || 0) + 1;
    if (r.verified === false) unverified++;
  }
  const breakdown = Object.entries(tally).map(([rating, count]) => `${count} ${rating}`).join(', ') || 'no ratings recorded';
  const verifiedNote = unverified > 0 ? ` ${unverified} write${unverified !== 1 ? 's' : ''} could not be verified.` : '';
  return `Assessed ${results.length} ${nounPlural}: ${breakdown}. Outcome: ${outcome}.${verifiedNote}`;
}

// ============================================================================
// 1. Control Effectiveness Agent
// ============================================================================
export class ControlEffectivenessAgent {
  private fieldUtils: FieldMetadataUtils | null;
  private terminology: { [key: string]: string } | null;

  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {
    const config = (adapter as any).config;
    this.fieldUtils = config ? new FieldMetadataUtils(config) : null;
    this.terminology = this.adapter.getTerminology() || null;
  }

  private formatText(text: string, maxChars = 32768): string {
    if (!text) return text;

    let result = text;
    if (this.terminology) {
      for (const [from, to] of Object.entries(this.terminology)) {
        const regex = new RegExp(`\\b${from}\\b`, 'gi');
        result = result.replace(regex, (match) =>
          match[0] === match[0].toUpperCase() ? to.charAt(0).toUpperCase() + to.slice(1) : to
        );
      }
    }

    if (result.length > maxChars) {
      const truncated = result.substring(0, maxChars);
      const lastSpace = truncated.lastIndexOf(' ');
      return lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated;
    }
    return result;
  }

  private formatForField(text: string, tableName: string, fieldName: string): string {
    if (!this.fieldUtils) return this.formatText(text);
    return this.fieldUtils.formatForField(text, tableName, fieldName);
  }

  async execute(instanceSysId: string): Promise<{ success: boolean; message: string; details: any[] }> {
    const tracer = new AgentTracer();
    tracer.log('START', { instanceSysId });

    const inst = await this.adapter.getAssessmentInstance(instanceSysId);
    if (!inst) {
      tracer.log('ERROR', { error: 'Assessment instance not found' });
      return { success: false, message: 'Assessment instance not found', details: [] };
    }

    tracer.log('INFO', { instanceSysId: inst.sysId, number: inst.number || 'none', riskSysId: inst.riskSysId });

    const risk = await this.adapter.getRisk(inst.riskSysId);
    if (!risk) {
      tracer.log('ERROR', { error: 'Linked risk not found' });
      return { success: false, message: 'Linked risk not found', details: [] };
    }

    tracer.log('INFO', { name: risk.name, profile: risk.profileName });

    // Use the resolved instance id (see InherentAssessmentAgent note).
    const rows = await this.adapter.getControlFactorRows(inst.sysId);
    tracer.log('INFO', { count: rows.length });
    if (rows.length === 0) {
      tracer.log('END', { outcome: 'no control responses' });
      return { success: false, message: 'No control-linked responses found', details: [] };
    }

    const uniqueControls = new Set(rows.map(r => r.controlSysId).filter(Boolean));
    tracer.log('INFO', { controlCount: uniqueControls.size });

    const priorInstanceSysId = await this.adapter.getPriorClosedAssessment(inst.riskSysId, instanceSysId);
    tracer.log('INFO', { priorNumber: priorInstanceSysId ? priorInstanceSysId.number : 'none' });
    const results: any[] = [];
    const toAssess: any[] = [];

    for (const row of rows) {
      if (!row.controlSysId) continue;
      const evidence = await this.adapter.getControlEvidence(row.controlSysId);
      const fingerprint = buildEvidenceFingerprint(evidence);

      // Check if we can carry forward a prior closed answer
      if (priorInstanceSysId) {
        const prior = await this.adapter.getPriorControlAnswer(priorInstanceSysId.sysId, row.controlSysId, row.factorSysId);
        if (prior && prior.fingerprint === fingerprint && prior.factorResponse) {
          const carriedScore = parseInt(prior.factorResponse, 10);
          const formattedComments = this.formatText(prior.comments);
          const formattedJustification = `📋 EMA — Carried forward. No changes in control or tests since last assessment.\nRating: ${prior.ratingLabel}\nPrior reasoning: ${formattedComments}`;
          const verified = await writeVerified(tracer, `control ${row.controlName} (carried forward)`, () =>
            this.adapter.writeControlEffectiveness(
              row.sysId,
              carriedScore,
              prior.ratingLabel,
              this.formatText(formattedJustification),
              formattedComments,
              formattedComments,
              fingerprint
            )
          );
          results.push({ control: row.controlName, action: 'copied', rating: prior.ratingLabel, justification: prior.comments, verified });
          tracer.log('COPIED', { control: row.controlName, rating: prior.ratingLabel, justification: prior.comments });
          continue;
        }
      }

      // Fetch the rating scale up front. Previously this was only fetched after the
      // LLM call, purely to resolve the model's answer to a score — meaning the model
      // was never actually told what the valid options were for that specific control
      // before answering, and multiple controls in the same batch could belong to
      // different factors with different scales without the prompt ever saying so.
      const factorDetails = await this.adapter.getFactorChoices(row.factorSysId);

      // If no match, queue for live AI assessment
      toAssess.push({
        rowSysId: row.sysId,
        controlSysId: row.controlSysId,
        controlName: row.controlName,
        factorSysId: row.factorSysId,
        evidence,
        fingerprint,
        factorDetails
      });
      const tests = (evidence as any).tests || [];
      const openIssuesCount = (evidence.openIssues?.length || 0) + (tests.reduce((sum: number, t: any) => sum + (t.openIssues?.length || 0), 0) || 0);
      tracer.log('QUEUED', { control: row.controlName, testCount: tests.length, openIssueCount: openIssuesCount });
    }

    if (toAssess.length > 0) {
      tracer.log('BATCH', { label: 'batch_1', controls: toAssess.map(item => item.controlName).join(', ') });
      // ── Pass 1: draft assessment — one tool-calling loop per control ──
      // Each control is its own investigation: the model is handed nothing but the
      // risk/control names and the valid rating scale, and must actively call tools
      // (get_control_details / get_test_evidence / get_associated_issues /
      // get_prior_assessment) to see any evidence at all, deciding for itself which
      // of them it needs and in what order, before calling submit_assessment. This
      // replaces the old single shared prompt that hand-fed every control's full
      // evidence dump upfront regardless of what the model actually needed.
      const drafts: Array<{ item: any; rating: string; score: number; justification: string; toolCallLog?: Array<{ name: string; args: any }> }> = [];

      const batchResults = await runInParallelBatches(toAssess, 5, async (item) => {
        if (!item.factorDetails) {
          await this.adapter.writeFailure(item.rowSysId, 'Factor rating scale not configured.');
          tracer.log('ERROR', { control: item.controlName, error: 'Factor rating scale not configured.' });
          return { success: false, item, error: 'Factor rating scale not configured.' };
        }

        const draftResult = await withRetry(() => this.assessControlWithTools(risk, item, priorInstanceSysId, tracer), 2);
        if (!draftResult) {
          await this.adapter.writeFailure(item.rowSysId, 'AI tool-calling investigation did not finalize a rating.');
          tracer.log('ERROR', { control: item.controlName, error: 'tool loop did not finalize' });
          return { success: false, item, error: 'tool loop did not finalize' };
        }

        return { success: true, item, draftResult };
      });

      for (const r of batchResults) {
        if (!r.success) {
          if (r.error === 'tool loop did not finalize') {
            results.push({ control: r.item.controlName, action: 'failed', error: 'tool loop did not finalize' });
          }
          continue;
        }
        const draftResult = r.draftResult!;
        drafts.push({ item: r.item, ...draftResult });
        tracer.log('RESULT', { control: r.item.controlName, rating: draftResult.rating, score: draftResult.score, justification: draftResult.justification });
      }

      // ── Pass 2: self-critique — a second, independent reviewer pass over the
      // same evidence, explicitly told what the first pass concluded and asked to
      // find fault with it (not just re-answer the same question fresh). Mutates
      // drafts in place only when it disagrees; a failed/unparseable critique call
      // leaves every draft exactly as-is, so this pass can only improve or confirm
      // the result, never block or degrade it. ──
      if (drafts.length > 0) {
        const critiqueChunkSize = 5;
        const critiqueChunks: (typeof drafts)[] = [];
        for (let i = 0; i < drafts.length; i += critiqueChunkSize) {
          critiqueChunks.push(drafts.slice(i, i + critiqueChunkSize));
        }
        // Each chunk reviews a disjoint slice of drafts and mutates only its own
        // items in place — safe to run concurrently instead of one chunk at a time.
        await Promise.all(critiqueChunks.map(chunk => this.critiqueDrafts(chunk, tracer)));
      }

      await Promise.all(drafts.map(async (draft) => {
        const item = draft.item;
        const controlLevelIssues: any[] = item.evidence.openIssues || [];
        const tests: any[] = (item.evidence as any).tests || [];
        const testCount = tests.length;

        // Confidence level
        let confidence = 'Grounded';
        if (testCount === 0 && controlLevelIssues.length === 0) {
          confidence = 'Estimated';
        }

        const formattedDate = new Date().toISOString().replace('T', ' ').substring(0, 19);

        // --- Build test detail strings ---
        const testDetailHuman = tests.length > 0
          ? tests.map((t: any) => `"${t.name}" (${t.number}, status: ${t.state || 'Unknown'}, effectiveness: ${t.effectiveness || 'Unknown'})`).join('; ')
          : 'none';

        const testDetailTech = testDetailHuman;

        // --- Build associated issues strings ---
        const allOpenIssues: any[] = [
          ...controlLevelIssues,
          ...tests.flatMap((t: any) => t.openIssues || [])
        ];
        const issueDetailHuman = allOpenIssues.length > 0
          ? allOpenIssues.map(i => `${i.number}: ${i.desc}`).join('; ')
          : 'none found';
        const issueDetailTech = issueDetailHuman;

        // --- Prior assessment ---
        const priorLine = priorInstanceSysId
          ? `prior closed assessment ${priorInstanceSysId.number} was searched and re-evaluated because control/test data changed since then`
          : 'no prior closed assessment found for this risk';
        const priorLineTech = priorInstanceSysId
          ? `sn_risk_advanced_risk_assessment_instance_response (prior closed assessment ${priorInstanceSysId.number}) and re-evaluated because control/test data changed since then`
          : 'sn_risk_advanced_risk_assessment_instance — no prior closed assessment found for this risk';

        // ============================================================
        // 1. Human-readable comment → additional_comments
        // ============================================================
        const summary = [
          '🔍 EMA INVESTIGATION — Control Effectiveness Assessment',
          '',
          `Rating: ${draft.rating}`,
          `Confidence: ${confidence}`,
          '',
          'WHAT WAS SEARCHED:',
          `  1. Control details — searched the control record and found: "${item.controlName}"`,
          `  2. Control tests — searched the Control Tests related list on the control and found ${testCount} record${testCount !== 1 ? 's' : ''}: ${testDetailHuman}`,
          `  3. Associated issues — searched the Associated Issues tab on the control and found ${allOpenIssues.length} record${allOpenIssues.length !== 1 ? 's' : ''} not yet Closed Complete: ${issueDetailHuman}`,
          `  4. Prior assessment history — ${priorLine}`,
          '',
          'CONCLUSION:',
          draft.justification,
          '',
          `Model: gemini-3.5-flash (Ema) · Assessed: ${formattedDate}`
        ].join('\n');

        // ============================================================
        // 2. Technical audit trail → u_rationale_auditing_purpose (HTML rich text field)
        // ============================================================
        const toolsUsedLine = draft.toolCallLog && draft.toolCallLog.length > 0
          ? `TOOLS THE AGENT CHOSE TO CALL (in order): ${draft.toolCallLog.map(c => c.name).join(' → ')}`
          : 'TOOLS THE AGENT CHOSE TO CALL: none — finalized from the risk/control context alone';

        const auditTrail = [
          `🔍 EMA INVESTIGATION (TECHNICAL / AUDIT TRAIL) — Control Effectiveness Assessment`,
          `${htmlLabel('Rating:')} ${draft.rating}<br>${htmlLabel('Confidence:')} ${confidence}`,
          htmlEscape(toolsUsedLine),
          htmlLabel('WHAT WAS SEARCHED (table-level detail):'),
          [
            `&nbsp;&nbsp;1. Control details — searched sn_compliance_control (control record) and found: "${htmlEscape(item.controlName)}"`,
            `&nbsp;&nbsp;2. Control tests — searched sn_audit_control_test (Control Tests related list on the control) and found ${testCount} record${testCount !== 1 ? 's' : ''}: ${htmlEscape(testDetailTech)}`,
            `&nbsp;&nbsp;3. Associated issues — searched sn_grc_issue (Issue Management module, same records as the Associated Issues tab on the control) and found ${allOpenIssues.length} record${allOpenIssues.length !== 1 ? 's' : ''} not yet Closed Complete: ${htmlEscape(issueDetailTech)}`,
            `&nbsp;&nbsp;4. Prior assessment history — searched ${htmlEscape(priorLineTech)}`
          ].join('<br>'),
          `${htmlLabel('CONCLUSION:')}<br>${htmlEscape(draft.justification)}`,
          `<i>Model: gemini-3.5-flash (Ema) · Assessed: ${formattedDate}</i>`
        ].join('<br><br>');

        const formattedJustification = this.formatText(draft.justification);
        const verified = await writeVerified(tracer, `control ${item.controlName}`, () =>
          this.adapter.writeControlEffectiveness(
            item.rowSysId,
            draft.score,
            draft.rating,
            formattedJustification,
            this.formatText(summary),
            auditTrail,
            item.fingerprint
          )
        );

        results.push({ control: item.controlName, action: 'assessed', rating: draft.rating, justification: draft.justification, verified });
      }));
    }

    // Optional: instance-level justification synthesis (control summary + residual).
    // Duck-typed like finalizeInherentAssessment above — only runs when the adapter
    // exposes an instance-level justification concept (e.g. ServiceNow's advanced risk
    // module has inherent_justification / control_justification / residual_justification
    // fields on the assessment instance itself). Most platforms don't model this at all,
    // so this step is silently skipped there rather than treated as an error.
    const getContext = (this.adapter as any).getInstanceJustificationContext;
    if (typeof getContext === 'function') {
      await this.synthesizeInstanceJustifications(inst.sysId, results, getContext, tracer);
    }

    // ── Observability: write a trace record to u_ema_audit_trail if adapter supports it ──
    const outcome = results.every(r => r.action !== 'failed') ? 'assessed' : 'partial';
    tracer.log('END', { outcome });

    const writeTrace = (this.adapter as any).writeObservabilityTrace;
    if (typeof writeTrace === 'function') {
      try {
        await writeTrace.call(this.adapter, {
          agentName: 'ControlEffectivenessAgent',
          targetId: instanceSysId,
          outcome,
          results,
          html: tracer.renderHtml('ControlEffectivenessAgent', inst.number || instanceSysId),
          riskSysId: inst.riskSysId,
          assessmentNumber: inst.number,
          summary: buildAssessmentSummary('control(s)', results, outcome)
        });
      } catch (_) { /* observability is best-effort — never block the run */ }
    }

    return {
      success: true,
      message: `Processed ${results.length} control assessment(s).`,
      details: results
    };
  }

  // ── Optional instance-level narrative synthesis ─────────────────────────
  // Only reachable when the adapter implements getInstanceJustificationContext (see
  // above). Builds an executive "control_justification" summary from the per-control
  // results just written, then — only if there's an inherent narrative or a control
  // narrative to reconcile — a "residual_justification" narrative combining both against
  // the platform's own calculated ratings. Either write is skipped (not an error) if the
  // adapter doesn't also implement the corresponding write method, or if synthesis fails.
  private async synthesizeInstanceJustifications(
    instanceSysId: string,
    results: any[],
    getContext: (instanceSysId: string) => Promise<{
      inherentJustification: string;
      controlJustification: string;
      calculatedRatings: string[];
    } | null>,
    tracer: AgentTracer
  ): Promise<void> {
    const context = await getContext.call(this.adapter, instanceSysId);
    if (!context) return; // adapter/platform doesn't support this instance concept

    const rated = results.filter(r => r.justification);
    if (rated.length === 0) return;

    const schema = {
      type: 'OBJECT',
      properties: { summary: { type: 'STRING' } },
      required: ['summary']
    };
    const systemInstruction = 'You are Ema, a GRC compliance-narrative writer.';

    const calcRating = context.calculatedRatings.find(r => r.startsWith('control effectiveness'));
    const calcBlock = context.calculatedRatings.length
      ? `\n\nCALCULATED RATINGS (authoritative — from the platform's scoring engine): ${context.calculatedRatings.join('; ')}\n\nCRITICAL — these are the system of record; your narrative must stay consistent with them, using the findings below only to explain the drivers behind that position.`
      : '';

    const lines = rated.map(r => `- ${r.control} [${r.rating || r.action}]: ${r.justification}`).join('\n');

    let controlJustification = '';
    try {
      const controlPrompt = [
        'You are Ema, writing an executive summary for a compliance manager reviewing',
        'control effectiveness ratings tied to one risk.',
        '',
        lines,
        calcBlock,
        '',
        'TASK: Write a concise, professional narrative (3-5 sentences) summarizing the overall',
        'control environment for this risk: the general rating picture, the most significant',
        'recurring themes or root causes, and any critical gaps. Do NOT list controls one by one —',
        'synthesize, don\'t enumerate.',
        '',
        'Respond ONLY with valid JSON, no markdown:',
        '{"summary": "<3-5 sentence narrative>"}'
      ].join('\n');
      const parsed = await this.llm.generateStructuredOutput<{ summary: string }>(controlPrompt, systemInstruction, schema);
      controlJustification = parsed.summary || '';
    } catch (e) {
      // Synthesis is a best-effort enrichment — never block the rest of the run on it.
    }

    const rawWriteControlSummary = (this.adapter as any).writeControlJustificationSummary;
    if (controlJustification && typeof rawWriteControlSummary === 'function') {
      await writeVerified(tracer, `instance ${instanceSysId} control_justification`, () =>
        rawWriteControlSummary.call(this.adapter, instanceSysId, controlJustification)
      );
    }

    // Residual — only meaningful if there's an inherent and/or control narrative to
    // reconcile. Mirrors the reference behavior of skipping outright when both sources
    // are empty, rather than fabricating a residual view from nothing.
    const inherentText = context.inherentJustification || '';
    const combinedControlText = controlJustification || context.controlJustification || '';
    if (!inherentText && !combinedControlText) return;

    let residualJustification = '';
    try {
      const residualPrompt = [
        'You are Ema, writing a RESIDUAL RISK summary for a compliance manager.',
        'Residual risk = what remains after the effectiveness of controls is applied against',
        'the inherent risk.',
        '',
        'INHERENT RISK SUMMARY:',
        inherentText || '(not available)',
        '',
        'CONTROL EFFECTIVENESS SUMMARY:',
        combinedControlText || '(not available)',
        context.calculatedRatings.length ? `\nCALCULATED RATINGS (authoritative): ${context.calculatedRatings.join('; ')}` : '',
        '',
        'TASK: Write a concise, professional narrative (3-5 sentences) on the residual risk',
        'position: how much of the inherent exposure current controls actually offset, where',
        'meaningful exposure remains, and what that implies for risk acceptance or remediation',
        'priority. Defer to the calculated ratings above where the source summaries disagree',
        'with them. Do not list individual factors or controls by name — synthesize.',
        '',
        'Respond ONLY with valid JSON, no markdown:',
        '{"summary": "<3-5 sentence residual risk narrative>"}'
      ].join('\n');
      const parsed = await this.llm.generateStructuredOutput<{ summary: string }>(residualPrompt, systemInstruction, schema);
      residualJustification = parsed.summary || '';
    } catch (e) {
      // Same — best-effort enrichment only.
    }

    const rawWriteResidual = (this.adapter as any).writeResidualJustification;
    if (residualJustification && typeof rawWriteResidual === 'function') {
      await writeVerified(tracer, `instance ${instanceSysId} residual_justification`, () =>
        rawWriteResidual.call(this.adapter, instanceSysId, residualJustification)
      );
    }
  }

  // Resolves a raw AI rating string to a configured score: exact match, then
  // case-insensitive fuzzy match, then default to the lowest-scored option with
  // an explanatory note appended to the justification. Shared by both the
  // first-pass and critique-pass resolution so a revised rating gets the same
  // out-of-scale handling as the original.
  private resolveRating(factorDetails: Factor, rawRating: string, rawJustification: string): { rating: string; score: number; justification: string } {
    let rating = rawRating;
    let score = factorDetails.choiceMap[rating];

    if (score === undefined) {
      const target = rating.toLowerCase().trim();
      for (const key of Object.keys(factorDetails.choiceMap)) {
        if (key.toLowerCase().trim() === target) {
          score = factorDetails.choiceMap[key];
          rating = key;
          break;
        }
      }
    }

    if (score === undefined) {
      const labels = Object.keys(factorDetails.choiceMap);
      const lowestLabel = labels.reduce((a, b) => factorDetails.choiceMap[a] < factorDetails.choiceMap[b] ? a : b);
      return {
        rating: lowestLabel,
        score: factorDetails.choiceMap[lowestLabel],
        justification: `Ema returned out-of-scale rating ("${rawRating}"). Defaulted to lowest option (${lowestLabel}). Original rationale: ${rawJustification}`
      };
    }

    return { rating, score, justification: rawJustification };
  }

  // ── Pass 2: self-critique ────────────────────────────────────────────────
  // One combined call reviewing every draft against its own evidence again —
  // explicitly framed as checking a first pass's work, not producing a fresh
  // independent opinion. This is what makes it a reflection step rather than
  // just re-running the same prompt twice: the model is told what was already
  // concluded and asked to find fault with it specifically.
  private async critiqueDrafts(drafts: Array<{ item: any; rating: string; score: number; justification: string }>, tracer: AgentTracer): Promise<void> {
    const blocks = drafts.map((d, idx) => {
      const item = d.item;
      const tests: any[] = item.evidence.tests || [];
      const controlOpenIssues: any[] = item.evidence.openIssues || [];
      const testSummary = tests.length > 0
        ? tests.map((t: any) => `"${t.name}" (status=${t.state}, effectiveness=${t.effectiveness || 'none'}${t.latestResult ? `, latest result=${t.latestResult}` : ''})`).join('; ')
        : 'none recorded';
      const issueSummary = controlOpenIssues.length > 0
        ? controlOpenIssues.map((oi: any) => oi.desc || oi.number).join('; ')
        : 'none open';
      const choiceStr = Object.keys(item.factorDetails.choiceMap).join(', ');
      return `[${idx + 1}] CONTROL: ${item.controlName}\n    Valid ratings: ${choiceStr}\n    Test evidence: ${testSummary}\n    Open issues: ${issueSummary}\n    DRAFT RATING: ${d.rating}\n    DRAFT JUSTIFICATION: ${d.justification}`;
    }).join('\n\n');

    const prompt = [
      'You are Ema, now reviewing your own draft control-effectiveness ratings as a second, independent pass.',
      'For each control below, a first pass already produced a draft rating and justification from the evidence shown.',
      'Check whether the draft rating actually follows from that evidence — not whether you would phrase it differently.',
      '',
      blocks,
      '',
      'For each control: if the draft rating is well-supported by the evidence, respond with action="confirm" and repeat',
      'the exact same rating. If it is not — e.g. it ignored an open issue, treated a passing test as evidence for a',
      'rating the evidence does not support, or the rating isn\'t one of that control\'s valid options — respond with',
      'action="revise", provide the corrected rating (copied EXACTLY from that control\'s valid ratings list), and explain',
      'in "note" specifically what the first pass got wrong.',
      '',
      'Respond ONLY with valid JSON, no markdown:',
      '{"reviews": [{"index": 1, "action": "confirm", "rating": "<same or corrected, exact valid option>", "note": ""}, ...]}'
    ].join('\n');

    const schema = {
      type: 'OBJECT',
      properties: {
        reviews: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              index: { type: 'INTEGER' },
              action: { type: 'STRING' },
              rating: { type: 'STRING' },
              note: { type: 'STRING' }
            },
            required: ['index', 'action', 'rating']
          }
        }
      },
      required: ['reviews']
    };

    tracer.log('REQUEST', {
      phase: 'critique',
      prompt_preview: prompt
    });

    try {
      const response = await this.llm.generateStructuredOutput<{ reviews: Array<{ index: number; action: string; rating: string; note?: string }> }>(
        prompt,
        'You are Ema, acting as an independent second reviewer of draft GRC ratings.',
        schema
      );
      tracer.log('RESPONSE', {
        phase: 'critique',
        status: 'completed',
        reviews: response.reviews
      });
      for (const review of response.reviews || []) {
        const draft = drafts[review.index - 1];
        if (!draft || review.action !== 'revise') continue;
        const resolved = this.resolveRating(draft.item.factorDetails, review.rating, draft.justification);
        draft.rating = resolved.rating;
        draft.score = resolved.score;
        draft.justification = `${draft.justification}\n\n🔁 Revised on second-pass review: ${review.note || 'rating did not hold up against the evidence on review.'}`;
      }
    } catch (e: any) {
      // Critique is an enrichment pass — a failed or unparseable review leaves
      // every draft exactly as the first pass produced it, rather than blocking
      // or corrupting the run.
      tracer.log('ERROR', { phase: 'critique', error: e.message });
    }
  }

  // ── Pass 1 worker: one tool-calling investigation per control ───────────
  // The model starts knowing only the risk, the control's name, and its valid
  // rating scale — everything else (control description, test evidence,
  // associated issues, prior assessment) sits behind a tool it must choose to
  // call. It decides which tools it needs and in what order, then finalizes by
  // calling submit_assessment. Returns null on any failure (no API key, HTTP
  // error, or the model never finalizing within the turn budget) — the caller
  // treats that identically to any other failed AI call.
  private async assessControlWithTools(
    risk: Risk,
    item: any,
    priorInstanceSysId: { sysId: string; number: string } | null,
    tracer: AgentTracer
  ): Promise<{ rating: string; score: number; justification: string; toolCallLog: Array<{ name: string; args: any }> } | null> {
    const factorDetails: Factor = item.factorDetails;
    const choiceStr = Object.keys(factorDetails.choiceMap).join(', ');
    const entityLabel = this.adapter.getEntityLabel();

    const tools: ToolDeclaration[] = [
      {
        name: 'get_control_details',
        description: "Get this control's own name and description.",
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_test_evidence',
        description: 'Get recorded control test evidence for this control: each test\'s status, effectiveness, health, latest result, result date, and any test-level open issues.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_associated_issues',
        description: 'Get open (not yet Closed Complete) issues associated directly with this control.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_prior_assessment',
        description: 'Get the rating and reasoning from the last closed assessment of this risk, if one exists. If this control is being evaluated at all, its evidence has changed since then, so treat this as context, not the answer.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'submit_assessment',
        description: `Finalize your assessment once you have gathered enough evidence to be confident. rating must be copied EXACTLY from: ${choiceStr}.`,
        parameters: {
          type: 'OBJECT',
          properties: {
            rating: { type: 'STRING' },
            justification: { type: 'STRING' }
          },
          required: ['rating', 'justification']
        }
      }
    ];

    const executeTool = async (name: string, _args: any): Promise<any> => {
      switch (name) {
        case 'get_control_details':
          return { name: item.controlName, description: item.evidence.latestResult || 'N/A' };
        case 'get_test_evidence': {
          const tests: any[] = item.evidence.tests || [];
          if (tests.length === 0) return { tests: [], note: 'No control tests recorded for this control.' };
          return {
            tests: tests.map((t: any) => ({
              name: t.name,
              number: t.number,
              status: t.state || 'Unknown',
              effectiveness: t.effectiveness || 'none',
              health: t.status || 'n/a',
              latestResult: t.latestResult || null,
              resultDate: t.resultDate || null,
              openIssues: (t.openIssues || []).map((oi: any) => oi.desc || oi.number)
            }))
          };
        }
        case 'get_associated_issues': {
          const issues: any[] = item.evidence.openIssues || [];
          return { openIssues: issues.map((oi: any) => ({ number: oi.number, desc: oi.desc })), count: issues.length };
        }
        case 'get_prior_assessment': {
          if (!priorInstanceSysId) return { hasPrior: false };
          const prior = await this.adapter.getPriorControlAnswer(priorInstanceSysId.sysId, item.controlSysId, item.factorSysId);
          if (!prior) return { hasPrior: false };
          return {
            hasPrior: true,
            priorRating: prior.ratingLabel,
            priorReasoning: prior.comments,
            note: 'Evidence has changed since this prior assessment (otherwise it would have been carried forward automatically) — re-evaluate, don\'t just repeat it.'
          };
        }
        default:
          return { error: `Unknown tool: ${name}` };
      }
    };

    const initialPrompt = [
      'You are assessing the OPERATING effectiveness of ONE control against a risk.',
      '',
      `RISK: ${risk.name}`,
      `Description: ${risk.description || 'N/A'}`,
      `${entityLabel}: ${risk.profileName}`,
      `CONTROL: ${item.controlName}`,
      '',
      `Valid ratings for this control (you must pick exactly one, copied exactly): ${choiceStr}`,
      '',
      'You do NOT have any evidence yet — use the available tools to gather whatever you judge necessary (control',
      'details, test evidence, associated issues, prior assessment) before deciding. Call as many or as few as you',
      'need; you are not required to call every tool.',
      '',
      'Apply this methodology once you have evidence:',
      '1. DESIGN vs OPERATING effectiveness differ — rate on demonstrated operating performance, not on whether the',
      '   control sounds appropriate on paper.',
      '2. A completed test with a recorded status/effectiveness IS valid evidence on its own.',
      '3. Evidence from long ago carries less confidence than recent evidence.',
      '4. Open issues are real-world evidence the control is not operating as designed — weigh them against the tests;',
      '   an actual failure in practice outweighs a formal passing test.',
      '5. NO test evidence at all → select the WEAKEST valid rating and say so in the justification.',
      '6. Treat missing/absent data as UNKNOWN, not as evidence of good or bad performance.',
      '7. Base your rating on the evidence holistically, not any single fact in isolation.',
      '',
      'When you have enough evidence, call submit_assessment with your final rating and a 1-2 sentence justification',
      'citing the specific evidence that drove it.'
    ].join('\n');

    tracer.log('REQUEST', {
      control: item.controlName,
      prompt_preview: initialPrompt
    });

    const loop = await this.llm.runToolLoop<{ rating: string; justification: string }>(
      'You are Ema, a GRC control-effectiveness assessment agent. You investigate before you conclude: gather evidence via the available tools, then submit exactly one final assessment.',
      initialPrompt,
      tools,
      'submit_assessment',
      executeTool,
      6
    );

    if (!loop) {
      tracer.log('ERROR', { control: item.controlName, error: 'tool loop did not finalize' });
      return null;
    }

    tracer.log('RESPONSE', {
      control: item.controlName,
      rating: loop.result.rating,
      justification: loop.result.justification
    });

    const resolved = this.resolveRating(factorDetails, loop.result.rating, loop.result.justification);
    return { rating: resolved.rating, score: resolved.score, justification: resolved.justification, toolCallLog: loop.toolCallLog };
  }
}

// ============================================================================
// 2. Inherent Assessment Agent
// ============================================================================
export class InherentAssessmentAgent {
  private fieldUtils: FieldMetadataUtils | null;
  private terminology: { [key: string]: string } | null;

  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {
    const config = (adapter as any).config; // DynamicAdapter has config
    this.fieldUtils = config ? new FieldMetadataUtils(config) : null;
    this.terminology = this.adapter.getTerminology() || null;
  }

  // Format text: apply terminology + smart truncation (32768 max for Salesforce textareas)
  private formatText(text: string, maxChars = 32768): string {
    if (!text) return text;

    // Apply terminology (entity → business unit, etc.)
    let result = text;
    if (this.terminology) {
      for (const [from, to] of Object.entries(this.terminology)) {
        const regex = new RegExp(`\\b${from}\\b`, 'gi');
        result = result.replace(regex, (match) =>
          match[0] === match[0].toUpperCase() ? to.charAt(0).toUpperCase() + to.slice(1) : to
        );
      }
    }

    // Smart truncate at word boundary
    if (result.length > maxChars) {
      const truncated = result.substring(0, maxChars);
      const lastSpace = truncated.lastIndexOf(' ');
      return lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated;
    }
    return result;
  }

  // Format text for a specific field: apply terminology + smart truncation
  private formatForField(text: string, tableName: string, fieldName: string): string {
    if (!this.fieldUtils) return this.formatText(text);
    return this.fieldUtils.formatForField(text, tableName, fieldName);
  }

  async execute(instanceSysId: string): Promise<{ success: boolean; message: string; details: any[] }> {
    const tracer = new AgentTracer();
    tracer.log('START', { instanceSysId });

    const inst = await this.adapter.getAssessmentInstance(instanceSysId);
    if (!inst) {
      tracer.log('ERROR', { error: 'Assessment instance not found' });
      return { success: false, message: 'Assessment instance not found', details: [] };
    }

    tracer.log('INFO', { instanceSysId: inst.sysId, number: inst.number || 'none', riskSysId: inst.riskSysId });

    const risk = await this.adapter.getRisk(inst.riskSysId);
    if (!risk) {
      tracer.log('ERROR', { error: 'Linked risk not found' });
      return { success: false, message: 'Linked risk not found', details: [] };
    }

    tracer.log('INFO', { name: risk.name, profile: risk.profileName });

    // Use the RESOLVED instance id — for create-on-demand platforms
    // (Salesforce inherent flow) the caller passes a risk id and
    // getAssessmentInstance returns the freshly created assessment.
    const factors = await this.adapter.getAnswerableManualRows(inst.sysId);
    tracer.log('INFO', { factorCount: factors.length });
    if (factors.length === 0) {
      tracer.log('END', { outcome: 'no inherent factors' });
      return { success: false, message: 'No answerable factors found', details: [] };
    }

    const entityLabel = this.adapter.getEntityLabel();
    const isSalesforce = this.adapter.getPlatformName() === 'salesforce';
    const results: any[] = [];

    // ── Prior closed assessment? Copy every factor forward, no fresh Gemini calls ──
    // Inherent risk characteristics (data sensitivity, external exposure, etc.) don't
    // churn the way control test evidence does, so if a prior CLOSED assessment of the
    // same risk exists at all, reuse it wholesale rather than re-litigating every factor
    // — unlike Control Effectiveness, which fingerprints each control individually
    // because its evidence genuinely does change run to run.
    const priorInstanceSysId = await this.adapter.getPriorClosedAssessment(inst.riskSysId, instanceSysId);
    tracer.log('INFO', { priorNumber: priorInstanceSysId ? priorInstanceSysId.number : 'none' });
    if (priorInstanceSysId) {
      for (const factor of factors) {
        const prior = await this.adapter.getPriorControlAnswer(priorInstanceSysId.sysId, '', factor.factorSysId);
        if (prior && prior.factorResponse) {
          const carriedScore = parseInt(prior.factorResponse, 10);
          const formattedJustification = this.formatForField(
            prior.comments,
            'Risk__Risk_Assessment_Rating__c',
            'Risk__Justification__c'
          );
          const verified = await writeVerified(tracer, `factor ${factor.factorName} (carried forward)`, () =>
            this.adapter.writeInherentFactor(
              factor.sysId,
              carriedScore,
              prior.ratingLabel,
              formattedJustification,
              `📋 EMA — Carried forward from prior closed assessment${priorInstanceSysId.number ? ' ' + priorInstanceSysId.number : ''}. No fresh evaluation this cycle.\nRating: ${prior.ratingLabel}\nPrior reasoning: ${this.formatForField(prior.comments, 'Risk__Risk_Assessment_Rating__c', 'Risk__Justification__c')}`,
              formattedJustification
            )
          );
          results.push({ factor: factor.factorName, action: 'copied', rating: prior.ratingLabel, justification: prior.comments, verified });
          tracer.log('COPIED', { factor: factor.factorName, rating: prior.ratingLabel, justification: prior.comments });
        } else {
          await this.adapter.writeFailure(factor.sysId, 'No prior value available to carry forward.');
          results.push({ factor: factor.factorName, rating: null, error: 'no prior value to copy' });
          tracer.log('ERROR', { factor: factor.factorName, error: 'no prior value to copy' });
        }
      }

      const writeInherentSummaryCF = (this.adapter as any).writeInherentJustificationSummary;
      if (typeof writeInherentSummaryCF === 'function') {
        await writeVerified(tracer, `instance ${inst.sysId} inherent_justification (carried forward)`, () =>
          writeInherentSummaryCF.call(
            this.adapter,
            inst.sysId,
            `Carried forward from prior closed assessment${priorInstanceSysId.number ? ' ' + priorInstanceSysId.number : ''}. Ratings and supporting rationale were unchanged and reused without a new evaluation this cycle.`
          )
        );
      }

      const finalizeCopied = (this.adapter as any).finalizeInherentAssessment;
      if (typeof finalizeCopied === 'function') {
        await finalizeCopied.call(this.adapter, inst.sysId);
      }

      tracer.log('END', { outcome: 'copied' });

      // Write trace for copied assessment
      const writeTraceI = (this.adapter as any).writeObservabilityTrace;
      if (typeof writeTraceI === 'function') {
        try {
          await writeTraceI.call(this.adapter, {
            agentName: 'InherentAssessmentAgent',
            targetId: instanceSysId,
            outcome: 'copied',
            results,
            html: tracer.renderHtml('InherentAssessmentAgent', inst.number || instanceSysId),
            summary: buildAssessmentSummary('inherent factor(s)', results, 'copied')
          });
        } catch (_) { /* observability is best-effort — never block the run */ }
      }

      return { success: true, message: `Copied ${results.length} inherent factor(s) from prior closed assessment.`, details: results };
    }

    // ── Fresh assessment: entity issue signal, shared context for every factor ──
    const entityIssues = await this.adapter.getEntityIssues(risk.profileSysId || '');
    tracer.log('INFO', { entityIssuesCount: entityIssues.length });

    for (const factor of factors) {
      tracer.log('QUEUED', { factor: factor.factorName, choiceList: factor.choiceList });
    }

    // ── Pass 1: draft assessment — one tool-calling loop per factor ──
    // Each factor is its own investigation: the model starts knowing only the risk and
    // factor name, and must call tools (get_factor_guidance / get_entity_issues) to see
    // the rubric or the issue list at all, before calling submit_rating. This replaces
    // the old approach of handing every factor the full guidance + full issue list
    // upfront regardless of whether it needed either.
    const drafts: Array<{
      factor: any;
      rating: string;
      score: number;
      justification: string;
      issueRelevant: boolean;
      relevantIssues: string[];
      issueNote: string;
      toolCallLog?: Array<{ name: string; args: any }>;
    }> = [];

    const batchResults = await runInParallelBatches(factors, 5, async (factor) => {
      const draftResult = await withRetry(() => this.assessFactorWithTools(risk, factor, entityIssues, entityLabel, isSalesforce, tracer), 2);
      if (!draftResult) {
        await this.adapter.writeFailure(factor.sysId, 'AI tool-calling investigation did not finalize a rating.');
        tracer.log('ERROR', { factor: factor.factorName, error: 'tool loop did not finalize' });
        return { success: false, factor, error: 'tool loop did not finalize' };
      }
      return { success: true, factor, draftResult };
    });

    for (const r of batchResults) {
      if (!r.success) {
        results.push({ factor: r.factor.factorName, rating: null, error: r.error });
        continue;
      }
      const draftResult = r.draftResult!;
      drafts.push({ factor: r.factor, ...draftResult });
      tracer.log('RESULT', { factor: r.factor.factorName, rating: draftResult.rating, score: draftResult.score, justification: draftResult.justification });
    }

    // ── Pass 2: self-critique — a second, independent reviewer pass, same pattern
    // as Control Effectiveness: explicitly told what the first pass concluded and
    // asked to find fault with it, not just re-answer fresh. ──
    if (drafts.length > 0) {
      const critiqueChunkSize = 5;
      const critiqueChunks: (typeof drafts)[] = [];
      for (let i = 0; i < drafts.length; i += critiqueChunkSize) {
        critiqueChunks.push(drafts.slice(i, i + critiqueChunkSize));
      }
      await Promise.all(critiqueChunks.map(chunk => this.critiqueFactorDrafts(chunk, tracer)));
    }

    // ── Finalize: write each factor's response ──
    await Promise.all(drafts.map(async (draft) => {
      const factor = draft.factor;
      const formattedDate = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const issueCount = entityIssues.length;

      let confidence: string;
      if (issueCount === 0) {
        confidence = isSalesforce ? 'Estimated (no business unit issue data available)' : 'Estimated (no entity issue data available)';
      } else if (draft.issueRelevant) {
        confidence = isSalesforce ? 'Partly grounded (informed by relevant business unit issue(s))' : 'Partly grounded (informed by relevant entity issue(s))';
      } else {
        confidence = isSalesforce ? 'Estimated (business unit issues found but none relevant to this factor)' : 'Estimated (entity issues found but none relevant to this factor)';
      }

      const issueRelevanceLine = issueCount === 0
        ? (isSalesforce ? 'no issues found on the business unit' : 'no issues found on the entity')
        : draft.issueRelevant
          ? `${draft.relevantIssues.length} of the ${issueCount} unresolved issue(s) identified as relevant to this factor: ${draft.relevantIssues.join('; ')}${draft.issueNote ? ' — ' + draft.issueNote : ''}`
          : `none of the ${issueCount} unresolved issue(s) were identified as relevant to this specific factor${draft.issueNote ? ' — ' + draft.issueNote : ''}`;

      const entitySearchLabel = isSalesforce ? 'Business Unit' : 'Entity';
      const searchTableLabel = isSalesforce ? "Business Unit's Downstream Issues related list" : "entity's Downstream Issues related list";
      const techSearchTableLabel = isSalesforce
        ? 'grc__Issue__c (unresolved issues related to grc__Business_Unit__c)'
        : 'sn_grc_m2m_issue_to_entity (Downstream Issues related list on the entity) and sn_grc_issue';

      const toolsUsedLine = draft.toolCallLog && draft.toolCallLog.length > 0
        ? `TOOLS THE AGENT CHOSE TO CALL (in order): ${draft.toolCallLog.map(c => c.name).join(' → ')}`
        : 'TOOLS THE AGENT CHOSE TO CALL: none — finalized from the risk/factor context alone';

      const comment = [
        '🔍 EMA INVESTIGATION — Inherent Risk Factor Assessment',
        '',
        `Rating: ${draft.rating}`,
        `Confidence: ${confidence}`,
        '',
        'WHAT WAS SEARCHED:',
        `  1. ${entitySearchLabel} issues — searched the ${searchTableLabel}; found ${issueCount} unresolved issue${issueCount !== 1 ? 's' : ''} not Closed Complete`,
        `  2. Relevant issues — ${issueRelevanceLine}`,
        '',
        'CONCLUSION:',
        draft.justification,
        '',
        `Model: gemini-3.5-flash (Ema) · Assessed: ${formattedDate}`
      ].join('\n');

      const auditTrail = [
        `🔍 EMA INVESTIGATION (TECHNICAL / AUDIT TRAIL) — Inherent Risk Factor Assessment`,
        `${htmlLabel('Rating:')} ${draft.rating}<br>${htmlLabel('Confidence:')} ${confidence}`,
        htmlEscape(toolsUsedLine),
        htmlLabel('WHAT WAS SEARCHED (table-level detail):'),
        [
          `&nbsp;&nbsp;1. ${entitySearchLabel} issues — searched ${techSearchTableLabel}; found ${issueCount} unresolved issue${issueCount !== 1 ? 's' : ''} not Closed Complete`,
          `&nbsp;&nbsp;2. Relevant issues — ${htmlEscape(issueRelevanceLine)}`
        ].join('<br>'),
        `${htmlLabel('CONCLUSION:')}<br>${htmlEscape(draft.justification)}`,
        `<i>Model: gemini-3.5-flash (Ema) · Assessed: ${formattedDate}</i>`
      ].join('<br><br>');

      const formattedJustification = this.formatForField(
        draft.justification,
        'Risk__Risk_Assessment_Rating__c',
        'Risk__Justification__c'
      );
      const verified = await writeVerified(tracer, `factor ${factor.factorName}`, () =>
        this.adapter.writeInherentFactor(
          factor.sysId,
          draft.score,
          draft.rating,
          formattedJustification,
          comment,
          auditTrail
        )
      );
      results.push({ factor: factor.factorName, rating: draft.rating, score: draft.score, justification: draft.justification, verified });
    }));

    // ── Instance-level narrative synthesis (inherent_justification) — duck-typed,
    // only runs where the adapter models this concept (see servicenow.ts). Reuses
    // getInstanceJustificationContext (already built for the residual work) purely to
    // read the platform's own calculated inherent rating as an anchor, the same way
    // the reference script treats it as authoritative. ──
    const rawWriteInherentSummary = (this.adapter as any).writeInherentJustificationSummary;
    if (typeof rawWriteInherentSummary === 'function') {
      // Bind here, not just extract — this is called later as a detached function
      // reference inside synthesizeInherentJustification, and plain (obj as any).method
      // access only preserves `this` when invoked immediately as obj.method(...); once
      // stored in a variable and called standalone, `this` inside the adapter method
      // would otherwise be undefined.
      await this.synthesizeInherentJustification(inst.sysId, results, rawWriteInherentSummary.bind(this.adapter), tracer);
    }

    // Optional platform-specific finalization step (e.g. Salesforce Risk
    // package Band/rollup enrichment) — not part of BaseGRCAdapter since
    // it's a concept only some adapters implement; duck-typed so
    // ServiceNow/hand-written Salesforce adapters are unaffected.
    const finalize = (this.adapter as any).finalizeInherentAssessment;
    if (typeof finalize === 'function') {
      await finalize.call(this.adapter, inst.sysId);
    }

    // ── Observability: write a trace record to u_ema_audit_trail if adapter supports it ──
    const outcome = results.every(r => !r.error) ? 'assessed' : 'partial';
    tracer.log('END', { outcome });

    const writeTraceI = (this.adapter as any).writeObservabilityTrace;
    if (typeof writeTraceI === 'function') {
      try {
        await writeTraceI.call(this.adapter, {
          agentName: 'InherentAssessmentAgent',
          targetId: instanceSysId,
          outcome,
          results,
          html: tracer.renderHtml('InherentAssessmentAgent', inst.number || instanceSysId),
          riskSysId: inst.riskSysId,
          assessmentNumber: inst.number,
          summary: buildAssessmentSummary('inherent factor(s)', results, outcome)
        });
      } catch (_) { /* observability is best-effort — never block the run */ }
    }

    return {
      success: true,
      message: `Assessed ${results.length} inherent factors.`,
      details: results
    };
  }

  // Resolves a raw AI rating string to a configured score — same exact-then-fuzzy
  // pattern as ControlEffectivenessAgent.resolveRating, kept separate since Factor's
  // choiceMap here has no "default to lowest" fallback in the original inherent flow
  // (an invalid choice was always a hard failure, never silently downgraded) — inherent
  // factors like "Data Sensitivity" have no obvious "weakest" direction the way a
  // control-effectiveness scale does, so guessing one would be more misleading than useful.
  private resolveInherentRating(factor: any, rawRating: string): number | undefined {
    let score = factor.choiceMap[rawRating];
    if (score !== undefined) return score;
    const target = rawRating.toLowerCase().trim();
    for (const key of Object.keys(factor.choiceMap)) {
      if (key.toLowerCase().trim() === target) return factor.choiceMap[key];
    }
    return undefined;
  }

  // ── Pass 1 worker: one tool-calling investigation per factor ────────────
  private async assessFactorWithTools(
    risk: Risk,
    factor: any,
    entityIssues: Array<{ desc: string; state: string; number?: string; priority?: string }>,
    entityLabel: string,
    isSalesforce: boolean,
    tracer: AgentTracer
  ): Promise<{ rating: string; score: number; justification: string; issueRelevant: boolean; relevantIssues: string[]; issueNote: string; toolCallLog: Array<{ name: string; args: any }> } | null> {
    const choiceStr = factor.choiceList.join(', ');

    const tools: ToolDeclaration[] = [
      {
        name: 'get_factor_guidance',
        description: "Get this factor's own description and rating-band guidance.",
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_entity_issues',
        description: `Get unresolved (not Closed Complete) issues logged against this risk's ${entityLabel.toLowerCase()}, with priority.`,
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'submit_rating',
        description: `Finalize your assessment once you have gathered enough evidence. rating must be copied EXACTLY from: ${choiceStr}.`,
        parameters: {
          type: 'OBJECT',
          properties: {
            rating: { type: 'STRING' },
            issue_relevant: { type: 'BOOLEAN' },
            relevant_issues: { type: 'ARRAY', items: { type: 'STRING' } },
            issue_note: { type: 'STRING' },
            justification: { type: 'STRING' }
          },
          required: ['rating', 'issue_relevant', 'justification']
        }
      }
    ];

    const executeTool = async (name: string, _args: any): Promise<any> => {
      switch (name) {
        case 'get_factor_guidance':
          return { name: factor.factorName, description: factor.factorDesc || 'N/A', guidance: factor.guidance || '(no rubric provided — use professional judgment based on the factor name)' };
        case 'get_entity_issues': {
          if (entityIssues.length === 0) return { issues: [], note: `No unresolved issues found on this risk's ${entityLabel.toLowerCase()}.` };
          return {
            issues: entityIssues.map(i => ({ number: i.number || null, desc: i.desc, state: i.state, priority: i.priority || 'Not set' })),
            count: entityIssues.length
          };
        }
        default:
          return { error: `Unknown tool: ${name}` };
      }
    };

    const initialPrompt = [
      'You are assessing an INHERENT RISK FACTOR — the level of risk that exists before any controls are applied.',
      'Assess conservatively and specifically, like a rigorous risk manager who does not inflate ratings without',
      'factor-specific justification.',
      '',
      `RISK: ${risk.name}`,
      `Description: ${risk.description || 'No description provided.'}`,
      `${entityLabel}: ${risk.profileName}`,
      `FACTOR TO ASSESS: ${factor.factorName}`,
      '',
      `Valid ratings for this factor (you must pick exactly one, copied exactly): ${choiceStr}`,
      '',
      'You do NOT have the factor\'s rubric or the issue list yet — use the available tools to gather whatever you',
      'judge necessary before deciding. Call as many or as few as you need.',
      '',
      'Apply this methodology once you have evidence:',
      '1. Match the risk against the factor\'s own rubric bands (from get_factor_guidance) — cite the specific band',
      `   you matched, not just the factor name in isolation.`,
      `2. Judge issue relevance PER FACTOR, not globally: an unresolved issue on the ${entityLabel.toLowerCase()} is`,
      '   evidence ONLY for the specific dimension it actually relates to. Do not raise this rating just because',
      `   an issue exists somewhere on the ${entityLabel.toLowerCase()} — ask whether its subject genuinely bears`,
      '   on this specific factor.',
      '3. Where an issue is genuinely relevant, weigh it by priority: a Critical or High priority unresolved issue',
      '   is stronger evidence toward a weaker rating than a Low priority one; a relevant Low priority issue can be',
      '   noted but should rarely move the rating alone.',
      '4. Be honest about your basis: where no relevant issue exists, ServiceNow has no entity-specific data for',
      '   this factor, so your rating is an ESTIMATE from the rubric thresholds and domain knowledge. Only where a',
      '   relevant issue exists is the rating partly GROUNDED in real data. For regulatory/environment-type factors',
      '   you may reason about the broader real-world landscape, clearly noting it as external reasoning.',
      '',
      'When you have enough evidence, call submit_rating with your final rating; issue_relevant (true only if a',
      'specific issue genuinely influenced THIS factor); relevant_issues (the exact issue description text for each',
      'issue that applied, empty array otherwise); issue_note (one short phrase, under 15 words, on why issues were',
      'or weren\'t relevant); and justification (1-2 sentences, under 300 characters, citing the rubric band and basis).'
    ].join('\n');

    tracer.log('REQUEST', {
      factor: factor.factorName,
      prompt_preview: initialPrompt
    });

    const loop = await this.llm.runToolLoop<{ rating: string; issue_relevant: boolean; relevant_issues?: string[]; issue_note?: string; justification: string }>(
      'You are Ema, an inherent risk factor evaluator. You investigate before you conclude: gather the rubric and issue context via the available tools, then submit exactly one final rating.',
      initialPrompt,
      tools,
      'submit_rating',
      executeTool,
      5
    );

    if (!loop) {
      tracer.log('ERROR', { factor: factor.factorName, error: 'tool loop did not finalize' });
      return null;
    }

    tracer.log('RESPONSE', {
      factor: factor.factorName,
      rating: loop.result.rating,
      justification: loop.result.justification
    });

    const score = this.resolveInherentRating(factor, loop.result.rating);
    if (score === undefined) return null;

    return {
      rating: loop.result.rating,
      score,
      justification: loop.result.justification,
      issueRelevant: loop.result.issue_relevant === true,
      relevantIssues: loop.result.relevant_issues || [],
      issueNote: loop.result.issue_note || '',
      toolCallLog: loop.toolCallLog
    };
  }

  // ── Pass 2: self-critique ────────────────────────────────────────────────
  // Same pattern as ControlEffectivenessAgent.critiqueDrafts: one combined call
  // reviewing every draft rating against its own rubric/issue context again, framed
  // as checking a first pass's work rather than answering fresh.
  private async critiqueFactorDrafts(drafts: Array<{ factor: any; rating: string; score: number; justification: string; issueRelevant: boolean; relevantIssues: string[]; issueNote: string }>, tracer: AgentTracer): Promise<void> {
    const blocks = drafts.map((d, idx) => {
      const choiceStr = d.factor.choiceList.join(', ');
      return `[${idx + 1}] FACTOR: ${d.factor.factorName}\n    Guidance: ${d.factor.guidance || '(none provided)'}\n    Valid ratings: ${choiceStr}\n    DRAFT RATING: ${d.rating}\n    DRAFT ISSUE RELEVANCE: ${d.issueRelevant ? 'relevant — ' + d.relevantIssues.join('; ') : 'not relevant'}${d.issueNote ? ' (' + d.issueNote + ')' : ''}\n    DRAFT JUSTIFICATION: ${d.justification}`;
    }).join('\n\n');

    const prompt = [
      'You are Ema, now reviewing your own draft inherent-risk-factor ratings as a second, independent pass.',
      'For each factor below, a first pass already produced a draft rating from the rubric and issue context shown.',
      'Check whether the draft rating actually follows from that rubric — not whether you would phrase it differently.',
      '',
      blocks,
      '',
      'For each factor: if the draft rating is well-supported, respond with action="confirm" and repeat the exact same',
      'rating. If it is not — e.g. it matched the wrong rubric band, inflated the rating from an issue that isn\'t',
      'genuinely relevant to this factor, or the rating isn\'t one of the valid options — respond with action="revise",',
      'provide the corrected rating (copied EXACTLY from that factor\'s valid ratings list), and explain in "note"',
      'specifically what the first pass got wrong.',
      '',
      'Respond ONLY with valid JSON, no markdown:',
      '{"reviews": [{"index": 1, "action": "confirm", "rating": "<same or corrected, exact valid option>", "note": ""}, ...]}'
    ].join('\n');

    const schema = {
      type: 'OBJECT',
      properties: {
        reviews: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              index: { type: 'INTEGER' },
              action: { type: 'STRING' },
              rating: { type: 'STRING' },
              note: { type: 'STRING' }
            },
            required: ['index', 'action', 'rating']
          }
        }
      },
      required: ['reviews']
    };

    tracer.log('REQUEST', {
      phase: 'critique',
      prompt_preview: prompt
    });

    try {
      const response = await this.llm.generateStructuredOutput<{ reviews: Array<{ index: number; action: string; rating: string; note?: string }> }>(
        prompt,
        'You are Ema, acting as an independent second reviewer of draft GRC ratings.',
        schema
      );
      tracer.log('RESPONSE', {
        phase: 'critique',
        status: 'completed',
        reviews: response.reviews
      });
      for (const review of response.reviews || []) {
        const draft = drafts[review.index - 1];
        if (!draft || review.action !== 'revise') continue;
        const score = this.resolveInherentRating(draft.factor, review.rating);
        if (score === undefined) continue; // an invalid revision is discarded, not applied
        draft.rating = review.rating;
        draft.score = score;
        draft.justification = `${draft.justification}\n\n🔁 Revised on second-pass review: ${review.note || 'rating did not hold up against the rubric on review.'}`;
      }
    } catch (e: any) {
      // Critique is an enrichment pass — a failed or unparseable review leaves every
      // draft exactly as the first pass produced it, rather than blocking the run.
      tracer.log('ERROR', { phase: 'critique', error: e.message });
    }
  }

  // ── Instance-level narrative synthesis (inherent_justification) ─────────
  // Mirrors ControlEffectivenessAgent.synthesizeInstanceJustifications: one Gemini call
  // producing a 3-5 sentence executive summary, anchored to the platform's own
  // calculated inherent rating where available so the prose never contradicts it.
  private async synthesizeInherentJustification(
    instanceSysId: string,
    results: any[],
    writeInherentSummary: (instanceSysId: string, text: string) => Promise<boolean>,
    tracer: AgentTracer
  ): Promise<void> {
    const rated = results.filter(r => r.justification);
    if (rated.length === 0) return;

    // Reuse getInstanceJustificationContext (built for the residual work) purely to
    // read the platform's calculated inherent rating, if the adapter exposes it.
    let calcRatingLine = '';
    const getContext = (this.adapter as any).getInstanceJustificationContext;
    if (typeof getContext === 'function') {
      try {
        const context = await getContext.call(this.adapter, instanceSysId);
        calcRatingLine = context?.calculatedRatings?.find((r: string) => r.startsWith('inherent rating')) || '';
      } catch (e) {
        // No calculated-rating anchor available — synthesis still proceeds without it.
      }
    }

    const calcBlock = calcRatingLine
      ? `\n\nCALCULATED OVERALL RATING (authoritative — from the platform's scoring engine): ${calcRatingLine}\n\nCRITICAL — consistency rule: the calculated rating above is the system of record and may differ from the individual factor ratings below. Your narrative must characterize the overall inherent risk position consistently with it, using the findings only to explain the drivers behind that position.`
      : '';

    const lines = rated.map(r => `- ${r.factor} [${r.rating}]: ${r.justification}`).join('\n');

    const prompt = [
      'You are Ema, writing an executive summary for a compliance manager reviewing inherent risk factor',
      'ratings for one risk. Below are the individual factor ratings and their supporting rationale — internal',
      'reference only, not to be repeated verbatim.',
      '',
      lines,
      calcBlock,
      '',
      'TASK: Write a concise, professional narrative (3-5 sentences) summarizing the overall inherent risk picture',
      'for this risk: the general rating picture across factors, the most significant recurring themes or drivers',
      '(e.g. regulatory exposure, unresolved entity issues, data sensitivity), and any notable concentrations of risk.',
      'Do NOT list or name individual factors one by one — synthesize, don\'t enumerate.',
      'Do NOT mention internal AI/system processing or how this summary was produced.',
      '',
      'Respond ONLY with valid JSON, no markdown:',
      '{"summary": "<3-5 sentence narrative>"}'
    ].join('\n');

    const schema = {
      type: 'OBJECT',
      properties: { summary: { type: 'STRING' } },
      required: ['summary']
    };

    let summary = '';
    try {
      const parsed = await this.llm.generateStructuredOutput<{ summary: string }>(prompt, 'You are Ema, a GRC compliance-narrative writer.', schema);
      summary = parsed.summary || '';
    } catch (e) {
      // Synthesis is a best-effort enrichment — never block the rest of the run on it.
    }

    if (summary) {
      await writeVerified(tracer, `instance ${instanceSysId} inherent_justification`, () => writeInherentSummary(instanceSysId, summary));
    }
  }
}

// ============================================================================
// 3. Risk-Control Mapping Agent
// ============================================================================
type ResolvedControl = { sysId: string; name: string; category: string; reason: string };

export class RiskControlMappingAgent {
  // A single Gemini call can hold this many controls in one prompt before
  // accuracy degrades from list-overload; beyond it, the run splits into
  // match-only batches plus one consolidation call, rather than truncating
  // the candidate pool. Constants below mirror a verified ServiceNow
  // reference implementation of this same agent concept.
  private static readonly BATCH_SIZE = 40;
  private static readonly DESC_LIMIT = 250;
  private static readonly RISK_DESC_LIMIT = 600;
  private terminology: { [key: string]: string } | null;

  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {
    this.terminology = this.adapter.getTerminology() || null;
  }

  private formatText(text: string, maxChars = 32768): string {
    if (!text) return text;

    let result = text;
    if (this.terminology) {
      for (const [from, to] of Object.entries(this.terminology)) {
        const regex = new RegExp(`\\b${from}\\b`, 'gi');
        result = result.replace(regex, (match) =>
          match[0] === match[0].toUpperCase() ? to.charAt(0).toUpperCase() + to.slice(1) : to
        );
      }
    }

    if (result.length > maxChars) {
      const truncated = result.substring(0, maxChars);
      const lastSpace = truncated.lastIndexOf(' ');
      return lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated;
    }
    return result;
  }

  async execute(riskSysId: string): Promise<{ success: boolean; message: string; details: any }> {
    const tracer = new AgentTracer();
    tracer.log('START', { riskSysId });

    const risk = await this.adapter.getRisk(riskSysId);
    if (!risk) {
      tracer.log('ERROR', { error: 'Risk not found' });
      return { success: false, message: 'Risk not found', details: null };
    }

    tracer.log('INFO', { riskName: risk.name, profileName: risk.profileName });

    const entityLabel = this.adapter.getEntityLabel();
    const controls = await this.adapter.getControlsForEntity(risk.profileSysId || '');
    tracer.log('INFO', { controlCount: controls.length });

    let result: { success: boolean; message: string; details: any };

    if (controls.length === 0) {
      result = await this.suggestNewControls(risk, entityLabel, tracer);
    } else {
      // ── Memory-reuse: skip controls already linked to this risk ──────────
      // Duck-typed like the other agents' prior-assessment carry-forward — this
      // one reads sn_risk_m2m_risk_control directly (the actual link table)
      // rather than a fingerprinted response row, since risk-control mapping
      // has no "assessment cycle" concept to fingerprint against. A control
      // already linked needs neither a fresh LLM decision nor a fresh write
      // (writing it again would create a duplicate link row).
      const getExisting = (this.adapter as any).getExistingRiskControlMappings;
      let alreadyMappedIds = new Set<string>();
      if (typeof getExisting === 'function') {
        const existing = await getExisting.call(this.adapter, riskSysId);
        if (existing) alreadyMappedIds = existing;
      }
      const alreadyMapped = controls.filter(c => alreadyMappedIds.has(c.sysId));
      const toEvaluate = controls.filter(c => !alreadyMappedIds.has(c.sysId));
      tracer.log('INFO', { alreadyMappedCount: alreadyMapped.length, toEvaluateCount: toEvaluate.length });

      if (toEvaluate.length === 0) {
        result = this.finishAlreadyMapped(risk, entityLabel, controls.length, alreadyMapped);
      } else {
        const draft = toEvaluate.length <= RiskControlMappingAgent.BATCH_SIZE
          ? await withRetry(() => this.mapControlsWithTools(risk, toEvaluate, alreadyMapped, entityLabel, tracer), 2)
              .then(d => d ? { ...d, coverageNote: '' } : null)
          : await this.runChunkedWithTools(risk, toEvaluate, alreadyMapped, entityLabel, tracer);

        if (!draft) {
          result = { success: false, message: 'AI evaluation failed for all control batches — please retry.', details: null };
        } else {
          // ── Self-critique — a second, independent reviewer pass over the fresh
          // decisions only (already-mapped controls are ground truth, not a new
          // AI decision, so there's nothing to critique there). ──
          const critiqued = await this.critiqueMappingDecisions(risk, draft.matches, draft.rejected, tracer);

          const carriedMatches: ResolvedControl[] = alreadyMapped.map(c => ({
            sysId: c.sysId, name: c.name, category: c.category || 'General',
            reason: 'Already mapped to this risk from a previous run — no changes needed.'
          }));
          const allMatches = this.dedupeBySysId([...carriedMatches, ...critiqued.matches]);

          result = allMatches.length === 0
            ? await this.finishNoMatch(risk, riskSysId, entityLabel, controls.length, critiqued.rejected, draft.justification, draft.gaps, draft.recommendation, tracer, draft.coverageNote)
            : await this.finishMatched(risk, riskSysId, entityLabel, controls.length, allMatches, critiqued.matches, critiqued.rejected, draft.justification, draft.gaps, draft.recommendation, tracer, draft.coverageNote);
        }
      }
    }

    // Optional instance-level narrative (ServiceNow's advanced risk module
    // carries a single u_ai_recommendation-style field directly on the risk
    // record). Most platforms have no equivalent, so this is duck-typed —
    // same convention as the Control Effectiveness / Inherent Assessment
    // justification writes — and only fires when both the adapter supports
    // it AND execute() actually produced a narrative to write.
    const rawWriteSummary = (this.adapter as any).writeRiskMappingSummary;
    if (typeof rawWriteSummary === 'function' && result.details?.narrative) {
      await writeVerified(tracer, `risk ${riskSysId} u_ai_recommendation`, () =>
        rawWriteSummary.call(this.adapter, riskSysId, result.details.narrative)
      );
    }

    // ── Observability: write a trace record to u_ema_audit_trail if adapter supports it ──
    const outcome = result.success ? 'mapped' : 'failed';
    tracer.log('END', { outcome });

    const writeTraceM = (this.adapter as any).writeObservabilityTrace;
    if (typeof writeTraceM === 'function') {
      try {
        await writeTraceM.call(this.adapter, {
          agentName: 'RiskControlMappingAgent',
          targetId: riskSysId,
          outcome,
          results: result.details,
          html: tracer.renderHtml('RiskControlMappingAgent', risk.name || riskSysId),
          summary: result.message
        });
      } catch (_) { /* observability is best-effort — never block the run */ }
    }

    return result;
  }

  private riskBlock(risk: Risk, entityLabel: string): string {
    return [
      'RISK:',
      `Name: ${risk.name}`,
      `Description: ${(risk.description || 'No description provided.').substring(0, RiskControlMappingAgent.RISK_DESC_LIMIT)}`,
      `${entityLabel}: ${risk.profileName}`
    ].join('\n');
  }

  private controlListBlock(controls: Control[]): string {
    const limit = RiskControlMappingAgent.DESC_LIMIT;
    return controls.map((c, idx) =>
      `[${idx + 1}] Name: ${c.name} | Category: ${c.category || 'General'} | Desc: ${(c.description || 'No description').substring(0, limit)}`
    ).join('\n');
  }

  /** Resolves LLM-returned {index, reason} pairs against a control pool (1-based index into that pool). */
  private resolveAgainst(raw: Array<{ index: number; reason: string }> | undefined, pool: Control[]): ResolvedControl[] {
    return (raw || [])
      .map(r => {
        const ctrl = pool[r.index - 1];
        return ctrl ? { sysId: ctrl.sysId, name: ctrl.name, category: ctrl.category || 'General', reason: r.reason } : null;
      })
      .filter((m): m is ResolvedControl => m !== null);
  }

  /** Controls the model never mentioned (neither matched nor explicitly rejected) get a generic rejection note. */
  private unmentionedRejections(pool: Control[], matches: Array<{ index: number }>, rejected: Array<{ index: number }>): ResolvedControl[] {
    const mentioned = new Set([...matches.map(m => m.index), ...rejected.map(r => r.index)]);
    return pool
      .map((ctrl, idx) => ({ ctrl, idx: idx + 1 }))
      .filter(({ idx }) => !mentioned.has(idx))
      .map(({ ctrl }) => ({ sysId: ctrl.sysId, name: ctrl.name, category: ctrl.category || 'General', reason: 'Not evaluated as relevant to the specific risk profile and description provided.' }));
  }

  private dedupeBySysId(matches: ResolvedControl[]): ResolvedControl[] {
    const seen = new Set<string>();
    return matches.filter(m => (seen.has(m.sysId) ? false : (seen.add(m.sysId), true)));
  }

  /** Context block for controls already linked to this risk — informational only, never re-decided. */
  private alreadyMappedBlock(alreadyMapped: Control[]): string {
    if (alreadyMapped.length === 0) return '';
    return [
      '',
      'ALREADY MAPPED (context only — already linked to this risk from a previous run, do NOT re-decide these,',
      'but factor them into your gap analysis):',
      alreadyMapped.map(c => `- ${c.name}`).join('\n')
    ].join('\n');
  }

  // Tool declarations + executor shared by every mapping-decision call (single-shot
  // and each chunked batch). The model starts with only a compact, truncated list —
  // full risk/control text and entity issue data sit behind tools it must choose to
  // call, same investigate-before-concluding pattern as the other two agents.
  private buildMappingTools(risk: Risk, pool: Control[], entityLabel: string): { tools: ToolDeclaration[]; executeTool: (name: string, args: any) => Promise<any> } {
    const tools: ToolDeclaration[] = [
      {
        name: 'get_risk_full_description',
        description: "Get this risk's full, untruncated description (the description shown above may be truncated).",
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_control_full_description',
        description: 'Get the full, untruncated name and description for one candidate control by its index number shown in the list above (descriptions there may be truncated).',
        parameters: { type: 'OBJECT', properties: { index: { type: 'INTEGER' } }, required: ['index'] }
      },
      {
        name: 'get_entity_open_issues',
        description: `Get currently open issues recorded against this ${entityLabel.toLowerCase()} — real-world evidence of what is currently going wrong, useful context for whether a candidate control is actually addressing live problems.`,
        parameters: { type: 'OBJECT', properties: {} }
      }
    ];

    const executeTool = async (name: string, args: any): Promise<any> => {
      switch (name) {
        case 'get_risk_full_description':
          return { description: risk.description || 'No description provided.' };
        case 'get_control_full_description': {
          const ctrl = pool[(args?.index || 0) - 1];
          if (!ctrl) return { error: 'Invalid index' };
          return { name: ctrl.name, category: ctrl.category || 'General', description: ctrl.description || 'No description provided.' };
        }
        case 'get_entity_open_issues': {
          const issues = await this.adapter.getEntityIssues(risk.profileSysId || '');
          return { issues: issues.map(i => ({ number: i.number, desc: i.desc, state: i.state, priority: i.priority })), count: issues.length };
        }
        default:
          return { error: `Unknown tool: ${name}` };
      }
    };

    return { tools, executeTool };
  }

  // ── Single-shot path (control pool fits in one prompt) ───────────────────
  // Deliberately kept as ONE call over the whole list rather than one tool-loop
  // per control (unlike the other two agents' per-item pattern): this is a SET
  // classification task, not a per-item rating, and seeing every candidate
  // together is what lets the model reason comparatively ("this one is clearly
  // the better fit, that one is redundant with an already-mapped control").
  // Tool-calling is layered on top of that same list-classification shape —
  // full risk/control text and entity issues sit behind tools instead of being
  // dumped inline — rather than replacing it.
  private async mapControlsWithTools(
    risk: Risk, pool: Control[], alreadyMapped: Control[], entityLabel: string, tracer: AgentTracer
  ): Promise<{ matches: ResolvedControl[]; rejected: ResolvedControl[]; justification: string; gaps: string; recommendation: string } | null> {
    const { tools, executeTool } = this.buildMappingTools(risk, pool, entityLabel);

    const schema = {
      type: 'OBJECT',
      properties: {
        matches: {
          type: 'ARRAY',
          description: 'Controls that SHOULD be mapped — they address this risk.',
          items: { type: 'OBJECT', properties: { index: { type: 'INTEGER' }, reason: { type: 'STRING', description: 'Why this control mitigates the risk' } }, required: ['index', 'reason'] }
        },
        rejected: {
          type: 'ARRAY',
          description: 'Controls that should NOT be mapped — they do not meet business criteria for this risk.',
          items: { type: 'OBJECT', properties: { index: { type: 'INTEGER' }, reason: { type: 'STRING', description: 'Why this control does NOT mitigate the risk' } }, required: ['index', 'reason'] }
        },
        overall_justification: { type: 'STRING' },
        gaps: { type: 'STRING' },
        recommendation: { type: 'STRING', description: 'Only meaningful if gaps exist; empty string otherwise' }
      },
      required: ['matches', 'rejected', 'overall_justification', 'gaps']
    };
    tools.push({ name: 'submit_mapping', description: 'Finalize your control-mapping decision once you have gathered enough evidence.', parameters: schema });

    const initialPrompt = [
      this.riskBlock(risk, entityLabel),
      '(Description above may be truncated — call get_risk_full_description for the complete text.)',
      this.alreadyMappedBlock(alreadyMapped),
      '',
      `CANDIDATE CONTROLS (${pool.length} total from this ${entityLabel}, not yet decided):`,
      this.controlListBlock(pool),
      '(Descriptions above may be truncated — call get_control_full_description(index) for the complete text on any control.)',
      '',
      'You may also call get_entity_open_issues for real-world evidence of what is currently going wrong for this',
      `${entityLabel.toLowerCase()} — useful context for whether a candidate control actually addresses live problems.`,
      '',
      'TASK:',
      '1. Select controls that GENUINELY mitigate this specific risk — be selective, do not force',
      '   a match just because a control sounds broadly compliance-related. An empty matches list',
      '   is a valid answer.',
      '2. For EVERY control NOT selected, provide a concise rejection reason explaining why it does',
      '   NOT meet the business criteria for this risk.',
      '3. Provide overall justification, gaps (what this risk is NOT covered for — considering the',
      '   already-mapped controls listed above too, not just what you just evaluated), and — only if',
      '   gaps exist — specific recommendations for new controls to create.',
      '',
      'Use the available tools for anything you need beyond what is shown above, then call submit_mapping',
      'with your final decision.'
    ].join('\n');

    const systemInstruction = 'You are Ema, a GRC Compliance mapping architect. You investigate before you conclude: pull whatever additional evidence you judge necessary via the available tools, then finalize by calling submit_mapping. For every rejected control, explain why it does not address the business criteria of this specific risk.';

    tracer.log('REQUEST', { path: 'singleShot', prompt_preview: initialPrompt });

    const loop = await this.llm.runToolLoop<{
      matches: Array<{ index: number; reason: string }>;
      rejected: Array<{ index: number; reason: string }>;
      overall_justification: string;
      gaps: string;
      recommendation?: string;
    }>(systemInstruction, initialPrompt, tools, 'submit_mapping', executeTool, 6);

    if (!loop) {
      tracer.log('ERROR', { path: 'singleShot', error: 'tool loop did not finalize' });
      return null;
    }

    tracer.log('RESPONSE', { path: 'singleShot', matchesCount: loop.result.matches?.length || 0, rejectedCount: loop.result.rejected?.length || 0 });

    return {
      matches: this.dedupeBySysId(this.resolveAgainst(loop.result.matches, pool)),
      rejected: [
        ...this.resolveAgainst(loop.result.rejected, pool),
        ...this.unmentionedRejections(pool, loop.result.matches, loop.result.rejected || [])
      ],
      justification: loop.result.overall_justification || '',
      gaps: loop.result.gaps || '',
      recommendation: loop.result.recommendation || ''
    };
  }

  // ── One chunked batch (matches/rejected only — no gap analysis, other batches exist it can't see) ──
  private async mapControlsBatchWithTools(
    risk: Risk, chunk: Control[], alreadyMapped: Control[], entityLabel: string, chunkIndex: number, chunksTotal: number, tracer: AgentTracer
  ): Promise<{ matches: ResolvedControl[]; rejected: ResolvedControl[] } | null> {
    const { tools, executeTool } = this.buildMappingTools(risk, chunk, entityLabel);

    const batchSchema = {
      type: 'OBJECT',
      properties: {
        matches: { type: 'ARRAY', items: { type: 'OBJECT', properties: { index: { type: 'INTEGER' }, reason: { type: 'STRING' } }, required: ['index', 'reason'] } },
        rejected: { type: 'ARRAY', items: { type: 'OBJECT', properties: { index: { type: 'INTEGER' }, reason: { type: 'STRING' } }, required: ['index', 'reason'] } }
      },
      required: ['matches', 'rejected']
    };
    tools.push({ name: 'submit_mapping', description: 'Finalize your control-mapping decision for this batch.', parameters: batchSchema });

    const initialPrompt = [
      this.riskBlock(risk, entityLabel),
      '(Description above may be truncated — call get_risk_full_description for the complete text.)',
      this.alreadyMappedBlock(alreadyMapped),
      '',
      `CANDIDATE CONTROLS — batch ${chunkIndex} of ${chunksTotal} (reference ONLY by the index number below, not yet decided):`,
      this.controlListBlock(chunk),
      '(Descriptions above may be truncated — call get_control_full_description(index) for the complete text.)',
      '',
      'You may also call get_entity_open_issues for real-world evidence of what is currently going wrong.',
      '',
      'TASK: From THIS BATCH ONLY, select controls that genuinely mitigate this risk (be selective,',
      'an empty list is valid) and give every non-selected control a rejection reason. Do NOT provide',
      'gap analysis or an overall justification — other batches exist that you cannot see here.',
      '',
      'Use the available tools for anything you need, then call submit_mapping with your decision for this batch.'
    ].join('\n');

    const systemInstruction = 'You are Ema, a GRC Compliance mapping architect reviewing one batch of a larger control library against a single risk. Investigate via the available tools before you conclude.';

    tracer.log('REQUEST', { path: 'chunked_batch', batchIndex: chunkIndex, prompt_preview: initialPrompt });

    const loop = await this.llm.runToolLoop<{ matches: Array<{ index: number; reason: string }>; rejected: Array<{ index: number; reason: string }> }>(
      systemInstruction, initialPrompt, tools, 'submit_mapping', executeTool, 6
    );

    if (!loop) {
      tracer.log('ERROR', { path: 'chunked_batch', batchIndex: chunkIndex, error: 'tool loop did not finalize' });
      return null;
    }

    tracer.log('RESPONSE', { path: 'chunked_batch', batchIndex: chunkIndex, matchesCount: loop.result.matches?.length || 0, rejectedCount: loop.result.rejected?.length || 0 });

    return {
      matches: this.resolveAgainst(loop.result.matches, chunk),
      rejected: [...this.resolveAgainst(loop.result.rejected, chunk), ...this.unmentionedRejections(chunk, loop.result.matches, loop.result.rejected || [])]
    };
  }

  // ── Chunked path (control pool too large for one prompt) ─────────────────
  // Batches run concurrently (same batchSize=5 concurrency convention used by
  // the other two agents' main loops) rather than sequentially — independent,
  // non-overlapping control chunks against the same risk have no reason to
  // wait on each other.
  private async runChunkedWithTools(
    risk: Risk, controls: Control[], alreadyMapped: Control[], entityLabel: string, tracer: AgentTracer
  ): Promise<{ matches: ResolvedControl[]; rejected: ResolvedControl[]; justification: string; gaps: string; recommendation: string; coverageNote: string } | null> {
    const batchSize = RiskControlMappingAgent.BATCH_SIZE;
    const chunksTotal = Math.ceil(controls.length / batchSize);
    const indexedChunks: Array<{ chunk: Control[]; index: number }> = [];
    for (let i = 0; i < controls.length; i += batchSize) {
      indexedChunks.push({ chunk: controls.slice(i, i + batchSize), index: indexedChunks.length + 1 });
    }

    const batchResults = await runInParallelBatches(indexedChunks, 5, async ({ chunk, index }) =>
      withRetry(() => this.mapControlsBatchWithTools(risk, chunk, alreadyMapped, entityLabel, index, chunksTotal, tracer), 2)
    );

    let allMatches: ResolvedControl[] = [];
    let allRejected: ResolvedControl[] = [];
    let chunksOk = 0;
    for (const res of batchResults) {
      if (!res) continue;
      chunksOk++;
      allMatches.push(...res.matches);
      allRejected.push(...res.rejected);
    }

    if (chunksOk === 0) return null;

    allMatches = this.dedupeBySysId(allMatches);
    const coverageNote = chunksOk < chunksTotal
      ? `Note: only ${chunksOk} of ${chunksTotal} control batches were evaluated — re-run to complete coverage.`
      : '';

    // Consolidation call: one combined justification/gaps/recommendation over
    // the matches gathered across all batches (plus already-mapped controls),
    // since no single batch prompt saw the full picture. Plain structured call,
    // not tool-calling — it only needs to synthesize the resolved match list
    // it's handed, nothing left to investigate.
    let justification = '', gaps = '', recommendation = '';
    try {
      const matchedList = [
        ...alreadyMapped.map(c => `- ${c.name} (already mapped from a previous run)`),
        ...allMatches.map(m => `- ${m.name} (${m.reason})`)
      ];
      const consPrompt = [
        this.riskBlock(risk, entityLabel),
        '',
        'MATCHED CONTROLS (selected across all batches, plus any already mapped from before):',
        matchedList.length > 0 ? matchedList.join('\n') : '(none — no existing control matched)',
        '',
        'TASK:',
        '1. overall_justification: 2-3 sentences on the common theme across matched controls',
        '   (or why the library does not cover this risk if none matched).',
        '2. gaps: 2-4 sentences on aspects of the risk NOT covered by matched controls. If fully',
        '   covered say so explicitly.',
        '3. recommendation: only if gaps exist — controls to create, plain text. Empty string otherwise.'
      ].join('\n');
      const consSchema = {
        type: 'OBJECT',
        properties: { overall_justification: { type: 'STRING' }, gaps: { type: 'STRING' }, recommendation: { type: 'STRING' } },
        required: ['overall_justification', 'gaps']
      };

      tracer.log('REQUEST', { path: 'consolidation', prompt_preview: consPrompt });
      const cons = await this.llm.generateStructuredOutput<{ overall_justification: string; gaps: string; recommendation?: string }>(consPrompt, 'You are a GRC Compliance mapping architect writing a consolidated summary.', consSchema);
      tracer.log('RESPONSE', { path: 'consolidation', status: 'completed' });
      justification = cons.overall_justification || '';
      gaps = cons.gaps || '';
      recommendation = cons.recommendation || '';
    } catch (e: any) {
      // Best-effort — matches themselves are already resolved regardless.
      tracer.log('ERROR', { path: 'consolidation', error: e.message });
    }

    return { matches: allMatches, rejected: allRejected, justification, gaps, recommendation, coverageNote };
  }

  // ── Pass 2: self-critique ────────────────────────────────────────────────
  // Second, independent reviewer pass over the fresh match/reject decisions —
  // same framing as the other two agents' critique passes: told what the first
  // pass concluded, asked to find fault with it specifically. Can flip a
  // match to a rejection or vice versa; a failed/unparseable review chunk
  // leaves its decisions exactly as the first pass produced them.
  private async critiqueMappingDecisions(
    risk: Risk, matches: ResolvedControl[], rejected: ResolvedControl[], tracer: AgentTracer
  ): Promise<{ matches: ResolvedControl[]; rejected: ResolvedControl[] }> {
    type Decision = ResolvedControl & { decision: 'match' | 'reject' };
    const allDecisions: Decision[] = [
      ...matches.map(m => ({ ...m, decision: 'match' as const })),
      ...rejected.map(r => ({ ...r, decision: 'reject' as const }))
    ];
    if (allDecisions.length === 0) return { matches, rejected };

    const critiqueChunkSize = 8;
    const chunks: Decision[][] = [];
    for (let i = 0; i < allDecisions.length; i += critiqueChunkSize) {
      chunks.push(allDecisions.slice(i, i + critiqueChunkSize));
    }

    const flips = new Map<string, { decision: 'match' | 'reject'; note: string }>();

    await Promise.all(chunks.map(async chunk => {
      const blocks = chunk.map((d, idx) =>
        `[${idx + 1}] CONTROL: ${d.name} (${d.category})\n    CURRENT DECISION: ${d.decision === 'match' ? 'MAPPED' : 'REJECTED'}\n    REASON: ${d.reason}`
      ).join('\n\n');

      const prompt = [
        'You are Ema, now reviewing your own draft risk-control mapping decisions as a second, independent pass.',
        'For each control below, a first pass already decided whether it maps to this risk and why.',
        'Check whether that decision actually follows from the risk and control shown — not whether you would',
        'phrase it differently.',
        '',
        `RISK: ${risk.name}`,
        `Description: ${(risk.description || 'No description provided.').substring(0, RiskControlMappingAgent.RISK_DESC_LIMIT)}`,
        '',
        blocks,
        '',
        'For each control: if the decision is well-supported, respond action="confirm". If it is not — a mapped',
        'control doesn\'t actually address this specific risk, or a rejected control actually does — respond',
        'action="flip" and explain in "note" specifically what the first pass got wrong.',
        '',
        'Respond ONLY with valid JSON, no markdown:',
        '{"reviews": [{"index": 1, "action": "confirm", "note": ""}, ...]}'
      ].join('\n');

      const schema = {
        type: 'OBJECT',
        properties: {
          reviews: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: { index: { type: 'INTEGER' }, action: { type: 'STRING' }, note: { type: 'STRING' } },
              required: ['index', 'action']
            }
          }
        },
        required: ['reviews']
      };

      tracer.log('REQUEST', { phase: 'critique', prompt_preview: prompt });

      try {
        const response = await this.llm.generateStructuredOutput<{ reviews: Array<{ index: number; action: string; note?: string }> }>(
          prompt, 'You are Ema, acting as an independent second reviewer of draft risk-control mapping decisions.', schema
        );
        tracer.log('RESPONSE', { phase: 'critique', status: 'completed', reviews: response.reviews });
        for (const review of response.reviews || []) {
          const d = chunk[review.index - 1];
          if (!d || review.action !== 'flip') continue;
          flips.set(d.sysId, { decision: d.decision === 'match' ? 'reject' : 'match', note: review.note || 'decision did not hold up against the risk on review.' });
        }
      } catch (e: any) {
        // Critique is an enrichment pass — a failed or unparseable review leaves
        // this chunk's decisions exactly as the first pass produced them.
        tracer.log('ERROR', { phase: 'critique', error: e.message });
      }
    }));

    if (flips.size === 0) return { matches, rejected };

    const annotate = (r: ResolvedControl, note: string): ResolvedControl => ({ ...r, reason: `${r.reason}\n\n🔁 Revised on second-pass review: ${note}` });

    const finalMatches = [
      ...matches.filter(m => !flips.has(m.sysId)),
      ...rejected.filter(r => flips.get(r.sysId)?.decision === 'match').map(r => annotate(r, flips.get(r.sysId)!.note))
    ];
    const finalRejected = [
      ...rejected.filter(r => !flips.has(r.sysId)),
      ...matches.filter(m => flips.get(m.sysId)?.decision === 'reject').map(m => annotate(m, flips.get(m.sysId)!.note))
    ];

    return { matches: finalMatches, rejected: finalRejected };
  }

  // ── Every candidate control already linked to this risk — no LLM call needed ──
  private finishAlreadyMapped(risk: Risk, entityLabel: string, totalControls: number, alreadyMapped: Control[]) {
    const matches: ResolvedControl[] = alreadyMapped.map(c => ({
      sysId: c.sysId, name: c.name, category: c.category || 'General',
      reason: 'Already mapped to this risk from a previous run — no changes needed.'
    }));

    const narrative = [
      `${htmlLabel('SUMMARY:')} All ${alreadyMapped.length} candidate control(s) for this ${htmlEscape(entityLabel.toLowerCase())} are already mapped to this risk from a previous run.`,
      `No new controls to evaluate — nothing was re-decided or re-written.`
    ].join('<br><br>');

    return {
      success: true,
      message: `All ${alreadyMapped.length} control(s) already mapped — nothing new to evaluate.`,
      details: {
        entityLabel,
        entityName: risk.profileName,
        totalControlsEvaluated: totalControls,
        matches,
        rejected: [],
        justification: 'All candidate controls were already mapped to this risk from a previous run.',
        gaps: '',
        recommendations: '',
        narrative
      }
    };
  }

  // ── No controls exist for this entity at all ──────────────────────────────
  private async suggestNewControls(risk: Risk, entityLabel: string, tracer: AgentTracer) {
    const prompt = [
      `You are a GRC expert. No controls exist for this ${entityLabel.toLowerCase()} yet.`,
      '',
      this.riskBlock(risk, entityLabel),
      '',
      'TASK: Suggest 2-4 controls to create to mitigate this risk. Each needs a concise name and a',
      '1-2 sentence description. Also provide a 2-3 sentence explanation of why these controls',
      'together address the risk.'
    ].join('\n');

    const schema = {
      type: 'OBJECT',
      properties: {
        suggested_controls: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, description: { type: 'STRING' } }, required: ['name', 'description'] }
        },
        explanation: { type: 'STRING' }
      },
      required: ['suggested_controls', 'explanation']
    };

    tracer.log('REQUEST', { path: 'suggestNewControls', prompt_preview: prompt });

    const response = await this.llm.generateStructuredOutput<{ suggested_controls: Array<{ name: string; description: string }>; explanation: string }>(
      prompt, 'You are a GRC expert recommending new controls where a library gap exists.', schema
    );

    const suggestions = response.suggested_controls || [];

    tracer.log('RESPONSE', { path: 'suggestNewControls', suggestionsCount: suggestions.length });

    await writeVerified(tracer, `risk-control mapping (no existing controls) for ${risk.sysId}`, () =>
      this.adapter.writeRiskControlMapping(
        risk.sysId,
        [],
        'No controls currently exist in the library for this business unit.',
        `No controls exist in the library to cover risk: ${risk.name}.`,
        suggestions.map(s => `${s.name}: ${s.description}`).join('\n')
      )
    );

    const narrative = [
      `${htmlLabel('SUMMARY:')} No controls exist for ${htmlEscape(entityLabel.toLowerCase())} "${htmlEscape(risk.profileName)}".`,
      `${htmlLabel('SUGGESTED CONTROLS TO CREATE:')}<br>${suggestions.map(c => htmlChoiceLine(c.name, c.description, true)).join('<br>')}`,
      `${htmlLabel('WHY THESE CONTROLS:')}<br>${htmlEscape(response.explanation || 'Not provided')}`
    ].join('<br><br>');

    return {
      success: true,
      message: `No controls available for ${entityLabel.toLowerCase()} — suggested ${suggestions.length} new control(s)`,
      details: {
        entityLabel,
        entityName: risk.profileName,
        totalControlsEvaluated: 0,
        matches: [],
        rejected: [],
        suggestedControls: suggestions,
        explanation: response.explanation,
        narrative
      }
    };
  }

  private async finishMatched(
    risk: Risk, riskSysId: string, entityLabel: string, totalControls: number,
    allMatches: ResolvedControl[], newMatchesToWrite: ResolvedControl[], rejected: ResolvedControl[],
    justification: string, gaps: string, recommendation: string, tracer: AgentTracer, coverageNote: string = ''
  ) {
    // Only write the NEW links — already-mapped controls already have a row in
    // sn_risk_m2m_risk_control, and the live write path has no idempotency
    // check, so re-sending them would create duplicate link rows.
    const verified = newMatchesToWrite.length > 0
      ? await writeVerified(tracer, `risk-control mapping for ${riskSysId}`, () =>
          this.adapter.writeRiskControlMapping(
            riskSysId,
            newMatchesToWrite,
            this.formatText(justification),
            this.formatText(gaps),
            this.formatText(recommendation)
          )
        )
      : true;

    const carriedCount = allMatches.length - newMatchesToWrite.length;
    const narrative = [
      `${htmlLabel('SUMMARY:')} Mapped ${allMatches.length} control(s) to this risk${carriedCount > 0 ? ` (${carriedCount} already mapped from a previous run, ${newMatchesToWrite.length} newly added)` : ''}. Rejected ${rejected.length} control(s).`,
      `${htmlLabel('RATIONALE — why these were picked and why others were rejected:')}<br>${htmlEscape(justification || 'Not provided')}`,
      `${htmlLabel('GAPS — areas not covered by existing controls:')}<br>${htmlEscape(gaps || 'None identified')}`,
      ...(coverageNote ? [htmlEscape(coverageNote)] : [])
    ].join('<br><br>');

    return {
      success: true,
      message: `Mapped ${allMatches.length} control(s) to risk (${newMatchesToWrite.length} new). Rejected ${rejected.length} control(s).`,
      details: {
        entityLabel,
        entityName: risk.profileName,
        totalControlsEvaluated: totalControls,
        matches: allMatches,
        rejected,
        justification,
        gaps,
        recommendations: recommendation,
        narrative,
        verified
      }
    };
  }

  private async finishNoMatch(
    risk: Risk, riskSysId: string, entityLabel: string, totalControls: number, rejected: ResolvedControl[],
    justification: string, gaps: string, recommendation: string, tracer: AgentTracer, coverageNote: string = ''
  ) {
    const verified = await writeVerified(tracer, `risk-control mapping (no match) for ${riskSysId}`, () =>
      this.adapter.writeRiskControlMapping(
        riskSysId,
        [],
        this.formatText(justification),
        this.formatText(gaps),
        this.formatText(recommendation)
      )
    );

    const narrative = [
      `${htmlLabel('SUMMARY:')} Reviewed ${totalControls} control(s) and found none that genuinely mitigate this risk.`,
      `${htmlLabel('RATIONALE — why each was rejected:')}<br>${htmlEscape(justification || 'Not provided')}`,
      `${htmlLabel('GAPS:')}<br>${htmlEscape(gaps || 'Not provided')}`,
      ...(recommendation ? [`${htmlLabel('RECOMMENDED CONTROLS TO CREATE:')}<br>${htmlEscape(recommendation)}`] : []),
      ...(coverageNote ? [htmlEscape(coverageNote)] : [])
    ].join('<br><br>');

    return {
      success: true,
      message: 'No genuine match found — recommendation written',
      details: {
        entityLabel,
        entityName: risk.profileName,
        totalControlsEvaluated: totalControls,
        matches: [],
        rejected,
        justification,
        gaps,
        recommendations: recommendation,
        narrative,
        verified
      }
    };
  }
}

// ============================================================================
// 4. Issue Identification and Creation Agent
// ============================================================================
// Scan-triggered (sn_risk_risk.state moving to Monitor), not chained after
// another agent's write and not a user-click action — none of the three
// assessment agents above ever touch a risk's state field, so a periodic
// scan (see findRisksNeedingIssueReview) is the only viable trigger, not just
// the safer one. Drafts ONE sn_grc_issue per qualifying risk from context the
// platform has already computed (residual rating, approver) — it does not
// repeat the CRA agents' own evidence-gathering, so its tool-calling shape is
// deliberately lighter (2 tools, not 3-4; maxTurns 4, not 6) while still
// holding to the same standards: an investigate-before-concluding tool loop,
// a second self-critique pass with authority to revise, and the same
// writeObservabilityTrace audit trail the CRA agents write to.
export class IssueIdentificationAgent {
  private terminology: { [key: string]: string } | null;

  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {
    this.terminology = this.adapter.getTerminology() || null;
  }

  private formatText(text: string, maxChars = 32768): string {
    if (!text) return text;

    let result = text;
    if (this.terminology) {
      for (const [from, to] of Object.entries(this.terminology)) {
        const regex = new RegExp(`\\b${from}\\b`, 'gi');
        result = result.replace(regex, (match) =>
          match[0] === match[0].toUpperCase() ? to.charAt(0).toUpperCase() + to.slice(1) : to
        );
      }
    }

    if (result.length > maxChars) {
      const truncated = result.substring(0, maxChars);
      const lastSpace = truncated.lastIndexOf(' ');
      return lastSpace > 0 ? truncated.substring(0, lastSpace) : truncated;
    }
    return result;
  }

  // Takes just the risk — same single-targetId convention as the other three
  // agents in /api/run-agent. When and why to call this is decided entirely
  // outside this backend (a ServiceNow client script), so the assessment
  // instance is resolved and duplicate-checked here rather than handed in.
  async execute(riskSysId: string): Promise<{ success: boolean; message: string; details: any }> {
    const tracer = new AgentTracer();
    tracer.log('START', { riskSysId });

    const risk = await this.adapter.getRisk(riskSysId);
    if (!risk) {
      tracer.log('ERROR', { error: 'Risk not found' });
      return { success: false, message: 'Risk not found', details: null };
    }

    const resolveInstance = (this.adapter as any).resolveLatestAssessmentInstance;
    const hasExisting = (this.adapter as any).hasExistingIssueForAssessment;
    const getContext = (this.adapter as any).getIssueDraftContext;
    const getRatingOptions = (this.adapter as any).getIssueRatingOptions;
    const createIssue = (this.adapter as any).createRiskIssue;
    if (typeof resolveInstance !== 'function' || typeof hasExisting !== 'function' ||
        typeof getContext !== 'function' || typeof getRatingOptions !== 'function' || typeof createIssue !== 'function') {
      tracer.log('ERROR', { error: 'Adapter does not support issue drafting' });
      return { success: false, message: 'This platform does not support issue drafting.', details: null };
    }

    const assessmentInstanceSysId = await resolveInstance.call(this.adapter, riskSysId);
    if (!assessmentInstanceSysId) {
      tracer.log('ERROR', { error: 'No assessment instance found for this risk' });
      return { success: false, message: 'No assessment instance found for this risk — cannot draft an issue without assessment context.', details: null };
    }

    const alreadyExists = await hasExisting.call(this.adapter, assessmentInstanceSysId);
    if (alreadyExists === null) {
      tracer.log('ERROR', { error: 'Could not verify whether an issue already exists' });
      return { success: false, message: 'Could not verify whether an issue already exists for this assessment — skipping to avoid a duplicate.', details: null };
    }
    if (alreadyExists) {
      tracer.log('END', { outcome: 'already_exists' });
      return { success: true, message: 'An issue already exists for this risk assessment — no action taken.', details: { alreadyExists: true } };
    }

    const [context, ratingOptions] = await Promise.all([
      getContext.call(this.adapter, assessmentInstanceSysId),
      getRatingOptions.call(this.adapter)
    ]);

    if (!context) {
      tracer.log('ERROR', { error: 'No assessment context available' });
      return { success: false, message: 'Could not read assessment context for this risk.', details: null };
    }

    tracer.log('INFO', {
      riskName: risk.name,
      residualRating: context.residualRatingLabel,
      hasApprover: !!context.approverUserSysId
    });

    const draft = await withRetry(() => this.decideAndDraft(risk, context, tracer), 2);
    if (!draft) {
      tracer.log('ERROR', { error: 'tool loop did not finalize' });
      return { success: false, message: 'AI evaluation failed — please retry.', details: null };
    }

    // ── Pass 2: self-critique — a second, independent look at whether this
    // specific trigger genuinely warrants an issue, or is borderline/noisy,
    // with authority to revise the first pass rather than just re-stating it.
    const decision = await this.critiqueDecision(risk, context, draft, tracer);

    if (!decision.shouldCreateIssue) {
      tracer.log('END', { outcome: 'skipped', reason: decision.skipReason });
      await this.writeTrace(riskSysId, 'skipped', { reason: decision.skipReason }, context, risk, tracer);
      return { success: true, message: `No issue created — ${decision.skipReason}`, details: { skipped: true, reason: decision.skipReason } };
    }

    // ── Resolve the residual rating onto a real sn_grc_issue_rating row ────
    const matchedRating = this.matchIssueRating(context.residualRatingLabel, ratingOptions);
    const finalRating = matchedRating || this.defaultRating(ratingOptions);
    const ratingNote = matchedRating
      ? ''
      : `\n\nNote: could not confidently match the residual rating ("${context.residualRatingLabel || 'not set'}") to a configured issue rating — defaulted to ${finalRating?.label || 'the highest-severity option'} pending manual review.`;

    const rationaleHtml = this.buildRationaleHtml(decision.rationale + ratingNote, risk, context);

    const created = await createIssue.call(this.adapter, {
      riskSysId,
      profileSysId: risk.profileSysId,
      assessmentInstanceSysId,
      issueRatingSysId: finalRating?.sysId || '',
      issueManagerSysId: context.approverUserSysId,
      rationaleHtml,
      shortDescription: `Risk - ${risk.name} requires an issue following move to Monitor status`,
      description: `This issue was automatically created because Risk - ${risk.name}${risk.profileName ? ' within ' + risk.profileName : ''} moved to Monitor status following risk assessment. ${decision.summary}`
    });

    // ── Action plan: a related child record (sn_grc_task), not a field on
    // the issue itself — created only once the parent issue is verified, and
    // its own failure never invalidates an otherwise-successful issue create.
    let actionPlanTaskSysId = '';
    let actionPlanVerified = true;
    const createActionPlan = (this.adapter as any).createActionPlanTask;
    if (created.verified && typeof createActionPlan === 'function' && decision.actionPlan) {
      // The issue-rating labels ("1 - Very High" .. "5 - Very Low") already
      // use the same 1-5 scale ServiceNow priority does — reuse the leading
      // digit rather than inventing a separate mapping.
      const prioritySn = finalRating?.label.match(/^(\d)/)?.[1] || '';
      const planResult = await createActionPlan.call(this.adapter, {
        issueSysId: created.issueSysId,
        title: decision.actionPlanName || `Action plan for ${risk.name}`,
        description: decision.actionPlan,
        ownerSysId: context.approverUserSysId,
        prioritySn
      });
      actionPlanTaskSysId = planResult.taskSysId;
      actionPlanVerified = planResult.verified;
      if (!planResult.taskSysId) {
        tracer.log('WARN', { message: 'Action plan task could not be created for this issue.' });
      }
    }

    const outcome = created.verified ? 'created' : 'create_failed';
    tracer.log('END', { outcome, issueSysId: created.issueSysId, actionPlanTaskSysId });
    await this.writeTrace(riskSysId, outcome, { issueSysId: created.issueSysId, rating: finalRating?.label, rationale: decision.rationale, actionPlanTaskSysId, actionPlan: decision.actionPlan }, context, risk, tracer);

    return created.verified
      ? { success: true, message: `Issue created for risk "${risk.name}".`, details: { issueSysId: created.issueSysId, rating: finalRating?.label, actionPlanTaskSysId, actionPlanVerified } }
      : { success: false, message: 'Issue write could not be verified — platform may have silently dropped a field.', details: { issueSysId: created.issueSysId } };
  }

  private async writeTrace(riskSysId: string, outcome: string, results: any, context: { assessmentNumber: string }, risk: Risk, tracer: AgentTracer): Promise<void> {
    const writeTraceM = (this.adapter as any).writeObservabilityTrace;
    if (typeof writeTraceM !== 'function') return;
    const summary = outcome === 'skipped'
      ? `Skipped for risk "${risk.name}" — ${results.reason || 'no reason recorded'}.`
      : outcome === 'created'
      ? `Issue created for risk "${risk.name}" (rating: ${results.rating || 'n/a'}). Action plan ${results.actionPlanTaskSysId ? 'created' : 'not created'}.`
      : `Issue write could not be verified for risk "${risk.name}" — platform may have silently dropped a field.`;
    try {
      await writeTraceM.call(this.adapter, {
        agentName: 'IssueIdentificationAgent',
        targetId: riskSysId,
        outcome,
        results,
        riskSysId,
        assessmentNumber: context.assessmentNumber,
        html: tracer.renderHtml('IssueIdentificationAgent', context.assessmentNumber || risk.name || riskSysId),
        summary
      });
    } catch (_) { /* observability is best-effort — never block the run */ }
  }

  // Tool declarations + executor for the decision loop. Deliberately lighter
  // than the CRA agents (2 tools, not 3-4) — the residual rating and approver
  // are already computed by the platform and handed in as context, so this
  // agent's only remaining unknowns are the risk's full description and
  // whether related trouble is already on record for its entity.
  private buildDecisionTools(risk: Risk): { tools: ToolDeclaration[]; executeTool: (name: string, args: any) => Promise<any> } {
    const tools: ToolDeclaration[] = [
      {
        name: 'get_risk_full_description',
        description: "Get this risk's full, untruncated description (the description shown above may be truncated).",
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_entity_open_issues',
        description: "Get currently open issues already recorded against this risk's entity — useful context for whether this is already being tracked elsewhere, or whether related problems suggest more urgency.",
        parameters: { type: 'OBJECT', properties: {} }
      }
    ];

    const executeTool = async (name: string, _args: any): Promise<any> => {
      switch (name) {
        case 'get_risk_full_description':
          return { description: risk.description || 'No description provided.' };
        case 'get_entity_open_issues': {
          const issues = await this.adapter.getEntityIssues(risk.profileSysId || '');
          return { issues: issues.map(i => ({ number: i.number, desc: i.desc, state: i.state, priority: i.priority })), count: issues.length };
        }
        default:
          return { error: `Unknown tool: ${name}` };
      }
    };

    return { tools, executeTool };
  }

  // ── Pass 1: investigate-before-concluding tool loop ──────────────────────
  private async decideAndDraft(risk: Risk, context: { residualRatingLabel: string }, tracer: AgentTracer): Promise<{
    shouldCreateIssue: boolean; skipReason: string; rationale: string; summary: string; actionPlanName: string; actionPlan: string
  } | null> {
    const { tools, executeTool } = this.buildDecisionTools(risk);

    const schema = {
      type: 'OBJECT',
      properties: {
        should_create_issue: { type: 'BOOLEAN' },
        skip_reason: { type: 'STRING', description: 'Only meaningful if should_create_issue is false.' },
        rationale: { type: 'STRING', description: 'Full explanation referencing the residual rating, risk description, and any tool evidence gathered.' },
        summary: { type: 'STRING', description: 'One or two plain-language sentences suitable for the issue description field.' },
        action_plan_name: { type: 'STRING', description: 'Only meaningful if should_create_issue is true: a short (under 10 words) title for the remediation action plan, e.g. "Patch vendor systems within SLA".' },
        action_plan: { type: 'STRING', description: 'Only meaningful if should_create_issue is true: a concrete, actionable remediation plan for whoever owns this issue — specific next steps, not a restatement of the rationale. 2-4 short steps is typical. Empty string if should_create_issue is false.' }
      },
      required: ['should_create_issue', 'skip_reason', 'rationale', 'summary', 'action_plan_name', 'action_plan']
    };
    tools.push({ name: 'submit_decision', description: 'Finalize your issue-creation decision once you have gathered enough evidence.', parameters: schema });

    const initialPrompt = [
      `RISK: ${risk.name}`,
      `Description: ${(risk.description || 'No description provided.').substring(0, 600)}`,
      '(Description above may be truncated — call get_risk_full_description for the complete text.)',
      risk.profileName ? `Entity: ${risk.profileName}` : '',
      context.residualRatingLabel ? `Residual rating (calculated by the platform): ${context.residualRatingLabel}` : 'Residual rating: not available',
      '',
      'This risk has just moved to Monitor status following its risk assessment.',
      '',
      'TASK: Decide whether this genuinely warrants creating a formal tracked issue for remediation, or',
      'whether ongoing monitoring alone is sufficient. Most risks reaching Monitor status DO warrant an',
      'issue — only skip when there is a clear reason not to (e.g. residual rating is Low/Very Low and',
      'nothing in the description or open-issue context suggests urgency). If you decide to create an',
      'issue, also draft a concrete action plan — specific next steps the issue owner should take, not a',
      'restatement of why the issue exists. Use the available tools if you need more than what is shown',
      'above, then call submit_decision with your final answer.'
    ].filter(Boolean).join('\n');

    const systemInstruction = 'You are Ema, a GRC risk-issue triage assistant. You investigate before you conclude: pull whatever additional evidence you judge necessary via the available tools, then finalize by calling submit_decision. You review risks that have just moved to Monitor status and decide whether they warrant a formally tracked issue — being selective but not reflexively skeptical, since most risks reaching Monitor status do warrant one. When you do create an issue, you also draft a concrete, actionable remediation plan for it.';

    tracer.log('REQUEST', { prompt_preview: initialPrompt });

    const loop = await this.llm.runToolLoop<{
      should_create_issue: boolean; skip_reason: string; rationale: string; summary: string; action_plan_name: string; action_plan: string;
    }>(systemInstruction, initialPrompt, tools, 'submit_decision', executeTool, 4);

    if (!loop) return null;

    tracer.log('RESPONSE', { shouldCreateIssue: loop.result.should_create_issue, toolCalls: loop.toolCallLog.map(c => c.name) });

    return {
      shouldCreateIssue: !!loop.result.should_create_issue,
      skipReason: loop.result.skip_reason || '',
      rationale: loop.result.rationale || '',
      summary: loop.result.summary || '',
      actionPlanName: loop.result.action_plan_name || '',
      actionPlan: loop.result.action_plan || ''
    };
  }

  // ── Pass 2: self-critique ─────────────────────────────────────────────────
  // A second, independent pass explicitly told the first-pass conclusion and
  // asked to find fault with it — same reflection standard as the CRA agents'
  // critique passes, scoped to one item since this agent runs per-risk rather
  // than in a batch. A failed or unparseable critique leaves the draft
  // untouched rather than corrupting it.
  private async critiqueDecision(
    risk: Risk, context: { residualRatingLabel: string },
    draft: { shouldCreateIssue: boolean; skipReason: string; rationale: string; summary: string; actionPlanName: string; actionPlan: string },
    tracer: AgentTracer
  ): Promise<{ shouldCreateIssue: boolean; skipReason: string; rationale: string; summary: string; actionPlanName: string; actionPlan: string }> {
    const schema = {
      type: 'OBJECT',
      properties: {
        action: { type: 'STRING', enum: ['keep', 'revise'] },
        should_create_issue: { type: 'BOOLEAN' },
        skip_reason: { type: 'STRING', description: 'Required and non-empty whenever should_create_issue is false — this is what gets shown as the reason no issue was created, so it must stand on its own, not just restate critique_note.' },
        rationale: { type: 'STRING' },
        summary: { type: 'STRING' },
        action_plan_name: { type: 'STRING', description: 'Only meaningful if should_create_issue is true.' },
        action_plan: { type: 'STRING', description: 'Only meaningful if should_create_issue is true — revise the first pass\'s action plan if it was vague or not actionable, otherwise keep it.' },
        critique_note: { type: 'STRING', description: 'Why you kept or revised the first-pass decision.' }
      },
      required: ['action', 'should_create_issue', 'skip_reason', 'rationale', 'summary', 'action_plan_name', 'action_plan', 'critique_note']
    };

    const prompt = [
      `RISK: ${risk.name}`,
      context.residualRatingLabel ? `Residual rating: ${context.residualRatingLabel}` : '',
      '',
      'FIRST-PASS DECISION:',
      `should_create_issue: ${draft.shouldCreateIssue}`,
      draft.shouldCreateIssue ? `Rationale: ${draft.rationale}` : `Skip reason: ${draft.skipReason}`,
      draft.shouldCreateIssue ? `Action plan: ${draft.actionPlan}` : '',
      '',
      'TASK: Review this decision critically. Is it genuinely warranted, or is the Monitor-status trigger',
      'borderline/noisy for this specific risk? You have authority to REVISE the decision (flip whether an',
      'issue should be created) if the first pass got it wrong. Otherwise KEEP it as-is. If the decision is',
      'to create an issue, also review the action plan: revise it if it is vague or not actually actionable,',
      'otherwise keep it as drafted.'
    ].filter(Boolean).join('\n');

    const systemInstruction = 'You are Ema, reviewing your own prior first-pass decision as an independent second check. Find fault with it if warranted; otherwise confirm it.';

    try {
      const parsed = await this.llm.generateStructuredOutput<{
        action: string; should_create_issue: boolean; skip_reason?: string; rationale: string; summary: string;
        action_plan_name?: string; action_plan?: string; critique_note: string;
      }>(prompt, systemInstruction, schema);
      tracer.log('CRITIQUE', { action: parsed.action, note: parsed.critique_note });
      if (parsed.action === 'revise') {
        const shouldCreateIssue = !!parsed.should_create_issue;
        return {
          shouldCreateIssue,
          // Falls back to critique_note if skip_reason came back empty despite
          // being required — confirmed live: a revise-to-skip response can
          // otherwise surface an empty reason even though the critique itself
          // gave a perfectly good explanation for the reversal.
          skipReason: shouldCreateIssue ? '' : (parsed.skip_reason || parsed.critique_note || ''),
          rationale: parsed.rationale || draft.rationale,
          summary: parsed.summary || draft.summary,
          actionPlanName: shouldCreateIssue ? (parsed.action_plan_name || draft.actionPlanName) : '',
          actionPlan: shouldCreateIssue ? (parsed.action_plan || draft.actionPlan) : ''
        };
      }
      return draft;
    } catch (e: any) {
      tracer.log('WARN', { message: `Critique pass failed (${e.message}) — keeping first-pass decision.` });
      return draft;
    }
  }

  // Fuzzy-matches the platform's residual rating label onto one of the 5
  // configured sn_grc_issue_rating rows ("1 - Very High" .. "5 - Very Low").
  // Confirmed live that a naive "does the option label contain 'high'" check
  // is not enough: "1 - Very High" also contains the substring "high", so a
  // plain residual rating of "High" was matching the wrong (more severe)
  // option. Word-boundary regex plus an explicit "not very-" exclusion on the
  // option side fixes both directions.
  private matchIssueRating(residualLabel: string, options: Array<{ sysId: string; label: string }>): { sysId: string; label: string } | null {
    if (!residualLabel || options.length === 0) return null;
    const norm = residualLabel.toLowerCase().trim();
    const find = (predicate: (label: string) => boolean) => options.find(o => predicate(o.label.toLowerCase())) || null;

    if (norm.includes('very high')) return find(l => l.includes('very high'));
    if (norm.includes('very low')) return find(l => l.includes('very low'));
    if (/\bhigh\b/.test(norm)) return find(l => l.includes('high') && !l.includes('very high'));
    if (/\b(moderate|medium)\b/.test(norm)) return find(l => l.includes('moderate'));
    if (/\blow\b/.test(norm)) return find(l => l.includes('low') && !l.includes('very low'));

    return null;
  }

  // Fail-safe default when the residual rating can't be confidently matched:
  // err toward the highest-severity option rather than silently understating
  // risk (Section 5.8 of this system's governance standard — explicit
  // fail-safe behavior, never a silent best guess).
  private defaultRating(options: Array<{ sysId: string; label: string }>): { sysId: string; label: string } | null {
    return options.find(o => o.label.toLowerCase().includes('very high')) || options[0] || null;
  }

  private buildRationaleHtml(text: string, risk: Risk, context: { residualRatingLabel: string }): string {
    return [
      `${htmlLabel('Ema — Automated Issue Rationale')}`,
      `${htmlLabel('Risk:')} ${htmlEscape(risk.name)}<br>${htmlLabel('Residual rating at time of review:')} ${htmlEscape(context.residualRatingLabel || 'Not set')}`,
      htmlEscape(text)
    ].join('<br><br>');
  }

}

// ============================================================================
// Note: Schema Discovery / onboarding has moved to
// UniversalSchemaDiscoveryAgent (core/universal_schema_discovery_agent.ts),
// which adds live introspection, vector-based concept matching, and
// generates a config that DynamicAdapter can execute against directly.
// ============================================================================
