import { BaseGRCAdapter } from '../adapters/base';
import { BaseLLMClient, ToolDeclaration } from '../llm/llm_client';
import { Risk, Control, TestEvidence, Factor, MappingResult } from './models';

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

// ============================================================================
// 1. Control Effectiveness Agent
// ============================================================================
export class ControlEffectivenessAgent {
  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {}

  async execute(instanceSysId: string): Promise<{ success: boolean; message: string; details: any[] }> {
    const inst = await this.adapter.getAssessmentInstance(instanceSysId);
    if (!inst) return { success: false, message: 'Assessment instance not found', details: [] };

    const risk = await this.adapter.getRisk(inst.riskSysId);
    if (!risk) return { success: false, message: 'Linked risk not found', details: [] };

    // Use the resolved instance id (see InherentAssessmentAgent note).
    const rows = await this.adapter.getControlFactorRows(inst.sysId);
    if (rows.length === 0) {
      return { success: false, message: 'No control-linked responses found', details: [] };
    }

    const priorInstanceSysId = await this.adapter.getPriorClosedAssessment(inst.riskSysId, instanceSysId);
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
          await this.adapter.writeControlEffectiveness(
            row.sysId,
            carriedScore,
            prior.ratingLabel,
            `📋 WISSDASENSE — Carried forward. No changes in control or tests since last assessment.\nRating: ${prior.ratingLabel}\nPrior reasoning: ${prior.comments}`,
            prior.comments,
            prior.comments,
            fingerprint
          );
          results.push({ control: row.controlName, action: 'copied', rating: prior.ratingLabel, justification: prior.comments });
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
    }

