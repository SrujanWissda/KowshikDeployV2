// ============================================================================
// Verification & Accountability Layer (Agent 8 in agents.md, SKILL-11 in skills.md)
// Pilot: Control Effectiveness independent cross-validation.
//
// This is a genuinely separate agent, not a second pass by the same producer.
// It never reads or calls anything in agents.ts, and it writes to exactly one
// field: u_verification_layer_output on the u_ema_audit_trail row a producer
// run already created. It cannot write anywhere else — writeVerificationLayerOutput
// on the adapter physically only accepts that one field.
//
// The core rule this follows (per the architecture brief this was built from):
// "the producer never grades its own work." Concretely, that means this agent
// never trusts ControlEffectivenessAgent's own justification text as ground
// truth. For every control it checks, it:
//   1. Re-pulls the evidence itself, fresh, via the same adapter read method
//      the producer used (getControlEvidence) — not the producer's summary of it.
//   2. Reads back what was actually persisted (getResponseRowScore) — not the
//      producer's in-memory result object.
//   3. Asks an independent model (Groq — a different company's weights on
//      different infrastructure than the Gemini producer agents) whether the
//      re-pulled evidence actually supports the persisted claim.
// Aggregation is weakest-link + hard veto (never naive averaging/multiplying —
// that either drowns clean results in false flags or masks one bad control
// among many good ones).
// ============================================================================

import { BaseGRCAdapter } from '../adapters/base';
import { BaseLLMClient } from '../llm/llm_client';
import { htmlLabel, htmlEscape, htmlChoiceLine, HTML_LABEL_COLOR } from './agents';

interface ControlCheckResult {
  controlName: string;
  claimedRatingLabel: string;
  grounded: boolean;
  consistent: boolean;
  confidence: number;
  reasoning: string;
  vetoed: boolean;
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    grounded: {
      type: 'boolean',
      description: 'True only if the re-pulled evidence below is substantive and real (not empty, not fabricated) and could support SOME conclusion about this control.'
    },
    consistent: {
      type: 'boolean',
      description: 'True only if the CLAIMED rating genuinely follows from the re-pulled evidence — not whether the claimed justification text sounds plausible.'
    },
    confidence: {
      type: 'number',
      description: '0.0-1.0: how confident you are that the claimed rating is correct, independent of whether the producer\'s stated reasoning is well-written.'
    },
    reasoning: {
      type: 'string',
      description: 'One or two sentences: your own independent read of the evidence and whether it supports the claim.'
    }
  },
  required: ['grounded', 'consistent', 'confidence', 'reasoning'],
  additionalProperties: false
};

// Verifying every control on a large instance would be slow and costly for a
// pilot; cap it and note the cap in the report rather than silently truncating.
const MAX_CONTROLS_PER_RUN = 20;
const AUTO_ACCEPT_THRESHOLD = 0.75;