    if (toAssess.length > 0) {
      // ── Pass 1: draft assessment — one tool-calling loop per control ──
      // Each control is its own investigation: the model is handed nothing but the
      // risk/control names and the valid rating scale, and must actively call tools
      // (get_control_details / get_test_evidence / get_associated_issues /
      // get_prior_assessment) to see any evidence at all, deciding for itself which
      // of them it needs and in what order, before calling submit_assessment. This
      // replaces the old single shared prompt that hand-fed every control's full
      // evidence dump upfront regardless of what the model actually needed.
      const drafts: Array<{ item: any; rating: string; score: number; justification: string; toolCallLog?: Array<{ name: string; args: any }> }> = [];

      for (const item of toAssess) {
        if (!item.factorDetails) {
          await this.adapter.writeFailure(item.rowSysId, 'Factor rating scale not configured.');
          continue;
        }

        const draftResult = await this.assessControlWithTools(risk, item, priorInstanceSysId);
        if (!draftResult) {
          await this.adapter.writeFailure(item.rowSysId, 'AI tool-calling investigation did not finalize a rating.');
          results.push({ control: item.controlName, action: 'failed', error: 'tool loop did not finalize' });
          continue;
        }

        drafts.push({ item, ...draftResult });
      }

      // ── Pass 2: self-critique — a second, independent reviewer pass over the
      // same evidence, explicitly told what the first pass concluded and asked to
      // find fault with it (not just re-answer the same question fresh). Mutates
      // drafts in place only when it disagrees; a failed/unparseable critique call
      // leaves every draft exactly as-is, so this pass can only improve or confirm
      // the result, never block or degrade it. ──
      if (drafts.length > 0) {
        await this.critiqueDrafts(drafts);
      }

      for (const draft of drafts) {
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
          '🔍 WISSDASENSE INVESTIGATION — Control Effectiveness Assessment',
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
          `Model: gemini-3.5-flash (WissdaSense) · Assessed: ${formattedDate}`
        ].join('\n');

        // ============================================================
        // 2. Technical audit trail → u_rationale_auditing_purpose (HTML rich text field)
        // ============================================================
        const toolsUsedLine = draft.toolCallLog && draft.toolCallLog.length > 0
          ? `TOOLS THE AGENT CHOSE TO CALL (in order): ${draft.toolCallLog.map(c => c.name).join(' → ')}`
          : 'TOOLS THE AGENT CHOSE TO CALL: none — finalized from the risk/control context alone';

        const auditTrail = [
          `🔍 WISSDASENSE INVESTIGATION (TECHNICAL / AUDIT TRAIL) — Control Effectiveness Assessment`,
          `Rating: ${draft.rating}`,
          `Confidence: ${confidence}`,
          toolsUsedLine,
          `WHAT WAS SEARCHED (table-level detail):`,
          `&nbsp;&nbsp;1. Control details — searched sn_compliance_control (control record) and found: "${item.controlName}"`,
          `&nbsp;&nbsp;2. Control tests — searched sn_audit_control_test (Control Tests related list on the control) and found ${testCount} record${testCount !== 1 ? 's' : ''}: ${testDetailTech}`,
          `&nbsp;&nbsp;3. Associated issues — searched sn_grc_issue (Issue Management module, same records as the Associated Issues tab on the control) and found ${allOpenIssues.length} record${allOpenIssues.length !== 1 ? 's' : ''} not yet Closed Complete: ${issueDetailTech}`,
          `&nbsp;&nbsp;4. Prior assessment history — searched ${priorLineTech}`,
          `CONCLUSION:`,
          draft.justification,
          `Model: gemini-3.5-flash (WissdaSense) · Assessed: ${formattedDate}`
        ].join('<br><br>').replace(
          // Add single <br> between Rating and Confidence (they should sit together)
          `Rating: ${draft.rating}<br><br>Confidence: ${confidence}`,
          `Rating: ${draft.rating}<br>Confidence: ${confidence}`
        );

        await this.adapter.writeControlEffectiveness(
          item.rowSysId,
          draft.score,
          draft.rating,
          draft.justification,
          summary,
          auditTrail,
          item.fingerprint
        );

        results.push({ control: item.controlName, action: 'assessed', rating: draft.rating, justification: draft.justification });
      }
    }

    // Optional: instance-level justification synthesis (control summary + residual).
    // Duck-typed like finalizeInherentAssessment above — only runs when the adapter
    // exposes an instance-level justification concept (e.g. ServiceNow's advanced risk
    // module has inherent_justification / control_justification / residual_justification
    // fields on the assessment instance itself). Most platforms don't model this at all,
    // so this step is silently skipped there rather than treated as an error.
    const getContext = (this.adapter as any).getInstanceJustificationContext;
    if (typeof getContext === 'function') {
      await this.synthesizeInstanceJustifications(inst.sysId, results, getContext);
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
    } | null>
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
    const systemInstruction = 'You are WissdaSense, a GRC compliance-narrative writer.';

    const calcRating = context.calculatedRatings.find(r => r.startsWith('control effectiveness'));
    const calcBlock = context.calculatedRatings.length
      ? `\n\nCALCULATED RATINGS (authoritative — from the platform's scoring engine): ${context.calculatedRatings.join('; ')}\n\nCRITICAL — these are the system of record; your narrative must stay consistent with them, using the findings below only to explain the drivers behind that position.`
      : '';

    const lines = rated.map(r => `- ${r.control} [${r.rating || r.action}]: ${r.justification}`).join('\n');

    let controlJustification = '';
    try {
      const controlPrompt = [
        'You are WissdaSense, writing an executive summary for a compliance manager reviewing',
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

    if (controlJustification && typeof (this.adapter as any).writeControlJustificationSummary === 'function') {
      await (this.adapter as any).writeControlJustificationSummary(instanceSysId, controlJustification);
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
        'You are WissdaSense, writing a RESIDUAL RISK summary for a compliance manager.',
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

    if (residualJustification && typeof (this.adapter as any).writeResidualJustification === 'function') {
      await (this.adapter as any).writeResidualJustification(instanceSysId, residualJustification);
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
        justification: `WissdaSense returned out-of-scale rating ("${rawRating}"). Defaulted to lowest option (${lowestLabel}). Original rationale: ${rawJustification}`
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
  private async critiqueDrafts(drafts: Array<{ item: any; rating: string; score: number; justification: string }>): Promise<void> {
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
      'You are WissdaSense, now reviewing your own draft control-effectiveness ratings as a second, independent pass.',
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

    try {
      const response = await this.llm.generateStructuredOutput<{ reviews: Array<{ index: number; action: string; rating: string; note?: string }> }>(
        prompt,
        'You are WissdaSense, acting as an independent second reviewer of draft GRC ratings.',
        schema
      );
      for (const review of response.reviews || []) {
        const draft = drafts[review.index - 1];
        if (!draft || review.action !== 'revise') continue;
        const resolved = this.resolveRating(draft.item.factorDetails, review.rating, draft.justification);
        draft.rating = resolved.rating;
        draft.score = resolved.score;
        draft.justification = `${draft.justification}\n\n🔁 Revised on second-pass review: ${review.note || 'rating did not hold up against the evidence on review.'}`;
      }
    } catch (e) {
      // Critique is an enrichment pass — a failed or unparseable review leaves
      // every draft exactly as the first pass produced it, rather than blocking
      // or corrupting the run.
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
    priorInstanceSysId: { sysId: string; number: string } | null
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

    const loop = await this.llm.runToolLoop<{ rating: string; justification: string }>(
      'You are WissdaSense, a GRC control-effectiveness assessment agent. You investigate before you conclude: gather evidence via the available tools, then submit exactly one final assessment.',
      initialPrompt,
      tools,
      'submit_assessment',
      executeTool,
      6
    );

    if (!loop) return null;

    const resolved = this.resolveRating(factorDetails, loop.result.rating, loop.result.justification);
    return { rating: resolved.rating, score: resolved.score, justification: resolved.justification, toolCallLog: loop.toolCallLog };
  }
}

// ============================================================================
// 2. Inherent Assessment Agent
// ============================================================================
export class InherentAssessmentAgent {
  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {}

  async execute(instanceSysId: string): Promise<{ success: boolean; message: string; details: any[] }> {
    const inst = await this.adapter.getAssessmentInstance(instanceSysId);
    if (!inst) return { success: false, message: 'Assessment instance not found', details: [] };

    const risk = await this.adapter.getRisk(inst.riskSysId);
    if (!risk) return { success: false, message: 'Linked risk not found', details: [] };

    // Use the RESOLVED instance id — for create-on-demand platforms
    // (Salesforce inherent flow) the caller passes a risk id and
    // getAssessmentInstance returns the freshly created assessment.
    const factors = await this.adapter.getAnswerableManualRows(inst.sysId);
    if (factors.length === 0) {
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
    if (priorInstanceSysId) {
      for (const factor of factors) {
        const prior = await this.adapter.getPriorControlAnswer(priorInstanceSysId.sysId, '', factor.factorSysId);
        if (prior && prior.factorResponse) {
          const carriedScore = parseInt(prior.factorResponse, 10);
          await this.adapter.writeInherentFactor(
            factor.sysId,
            carriedScore,
            prior.ratingLabel,
            prior.comments,
            `📋 WISSDASENSE — Carried forward from prior closed assessment${priorInstanceSysId.number ? ' ' + priorInstanceSysId.number : ''}. No fresh evaluation this cycle.\nRating: ${prior.ratingLabel}\nPrior reasoning: ${prior.comments}`,
            prior.comments
          );
          results.push({ factor: factor.factorName, action: 'copied', rating: prior.ratingLabel, justification: prior.comments });
        } else {
          await this.adapter.writeFailure(factor.sysId, 'No prior value available to carry forward.');
          results.push({ factor: factor.factorName, rating: null, error: 'no prior value to copy' });
        }
      }

      const writeInherentSummary = (this.adapter as any).writeInherentJustificationSummary;
      if (typeof writeInherentSummary === 'function') {
        await writeInherentSummary.call(
          this.adapter,
          inst.sysId,
          `Carried forward from prior closed assessment${priorInstanceSysId.number ? ' ' + priorInstanceSysId.number : ''}. Ratings and supporting rationale were unchanged and reused without a new evaluation this cycle.`
        );
      }

      const finalizeCopied = (this.adapter as any).finalizeInherentAssessment;
      if (typeof finalizeCopied === 'function') {
        await finalizeCopied.call(this.adapter, inst.sysId);
      }

      return { success: true, message: `Copied ${results.length} inherent factor(s) from prior closed assessment.`, details: results };
    }

    // ── Fresh assessment: entity issue signal, shared context for every factor ──
    const entityIssues = await this.adapter.getEntityIssues(risk.profileSysId || '');

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

    for (const factor of factors) {
      const draftResult = await this.assessFactorWithTools(risk, factor, entityIssues, entityLabel, isSalesforce);
      if (!draftResult) {
        await this.adapter.writeFailure(factor.sysId, 'AI tool-calling investigation did not finalize a rating.');
        results.push({ factor: factor.factorName, rating: null, error: 'tool loop did not finalize' });
        continue;
      }
      drafts.push({ factor, ...draftResult });
    }

    // ── Pass 2: self-critique — a second, independent reviewer pass, same pattern
    // as Control Effectiveness: explicitly told what the first pass concluded and
    // asked to find fault with it, not just re-answer fresh. ──
    if (drafts.length > 0) {
      await this.critiqueFactorDrafts(drafts);
    }

    // ── Finalize: write each factor's response ──
    for (const draft of drafts) {
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
        '🔍 WISSDASENSE INVESTIGATION — Inherent Risk Factor Assessment',
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
        `Model: gemini-3.5-flash (WissdaSense) · Assessed: ${formattedDate}`
      ].join('\n');

      const auditTrail = [
        `🔍 WISSDASENSE INVESTIGATION (TECHNICAL / AUDIT TRAIL) — Inherent Risk Factor Assessment`,
        `Rating: ${draft.rating}`,
        `Confidence: ${confidence}`,
        toolsUsedLine,
        `WHAT WAS SEARCHED (table-level detail):`,
        `&nbsp;&nbsp;1. ${entitySearchLabel} issues — searched ${techSearchTableLabel}; found ${issueCount} unresolved issue${issueCount !== 1 ? 's' : ''} not Closed Complete`,
        `&nbsp;&nbsp;2. Relevant issues — ${issueRelevanceLine}`,
        `CONCLUSION:`,
        draft.justification,
        `Model: gemini-3.5-flash (WissdaSense) · Assessed: ${formattedDate}`
      ].join('<br><br>').replace(
        `Rating: ${draft.rating}<br><br>Confidence: ${confidence}`,
        `Rating: ${draft.rating}<br>Confidence: ${confidence}`
      ).replace(
        `CONCLUSION:<br><br>${draft.justification}`,
        `CONCLUSION:<br>${draft.justification}`
      );

      await this.adapter.writeInherentFactor(
        factor.sysId,
        draft.score,
        draft.rating,
        draft.justification,
        comment,
        auditTrail
      );
      results.push({ factor: factor.factorName, rating: draft.rating, score: draft.score, justification: draft.justification });
    }

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
      await this.synthesizeInherentJustification(inst.sysId, results, rawWriteInherentSummary.bind(this.adapter));
    }

    // Optional platform-specific finalization step (e.g. Salesforce Risk
    // package Band/rollup enrichment) — not part of BaseGRCAdapter since
    // it's a concept only some adapters implement; duck-typed so
    // ServiceNow/hand-written Salesforce adapters are unaffected.
    const finalize = (this.adapter as any).finalizeInherentAssessment;
    if (typeof finalize === 'function') {
      await finalize.call(this.adapter, inst.sysId);
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
    isSalesforce: boolean
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

    const loop = await this.llm.runToolLoop<{ rating: string; issue_relevant: boolean; relevant_issues?: string[]; issue_note?: string; justification: string }>(
      'You are WissdaSense, an inherent risk factor evaluator. You investigate before you conclude: gather the rubric and issue context via the available tools, then submit exactly one final rating.',
      initialPrompt,
      tools,
      'submit_rating',
      executeTool,
      5
    );

    if (!loop) return null;

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
  private async critiqueFactorDrafts(drafts: Array<{ factor: any; rating: string; score: number; justification: string; issueRelevant: boolean; relevantIssues: string[]; issueNote: string }>): Promise<void> {
    const blocks = drafts.map((d, idx) => {
      const choiceStr = d.factor.choiceList.join(', ');
      return `[${idx + 1}] FACTOR: ${d.factor.factorName}\n    Guidance: ${d.factor.guidance || '(none provided)'}\n    Valid ratings: ${choiceStr}\n    DRAFT RATING: ${d.rating}\n    DRAFT ISSUE RELEVANCE: ${d.issueRelevant ? 'relevant — ' + d.relevantIssues.join('; ') : 'not relevant'}${d.issueNote ? ' (' + d.issueNote + ')' : ''}\n    DRAFT JUSTIFICATION: ${d.justification}`;
    }).join('\n\n');

    const prompt = [
      'You are WissdaSense, now reviewing your own draft inherent-risk-factor ratings as a second, independent pass.',
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

    try {
      const response = await this.llm.generateStructuredOutput<{ reviews: Array<{ index: number; action: string; rating: string; note?: string }> }>(
        prompt,
        'You are WissdaSense, acting as an independent second reviewer of draft GRC ratings.',
        schema
      );
      for (const review of response.reviews || []) {
        const draft = drafts[review.index - 1];
        if (!draft || review.action !== 'revise') continue;
        const score = this.resolveInherentRating(draft.factor, review.rating);
        if (score === undefined) continue; // an invalid revision is discarded, not applied
        draft.rating = review.rating;
        draft.score = score;
        draft.justification = `${draft.justification}\n\n🔁 Revised on second-pass review: ${review.note || 'rating did not hold up against the rubric on review.'}`;
      }
    } catch (e) {
      // Critique is an enrichment pass — a failed or unparseable review leaves every
      // draft exactly as the first pass produced it, rather than blocking the run.
    }
  }

  // ── Instance-level narrative synthesis (inherent_justification) ─────────
  // Mirrors ControlEffectivenessAgent.synthesizeInstanceJustifications: one Gemini call
  // producing a 3-5 sentence executive summary, anchored to the platform's own
  // calculated inherent rating where available so the prose never contradicts it.
  private async synthesizeInherentJustification(
    instanceSysId: string,
    results: any[],
    writeInherentSummary: (instanceSysId: string, text: string) => Promise<void>
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
      'You are WissdaSense, writing an executive summary for a compliance manager reviewing inherent risk factor',
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
      const parsed = await this.llm.generateStructuredOutput<{ summary: string }>(prompt, 'You are WissdaSense, a GRC compliance-narrative writer.', schema);
      summary = parsed.summary || '';
    } catch (e) {
      // Synthesis is a best-effort enrichment — never block the rest of the run on it.
    }

    if (summary) {
      await writeInherentSummary(instanceSysId, summary);
    }
  }
}

// ============================================================================
// 3. Risk-Control Mapping Agent
// ============================================================================
export class RiskControlMappingAgent {
  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {}

  async execute(riskSysId: string): Promise<{ success: boolean; message: string; details: any }> {
    const risk = await this.adapter.getRisk(riskSysId);
    if (!risk) return { success: false, message: 'Risk not found', details: null };

    const entityLabel = this.adapter.getEntityLabel();
    const controls = await this.adapter.getControlsForEntity(risk.profileSysId || '');
    if (controls.length === 0) {
      return { success: false, message: `No controls available for ${entityLabel.toLowerCase()}`, details: null };
    }

    const prompt = [
      `RISK:`,
      `Name: ${risk.name}`,
      `Description: ${risk.description}`,
      `${entityLabel}: ${risk.profileName}`,
      '',
      `CANDIDATE CONTROLS (${controls.length} total from this ${entityLabel}):`,
      controls.map((c, idx) => `[${idx + 1}] Name: ${c.name} | Category: ${c.category || 'General'} | Desc: ${c.description}`).join('\n'),
      '',
      'TASK:',
      '1. Select ALL controls that meaningfully mitigate this specific risk.',
      '2. For EVERY control NOT selected, provide a concise rejection reason explaining why it does NOT meet the business criteria for this risk.',
      '3. Provide overall justification, gaps, and specific recommendations.'
    ].join('\n');

    const systemInstruction = 'You are a GRC Compliance mapping architect. Analyze risks and select mapping control indexes. For every rejected control, explain why it does not address the business criteria of this specific risk.';
    
    const schema = {
      type: 'OBJECT',
      properties: {
        match: { type: 'BOOLEAN' },
        matches: {
          type: 'ARRAY',
          description: 'Controls that SHOULD be mapped — they address this risk.',
          items: {
            type: 'OBJECT',
            properties: {
              index: { type: 'INTEGER' },
              reason: { type: 'STRING', description: 'Why this control mitigates the risk' }
            },
            required: ['index', 'reason']
          }
        },
        rejected: {
          type: 'ARRAY',
          description: 'Controls that should NOT be mapped — they do not meet business criteria for this risk.',
          items: {
            type: 'OBJECT',
            properties: {
              index: { type: 'INTEGER' },
              reason: { type: 'STRING', description: 'Why this control does NOT mitigate the risk' }
            },
            required: ['index', 'reason']
          }
        },
        overall_justification: { type: 'STRING' },
        gaps: { type: 'STRING' },
        recommendation: { type: 'STRING' }
      },
      required: ['match', 'matches', 'rejected', 'overall_justification', 'gaps']
    };

    const response = await this.llm.generateStructuredOutput<MappingResult>(prompt, systemInstruction, schema);
    
    const resolvedMatches = response.matches
      .map(m => {
        const ctrl = controls[m.index - 1];
        return ctrl ? { sysId: ctrl.sysId, name: ctrl.name, category: ctrl.category || 'General', reason: m.reason } : null;
      })
      .filter((m): m is { sysId: string; name: string; category: string; reason: string } => m !== null);

    // Build the full rejected list: use LLM-provided rejections + any controls not mentioned at all
    const mentionedIndexes = new Set([
      ...response.matches.map(m => m.index),
      ...(response.rejected || []).map(r => r.index)
    ]);
    const llmRejected = (response.rejected || []).map(r => {
      const ctrl = controls[r.index - 1];
      return ctrl ? { sysId: ctrl.sysId, name: ctrl.name, category: ctrl.category || 'General', reason: r.reason } : null;
    }).filter(Boolean) as { sysId: string; name: string; category: string; reason: string }[];

    // Any controls not mentioned by LLM get a generic rejection note
    const unmentioned = controls
      .map((ctrl, idx) => ({ ctrl, idx: idx + 1 }))
      .filter(({ idx }) => !mentionedIndexes.has(idx))
      .map(({ ctrl }) => ({ sysId: ctrl.sysId, name: ctrl.name, category: ctrl.category || 'General', reason: 'Not evaluated as relevant to the specific risk profile and description provided.' }));

    const resolvedRejected = [...llmRejected, ...unmentioned];

    await this.adapter.writeRiskControlMapping(
      riskSysId,
      resolvedMatches,
      response.overall_justification,
      response.gaps,
      response.recommendation || ''
    );

    return {
      success: true,
      message: `Mapped ${resolvedMatches.length} control(s) to risk. Rejected ${resolvedRejected.length} control(s).`,
      details: {
        entityLabel,
        entityName: risk.profileName,
        totalControlsEvaluated: controls.length,
        matches: resolvedMatches,
        rejected: resolvedRejected,
        justification: response.overall_justification,
        gaps: response.gaps,
        recommendations: response.recommendation
      }
    };
  }
}

// ============================================================================
// Note: Schema Discovery / onboarding has moved to
// UniversalSchemaDiscoveryAgent (core/universal_schema_discovery_agent.ts),
// which adds live introspection, vector-based concept matching, and
// generates a config that DynamicAdapter can execute against directly.
// ============================================================================