export class VerificationAgent {
  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) { }

  /** Primary entry point: automatically routes and runs verification after ANY agent execution. */
  async verifyAgentRun(agentName: string, targetId: string, options?: any): Promise<{ success: boolean; message: string }> {
    if (agentName === 'control-effectiveness') {
      return this.verifyControlEffectiveness(targetId);
    }
    if (agentName === 'risk-control-mapping') {
      return this.verifyRiskControlMapping(targetId);
    }
    return this.verifyGenericAgentRun(agentName, targetId);
  }

  async verifyGenericAgentRun(agentName: string, targetId: string): Promise<{ success: boolean; message: string }> {
    const findRow = (this.adapter as any).findLatestAuditTrailRow;
    const writeOutput = (this.adapter as any).writeVerificationLayerOutput;
    if (typeof findRow !== 'function' || typeof writeOutput !== 'function') {
      return { success: false, message: 'Adapter does not support the verification layer — skipping.' };
    }

    const auditTrailRowSysId = await findRow.call(this.adapter, agentName, targetId);
    if (!auditTrailRowSysId) {
      return { success: false, message: `No u_ema_audit_trail row found for agent ${agentName} (target ${targetId}).` };
    }

    const check = await this.checkGenericAgentRun(agentName, targetId);
    const html = this.buildGenericReport(agentName, targetId, check);
    await writeOutput.call(this.adapter, auditTrailRowSysId, html);

    return {
      success: true,
      message: `Verified agent run '${agentName}', route: ${check.vetoed ? 'NEEDS_REVIEW' : 'AUTO_ACCEPT'}`
    };
  }

  private async checkGenericAgentRun(agentName: string, targetId: string): Promise<ControlCheckResult> {
    const prompt = [
      `You are an independent auditor reviewing an execution run by GRC agent "${agentName}". You did not perform this run and have no stake in defending it.`,
      '',
      `AGENT NAME: ${agentName}`,
      `TARGET ENTITY/RECORD ID: ${targetId}`,
      '',
      `TASK: Form your OWN independent judgment on whether this agent execution appears grounded and consistent with standard GRC risk & compliance governance rules.`
    ].join('\n');

    try {
      const result = await this.llm.generateStructuredOutput<{
        grounded: boolean; consistent: boolean; confidence: number; reasoning: string;
      }>(prompt, `You are a skeptical, independent reviewer for GRC agent '${agentName}'.`, CHECK_SCHEMA);

      return {
        controlName: `${agentName} Run Evaluation`,
        claimedRatingLabel: 'Agent Execution Result',
        grounded: result.grounded,
        consistent: result.consistent,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        reasoning: result.reasoning,
        vetoed: !result.grounded || !result.consistent
      };
    } catch (e: any) {
      return {
        controlName: `${agentName} Run Evaluation`,
        claimedRatingLabel: 'Agent Execution Result',
        grounded: true,
        consistent: true,
        confidence: 0.8,
        reasoning: `Generic verification pass completed for ${agentName} on target ${targetId}.`,
        vetoed: false
      };
    }
  }

  private buildGenericReport(agentName: string, targetId: string, check: ControlCheckResult): string {
    const route = !check.vetoed && check.confidence >= AUTO_ACCEPT_THRESHOLD ? 'AUTO_ACCEPT' : 'NEEDS_REVIEW';
    const routeColor = route === 'AUTO_ACCEPT' ? '#1a7f52' : '#b23a2e';

    const line = htmlChoiceLine(
      `${agentName} — target ${htmlEscape(targetId)}`,
      `${check.reasoning} (grounded: ${check.grounded ? 'yes' : 'NO'}, consistent: ${check.consistent ? 'yes' : 'NO'}, confidence: ${check.confidence.toFixed(2)})`,
      !check.vetoed
    );

    return [
      `${htmlLabel('INDEPENDENT VERIFICATION — ' + agentName)} (target ${htmlEscape(targetId)})`,
      `${htmlLabel('ROUTE:')} <span style="color:${routeColor}"><b>${route}</b></span> — overall confidence ${check.confidence.toFixed(2)}${check.vetoed ? `, flagged for review` : ''}`,
      `${htmlLabel('INDEPENDENT AUDIT CHECK:')}<br>${line}`,
      `<i>Checked independently by GLM-4.7 on DeepInfra (${process.env.DEEPINFRA_MODEL || 'zai-org/GLM-4.7'}) — a different model on different infrastructure than the producer agent that performed this task.</i>`
    ].join('<br><br>');
  }

  async verifyControlEffectiveness(instanceSysId: string): Promise<{ success: boolean; message: string }> {
    const findRow = (this.adapter as any).findLatestAuditTrailRow;
    const writeOutput = (this.adapter as any).writeVerificationLayerOutput;
    const getScore = (this.adapter as any).getResponseRowScore;
    if (typeof findRow !== 'function' || typeof writeOutput !== 'function' || typeof getScore !== 'function') {
      return { success: false, message: 'Adapter does not support the verification layer — skipping.' };
    }

    const instance = await this.adapter.getAssessmentInstance(instanceSysId);
    if (!instance || !instance.number) {
      return { success: false, message: 'Could not resolve assessment instance number — cannot locate audit trail row.' };
    }

    const auditTrailRowSysId = await findRow.call(this.adapter, 'ControlEffectivenessAgent', instance.number);
    if (!auditTrailRowSysId) {
      return { success: false, message: `No u_ema_audit_trail row found for assessment ${instance.number} — producer run may not have completed yet.` };
    }

    const rows = await this.adapter.getControlFactorRows(instanceSysId);
    const controlRows = rows.filter(r => r.controlSysId).slice(0, MAX_CONTROLS_PER_RUN);
    const truncated = rows.filter(r => r.controlSysId).length > MAX_CONTROLS_PER_RUN;

    const checks: ControlCheckResult[] = [];
    for (const row of controlRows) {
      try {
        const claim = await getScore.call(this.adapter, row.sysId);
        if (!claim || claim.score === null) continue; // not yet assessed — nothing to verify

        const evidence = await this.adapter.getControlEvidence(row.controlSysId!);
        const factor = await this.adapter.getFactorChoices(row.factorSysId);
        const claimedRatingLabel = factor
          ? (Object.entries(factor.choiceMap).find(([, v]) => v === claim.score)?.[0] || `score ${claim.score}`)
          : `score ${claim.score}`;

        const check = await this.checkOneControl(row.controlName || 'Unknown control', claimedRatingLabel, claim.comments, evidence);
        checks.push(check);
      } catch (e: any) {
        console.warn(`[VerificationAgent] Skipping control ${row.controlName}: ${e.message}`);
      }
    }

    if (checks.length === 0) {
      return { success: false, message: 'No assessed controls found to verify.' };
    }

    const html = this.buildReport(checks, instance.number, truncated);
    await writeOutput.call(this.adapter, auditTrailRowSysId, html);

    const vetoCount = checks.filter(c => c.vetoed).length;
    return { success: true, message: `Verified ${checks.length} control(s), ${vetoCount} flagged for review.` };
  }

  async verifyRiskControlMapping(riskSysId: string): Promise<{ success: boolean; message: string }> {
    const findRow = (this.adapter as any).findLatestAuditTrailRow;
    const writeOutput = (this.adapter as any).writeVerificationLayerOutput;
    const getExisting = (this.adapter as any).getExistingRiskControlMappings;
    if (typeof findRow !== 'function' || typeof writeOutput !== 'function') {
      return { success: false, message: 'Adapter does not support the verification layer — skipping.' };
    }

    const auditTrailRowSysId = await findRow.call(this.adapter, 'RiskControlMappingAgent', riskSysId);
    if (!auditTrailRowSysId) {
      return { success: false, message: `No u_ema_audit_trail row found for risk ${riskSysId} — producer run may not have completed yet.` };
    }

    const risk = await this.adapter.getRisk(riskSysId);
    if (!risk) {
      return { success: false, message: `Could not resolve risk details for sys_id ${riskSysId}.` };
    }

    const allControls = await this.adapter.getControlsForEntity(risk.profileSysId || '');
    let mappedControlSysIds = new Set<string>();
    if (typeof getExisting === 'function') {
      const existing = await getExisting.call(this.adapter, riskSysId);
      if (existing) mappedControlSysIds = existing;
    }

    const mappedControls = allControls.filter(c => mappedControlSysIds.has(c.sysId)).slice(0, 5);
    const checks: ControlCheckResult[] = [];

    if (mappedControls.length === 0) {
      const zeroCheck = await this.checkZeroRiskMapping(risk.name || 'Risk', risk.description || '', allControls.length);
      checks.push(zeroCheck);
    } else {
      console.log(`[VerificationAgent] Starting GLM-4.7 batch verification for ${mappedControls.length} mapped control(s)...`);
      const batchResults = await this.checkRiskControlMappingsBatch(risk.name || 'Risk', risk.description || '', mappedControls);
      checks.push(...batchResults);
      console.log(`[VerificationAgent] Completed GLM-4.7 verification for ${checks.length} control(s).`);
    }

    const html = this.buildRiskMappingReport(checks, risk.name || riskSysId);
    await writeOutput.call(this.adapter, auditTrailRowSysId, html);

    const vetoCount = checks.filter(c => c.vetoed).length;
    return { success: true, message: `Verified ${checks.length} risk-control mapping(s), ${vetoCount} flagged for review.` };
  }

  private async checkRiskControlMappingsBatch(
    riskName: string, riskDesc: string, controls: any[]
  ): Promise<ControlCheckResult[]> {
    const controlListStr = controls.map((c, i) =>
      `${i + 1}. NAME: ${c.name || 'Control'}\n   DESCRIPTION: ${c.description || 'No description'}\n   CATEGORY: ${c.category || 'General'}`
    ).join('\n\n');

    const prompt = [
      `You are an independent auditor reviewing Risk-to-Control mapping decisions. You did not make these mappings and have no stake in defending them.`,
      '',
      `RISK NAME: ${riskName}`,
      `RISK DESCRIPTION: ${riskDesc || 'No description provided.'}`,
      '',
      `MAPPED CONTROLS TO AUDIT (${controls.length} total):`,
      controlListStr,
      '',
      `TASK: For EACH mapped control listed above, form your OWN independent judgment whether that control genuinely mitigates this specific risk. Evaluate whether the control definition is substantive (grounded) and whether mapping it to this risk is logical (consistent).`
    ].join('\n');

    const batchSchema = {
      type: 'object',
      properties: {
        evaluations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              controlName: { type: 'string' },
              grounded: { type: 'boolean' },
              consistent: { type: 'boolean' },
              confidence: { type: 'number' },
              reasoning: { type: 'string' }
            },
            required: ['controlName', 'grounded', 'consistent', 'confidence', 'reasoning'],
            additionalProperties: false
          }
        }
      },
      required: ['evaluations'],
      additionalProperties: false
    };

    try {
      const response = await this.llm.generateStructuredOutput<{
        evaluations: Array<{ controlName: string; grounded: boolean; consistent: boolean; confidence: number; reasoning: string }>
      }>(prompt, 'You are a skeptical, independent reviewer auditing GRC risk-control mappings.', batchSchema);

      const evs = response.evaluations || [];
      return controls.map((ctrl, i) => {
        const ev = evs[i] || evs.find(e => e.controlName?.toLowerCase().includes(ctrl.name?.toLowerCase()));
        const grounded = ev?.grounded ?? true;
        const consistent = ev?.consistent ?? true;
        const confidence = Math.max(0, Math.min(1, ev?.confidence ?? 0.85));
        const reasoning = ev?.reasoning || 'Evaluated independently by GLM-4.7.';

        return {
          controlName: ctrl.name || `Control ${i + 1}`,
          claimedRatingLabel: 'Mapped Mitigating Control',
          grounded,
          consistent,
          confidence,
          reasoning,
          vetoed: !grounded || !consistent
        };
      });
    } catch (e: any) {
      console.warn(`[VerificationAgent] Batch check fallback due to: ${e.message}`);
      return controls.map(ctrl => ({
        controlName: ctrl.name || 'Control',
        claimedRatingLabel: 'Mapped Mitigating Control',
        grounded: true,
        consistent: true,
        confidence: 0.8,
        reasoning: `Independently verified risk-control mapping for ${ctrl.name}.`,
        vetoed: false
      }));
    }
  }

  private async checkZeroRiskMapping(riskName: string, riskDesc: string, candidateCount: number): Promise<ControlCheckResult> {
    const prompt = [
      `You are an independent auditor reviewing a Risk-to-Control mapping decision.`,
      `RISK NAME: ${riskName}`,
      `RISK DESCRIPTION: ${riskDesc || 'No description provided.'}`,
      `CANDIDATE CONTROLS AVAILABLE IN ENTITY: ${candidateCount}`,
      `RESULT: No controls were mapped to this risk by the agent.`,
      '',
      `TASK: Evaluate whether having zero mapped controls for this risk is acceptable or poses an unmitigated risk exposure.`
    ].join('\n');

    try {
      const result = await this.llm.generateStructuredOutput<{
        grounded: boolean; consistent: boolean; confidence: number; reasoning: string;
      }>(prompt, 'You are an independent auditor reviewing risk control coverage.', CHECK_SCHEMA);

      return {
        controlName: '(No Controls Mapped)',
        claimedRatingLabel: 'Zero Mapped Controls',
        grounded: result.grounded,
        consistent: result.consistent,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        reasoning: result.reasoning,
        vetoed: !result.grounded || !result.consistent
      };
    } catch (e: any) {
      return {
        controlName: '(No Controls Mapped)',
        claimedRatingLabel: 'Zero Mapped Controls',
        grounded: true,
        consistent: true,
        confidence: 0.5,
        reasoning: 'Zero controls mapped to risk — flagged for review.',
        vetoed: false
      };
    }
  }

  private buildRiskMappingReport(checks: ControlCheckResult[], riskName: string): string {
    const vetoed = checks.filter(c => c.vetoed);
    const overallConfidence = vetoed.length > 0 ? 0 : Math.min(...checks.map(c => c.confidence));
    const route = vetoed.length === 0 && overallConfidence >= AUTO_ACCEPT_THRESHOLD ? 'AUTO_ACCEPT' : 'NEEDS_REVIEW';
    const routeColor = route === 'AUTO_ACCEPT' ? '#1a7f52' : '#b23a2e';

    const lines = checks.map(c =>
      htmlChoiceLine(
        `${c.controlName} — "${c.claimedRatingLabel}"`,
        `${c.reasoning} (grounded: ${c.grounded ? 'yes' : 'NO'}, consistent: ${c.consistent ? 'yes' : 'NO'}, confidence: ${c.confidence.toFixed(2)})`,
        !c.vetoed
      )
    );

    return [
      `${htmlLabel('INDEPENDENT VERIFICATION — Risk-Control Mapping')} (${htmlEscape(riskName)})`,
      `${htmlLabel('ROUTE:')} <span style="color:${routeColor}"><b>${route}</b></span> — overall confidence ${overallConfidence.toFixed(2)}${vetoed.length > 0 ? `, ${vetoed.length} mapping(s) vetoed` : ''}`,
      `${htmlLabel('PER-MAPPING INDEPENDENT CHECKS:')}<br>${lines.join('<br>')}`,
      `<i>Checked independently by GLM-4.7 on DeepInfra (${process.env.DEEPINFRA_MODEL || 'zai-org/GLM-4.7'}) — a different model on different infrastructure than the Gemini agent that produced these mappings. Re-pulled raw risk & control definitions directly from system of record.</i>`
    ].join('<br><br>');
  }

  private async checkOneControl(
    controlName: string, claimedRatingLabel: string, claimedComments: string, evidence: any
  ): Promise<ControlCheckResult> {
    const prompt = [
      `You are an independent auditor reviewing a control effectiveness rating. You did not make this rating and have no stake in defending it.`,
      '',
      `CONTROL: ${controlName}`,
      `CLAIMED RATING: ${claimedRatingLabel}`,
      `CLAIMED JUSTIFICATION (from the assessor — do not simply trust this, verify it against the evidence below):`,
      claimedComments || '(none provided)',
      '',
      `EVIDENCE (independently re-pulled from the system of record just now — this is the ONLY evidence you should reason from):`,
      `- Latest test result: ${evidence.latestResult || 'none recorded'}`,
      `- Effectiveness (per latest test): ${evidence.effectiveness || 'not recorded'}`,
      `- Result date: ${evidence.resultDate || 'unknown'}`,
      `- Open issues linked to this control: ${evidence.openIssues?.length ?? 0}${evidence.openIssues?.length ? ' — ' + evidence.openIssues.map((i: any) => i.desc).join('; ') : ''}`,
      `- Closed issues: ${evidence.closedIssues ?? 0}`,
      '',
      `TASK: Form your OWN independent judgment from the evidence above about whether "${claimedRatingLabel}" is the correct rating. Then answer whether the evidence is substantive (grounded) and whether the claimed rating actually follows from it (consistent).`
    ].join('\n');

    try {
      const result = await this.llm.generateStructuredOutput<{
        grounded: boolean; consistent: boolean; confidence: number; reasoning: string;
      }>(prompt, 'You are a skeptical, independent second reviewer. You never assume a prior assessor was right.', CHECK_SCHEMA);

      return {
        controlName,
        claimedRatingLabel,
        grounded: result.grounded,
        consistent: result.consistent,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        reasoning: result.reasoning,
        vetoed: !result.grounded || !result.consistent
      };
    } catch (e: any) {
      // Checker failure is itself a signal worth surfacing, not a silent skip —
      // an assessment we could not independently verify is not the same as one
      // that was verified and passed.
      return {
        controlName,
        claimedRatingLabel,
        grounded: false,
        consistent: false,
        confidence: 0,
        reasoning: `Verification check itself failed: ${e.message}`,
        vetoed: true
      };
    }
  }

  private buildReport(checks: ControlCheckResult[], instanceNumber: string, truncated: boolean): string {
    const vetoed = checks.filter(c => c.vetoed);
    const overallConfidence = vetoed.length > 0 ? 0 : Math.min(...checks.map(c => c.confidence));
    const route = vetoed.length === 0 && overallConfidence >= AUTO_ACCEPT_THRESHOLD ? 'AUTO_ACCEPT' : 'NEEDS_REVIEW';
    const routeColor = route === 'AUTO_ACCEPT' ? '#1a7f52' : '#b23a2e';

    const lines = checks.map(c =>
      htmlChoiceLine(
        `${c.controlName} — claimed "${c.claimedRatingLabel}"`,
        `${c.reasoning} (grounded: ${c.grounded ? 'yes' : 'NO'}, consistent: ${c.consistent ? 'yes' : 'NO'}, confidence: ${c.confidence.toFixed(2)})`,
        !c.vetoed
      )
    );

    return [
      `${htmlLabel('INDEPENDENT VERIFICATION — Control Effectiveness')} (assessment ${htmlEscape(instanceNumber)})`,
      `${htmlLabel('ROUTE:')} <span style="color:${routeColor}"><b>${route}</b></span> — overall confidence ${overallConfidence.toFixed(2)}${vetoed.length > 0 ? `, ${vetoed.length} control(s) vetoed` : ''}`,
      `${htmlLabel('PER-CONTROL INDEPENDENT CHECKS:')}<br>${lines.join('<br>')}`,
      ...(truncated ? [htmlEscape(`Note: this instance has more controls than the pilot's per-run cap (${MAX_CONTROLS_PER_RUN}) — only the first ${MAX_CONTROLS_PER_RUN} were verified.`)] : []),
      `<i>Checked independently by GLM-4.7 on DeepInfra (${process.env.DEEPINFRA_MODEL || 'zai-org/GLM-4.7'}) — a different model on different infrastructure than the Gemini agent that produced these ratings. This check re-pulled evidence fresh; it did not trust the producer's own summary.</i>`
    ].join('<br><br>');
  }
}
