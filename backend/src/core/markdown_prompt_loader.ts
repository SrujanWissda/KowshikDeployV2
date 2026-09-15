import fs from 'fs';
import path from 'path';
import { ToolDeclaration } from '../llm/llm_client';

/**
 * MarkdownPromptLoader
 * Dynamically loads, parses, and provides agent prompts, task instructions,
 * tool schemas, and skill evaluation rubrics from `agents.md` and `skills.md`.
 * 
 * Ensures agents.ts acts purely as an execution runtime engine without
 * inline prompt templates, task instructions, or schema text.
 */
export class MarkdownPromptLoader {
  private static instance: MarkdownPromptLoader;
  private agentsMdContent: string = '';
  private skillsMdContent: string = '';
  private parsedAgentSections: Map<string, string> = new Map();
  private parsedSkillSections: Map<string, string> = new Map();

  private constructor() {
    this.loadMarkdownFiles();
  }

  public static getInstance(): MarkdownPromptLoader {
    if (!MarkdownPromptLoader.instance) {
      MarkdownPromptLoader.instance = new MarkdownPromptLoader();
    }
    return MarkdownPromptLoader.instance;
  }

  public reload(): void {
    this.loadMarkdownFiles();
  }

  private loadMarkdownFiles(): void {
    const searchDirs = [
      path.resolve(__dirname, '../../..'), // Workspace root
      path.resolve(__dirname, '../..'),    // backend parent
      path.resolve(__dirname, '..'),       // backend/src
      process.cwd()
    ];

    for (const dir of searchDirs) {
      const agentsPath = path.join(dir, 'agents.md');
      const skillsPath = path.join(dir, 'skills.md');

      if (!this.agentsMdContent && fs.existsSync(agentsPath)) {
        try {
          this.agentsMdContent = fs.readFileSync(agentsPath, 'utf-8');
        } catch (e) {
          console.warn(`[MarkdownPromptLoader] Failed reading ${agentsPath}:`, e);
        }
      }

      if (!this.skillsMdContent && fs.existsSync(skillsPath)) {
        try {
          this.skillsMdContent = fs.readFileSync(skillsPath, 'utf-8');
        } catch (e) {
          console.warn(`[MarkdownPromptLoader] Failed reading ${skillsPath}:`, e);
        }
      }

      if (this.agentsMdContent && this.skillsMdContent) break;
    }

    this.parseSections();
  }

  private parseSections(): void {
    if (this.agentsMdContent) {
      const agentHeaderRegex = /###\s+\d+\.\s+([A-Za-z0-9\s]+?)\s+\(`?([A-Za-z0-9_]+)`?\)/g;
      let match: RegExpExecArray | null;
      const agentIndices: Array<{ name: string; className: string; index: number }> = [];

      while ((match = agentHeaderRegex.exec(this.agentsMdContent)) !== null) {
        agentIndices.push({
          name: match[1].trim(),
          className: match[2].trim(),
          index: match.index
        });
      }

      for (let i = 0; i < agentIndices.length; i++) {
        const current = agentIndices[i];
        const next = agentIndices[i + 1];
        const rawSection = next
          ? this.agentsMdContent.substring(current.index, next.index)
          : this.agentsMdContent.substring(current.index);

        this.parsedAgentSections.set(current.className, rawSection.trim());
        this.parsedAgentSections.set(current.name, rawSection.trim());
      }
    }

    if (this.skillsMdContent) {
      const skillHeaderRegex = /###\s+(SKILL-\d+):\s+([A-Za-z0-9\s\-]+?)\s+\(`?([A-Za-z0-9_\-]+)`?\)/g;
      let match: RegExpExecArray | null;
      const skillIndices: Array<{ id: string; name: string; tag: string; index: number }> = [];

      while ((match = skillHeaderRegex.exec(this.skillsMdContent)) !== null) {
        skillIndices.push({
          id: match[1].trim(),
          name: match[2].trim(),
          tag: match[3].trim(),
          index: match.index
        });
      }

      for (let i = 0; i < skillIndices.length; i++) {
        const current = skillIndices[i];
        const next = skillIndices[i + 1];
        const rawSection = next
          ? this.skillsMdContent.substring(current.index, next.index)
          : this.skillsMdContent.substring(current.index);

        this.parsedSkillSections.set(current.id, rawSection.trim());
        this.parsedSkillSections.set(current.tag, rawSection.trim());
      }
    }
  }

  /**
   * Returns system prompt for the specified agent.
   */
  public getAgentSystemPrompt(agentName: string, defaultPrompt?: string): string {
    const section = this.parsedAgentSections.get(agentName);
    if (section) {
      const missionMatch = section.match(/- \*\*Mission\*\*:\s*([^\n]+)/);
      if (missionMatch && missionMatch[1]) {
        return `You are Ema, ${missionMatch[1].trim()}`;
      }
    }
    return defaultPrompt || `You are Ema, a GRC autonomous agent specialized in ${agentName}.`;
  }

  /**
   * Returns skill evaluation instructions and rubric.
   */
  public getSkillInstructions(skillId: string): string {
    const section = this.parsedSkillSections.get(skillId);
    if (section) {
      const lines = section.split('\n');
      return lines.slice(1).join('\n').trim();
    }
    return '';
  }

  // ==========================================================================
  // Control Effectiveness Prompts & Tools
  // ==========================================================================

  public getControlEffectivenessMethodology(): string {
    return this.getSkillInstructions('SKILL-01') || 'Rate control operating effectiveness based on test execution evidence and open issues.';
  }

  public getControlEffectivenessTools(choiceStr: string): ToolDeclaration[] {
    return [
      {
        name: 'get_control_details',
        description: "Get this control's own name and description.",
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_test_evidence',
        description: 'Get recorded control test evidence for this control: status, effectiveness, latest result, and open issues.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_associated_issues',
        description: 'Get open issues associated directly with this control.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_prior_assessment',
        description: 'Get rating and reasoning from the last closed assessment.',
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'submit_assessment',
        description: `Finalize assessment. Rating must be copied EXACTLY from: ${choiceStr}.`,
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
  }

  public getControlEffectivenessPrompt(params: {
    riskName: string;
    riskDesc: string;
    entityLabel: string;
    profileName: string;
    controlName: string;
    choiceStr: string;
  }): string {
    return [
      'You are assessing the OPERATING effectiveness of ONE control against a risk.',
      '',
      `RISK: ${params.riskName}`,
      `Description: ${params.riskDesc || 'N/A'}`,
      `${params.entityLabel}: ${params.profileName}`,
      `CONTROL: ${params.controlName}`,
      '',
      `Valid ratings for this control: ${params.choiceStr}`,
      '',
      'You do NOT have any evidence yet — use available tools to gather evidence before deciding.',
      '',
      this.getControlEffectivenessMethodology(),
      '',
      'When ready, call submit_assessment with final rating and justification.'
    ].join('\n');
  }

  // ==========================================================================
  // Risk-Control Mapping Prompts & Tools
  // ==========================================================================

  public getRiskControlMappingTaskInstructions(): string {
    return this.getSkillInstructions('SKILL-07') || [
      'TASK METHODOLOGY (from skills.md SKILL-07):',
      '1. Select controls that GENUINELY mitigate this specific risk.',
      '2. For EVERY control NOT selected, provide a concise rejection reason.',
      '3. Provide overall justification, gaps, and specific recommendations.'
    ].join('\n');
  }

  public getMappingToolsDeclarations(entityLabel: string): ToolDeclaration[] {
    return [
      {
        name: 'get_risk_full_description',
        description: "Get this risk's full, untruncated description.",
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_control_full_description',
        description: 'Get the full name and description for one candidate control by its index number.',
        parameters: { type: 'OBJECT', properties: { index: { type: 'INTEGER' } }, required: ['index'] }
      },
      {
        name: 'get_entity_open_issues',
        description: `Get currently open issues recorded against this ${entityLabel.toLowerCase()}.`,
        parameters: { type: 'OBJECT', properties: {} }
      }
    ];
  }

  public getMappingSubmitSchema(): any {
    return {
      type: 'OBJECT',
      properties: {
        matches: {
          type: 'ARRAY',
          description: 'Controls that SHOULD be mapped — they address this risk.',
          items: {
            type: 'OBJECT',
            properties: { index: { type: 'INTEGER' }, reason: { type: 'STRING' } },
            required: ['index', 'reason']
          }
        },
        rejected: {
          type: 'ARRAY',
          description: 'Controls that should NOT be mapped.',
          items: {
            type: 'OBJECT',
            properties: { index: { type: 'INTEGER' }, reason: { type: 'STRING' } },
            required: ['index', 'reason']
          }
        },
        overall_justification: { type: 'STRING' },
        gaps: { type: 'STRING' },
        recommendation: { type: 'STRING' }
      },
      required: ['matches', 'rejected', 'overall_justification', 'gaps']
    };
  }

  public getMappingBatchSubmitSchema(): any {
    return {
      type: 'OBJECT',
      properties: {
        matches: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { index: { type: 'INTEGER' }, reason: { type: 'STRING' } },
            required: ['index', 'reason']
          }
        },
        rejected: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { index: { type: 'INTEGER' }, reason: { type: 'STRING' } },
            required: ['index', 'reason']
          }
        }
      },
      required: ['matches', 'rejected']
    };
  }

  public getMappingBatchInitialPrompt(params: {
    riskBlock: string;
    alreadyMappedBlock: string;
    chunkIndex: number;
    chunksTotal: number;
    controlListBlock: string;
  }): string {
    return [
      params.riskBlock,
      params.alreadyMappedBlock,
      '',
      `CANDIDATE CONTROLS — batch ${params.chunkIndex} of ${params.chunksTotal}:`,
      params.controlListBlock,
      '',
      'TASK: From THIS BATCH ONLY, select controls that genuinely mitigate this risk (be selective, an empty list is valid) and give every non-selected control a rejection reason. Do NOT provide gap analysis or an overall justification here — other batches exist.',
      '',
      'Use the available tools for anything you need, then call submit_mapping with your decision for this batch.'
    ].join('\n');
  }

  public getMappingInitialPrompt(params: {
    riskBlock: string;
    alreadyMappedBlock: string;
    candidateCount: number;
    entityLabel: string;
    controlListBlock: string;
  }): string {
    return [
      params.riskBlock,
      params.alreadyMappedBlock,
      '',
      `CANDIDATE CONTROLS (${params.candidateCount} total from this ${params.entityLabel}, not yet decided):`,
      params.controlListBlock,
      '',
      this.getRiskControlMappingTaskInstructions(),
      '',
      'Use the available tools for anything you need beyond what is shown above, then call submit_mapping with your final decision.'
    ].join('\n');
  }

  // ==========================================================================
  // Inherent Assessment Agent Prompts & Tools
  // ==========================================================================

  public getInherentFactorTools(choiceStr: string, factorNameLower: string, entityLabel: string): ToolDeclaration[] {
    const tools: ToolDeclaration[] = [
      {
        name: 'get_factor_guidance',
        description: "Get this factor's own description and rating-band guidance.",
        parameters: { type: 'OBJECT', properties: {} }
      },
      {
        name: 'get_entity_issues',
        description: `Get unresolved (not Closed Complete) issues logged against this risk's ${entityLabel.toLowerCase()}. Only select and consider issues that are directly related to THIS risk.`,
        parameters: { type: 'OBJECT', properties: {} }
      }
    ];

    if (factorNameLower.includes('financial')) {
      tools.push({
        name: 'get_financial_evidence',
        description: 'Get financial risk events (expected loss, impact) directly linked to this risk.',
        parameters: { type: 'OBJECT', properties: {} }
      });
    }
    if (factorNameLower.includes('regulatory') || factorNameLower.includes('legal')) {
      tools.push({
        name: 'get_regulatory_evidence',
        description: 'Get regulatory evidence: compliance exams, GRC issues (formal findings, observations), and regulatory internet search results (SEC EDGAR, Federal Reserve, OCC) linked to this risk.',
        parameters: { type: 'OBJECT', properties: {} }
      });
    }
    if (factorNameLower.includes('customer') || factorNameLower.includes('conduct') || factorNameLower.includes('market')) {
      tools.push({
        name: 'get_customer_evidence',
        description: 'Get customer impact evidence: incidents by type, affected customer count, and active incidents directly linked to this risk.',
        parameters: { type: 'OBJECT', properties: {} }
      });
    }
    if (factorNameLower.includes('reputational') || factorNameLower.includes('reputation')) {
      tools.push({
        name: 'get_reputational_evidence',
        description: 'Get reputational evidence: external events, media mentions, sentiment analysis, and internet search results (Google News, Reddit, Bing News) linked to this risk.',
        parameters: { type: 'OBJECT', properties: {} }
      });
    }

    tools.push({
      name: 'submit_rating',
      description: `Finalize your assessment once you have gathered enough evidence. rating must be copied EXACTLY from: ${choiceStr}. relevant_issues must only include issues strictly directly linked to this risk (is_directly_linked_to_this_risk: true). If none are directly linked, set issue_relevant: false and relevant_issues: [].`,
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
    });

    return tools;
  }

  public getInherentFactorPrompt(params: {
    riskName: string;
    riskDesc: string;
    entityLabel: string;
    profileName: string;
    factorName: string;
    choiceStr: string;
  }): string {
    const methodology = this.getSkillInstructions('SKILL-02') || [
      '1. Match the risk against the factor\'s own rubric bands (from get_factor_guidance) — cite the specific band',
      '   you matched, not just the factor name in isolation.',
      `2. Judge issue relevance: In entity issues, investigate issues from the entity. In 'relevant_issues', consider ONLY issues that are strictly directly linked to THIS risk's own record (is_directly_linked_to_this_risk: true). If issues exist only on the parent entity and are not directly linked to this risk, do NOT include them in relevant_issues, set issue_relevant: false.`,
      '3. Where an issue is genuinely directly linked to this risk, weigh it by priority: Critical or High priority issues are stronger evidence toward a weaker rating than Low priority ones.',
      '4. Be honest about your basis: where no directly linked issue exists, your rating is an ESTIMATE from rubric thresholds and domain knowledge.',
      '5. CRITICAL: When submitting your rating, structure your justification with:',
      '   • WHY THIS RATING WAS CHOSEN: Cite the specific rubric band, key drivers with exact numbers.',
      '   • HOW ACCURATE & GROUNDED: State confidence level, table records evaluated.',
      '   • CONCLUSION: Concise executive synthesis.',
      '   • STYLE: Professional, audit-ready language. Do NOT mention internal tool/function names.'
    ].join('\n');

    return [
      'You are assessing an INHERENT RISK FACTOR — the level of risk that exists before any controls are applied.',
      'Assess conservatively and specifically, like a rigorous risk manager who does not inflate ratings without',
      'factor-specific justification.',
      '',
      `RISK: ${params.riskName}`,
      `Description: ${params.riskDesc || 'No description provided.'}`,
      `${params.entityLabel}: ${params.profileName}`,
      `FACTOR TO ASSESS: ${params.factorName}`,
      '',
      `Valid ratings for this factor (you must pick exactly one, copied exactly): ${params.choiceStr}`,
      '',
      'You do NOT have the factor\'s rubric or the issue list yet — use the available tools to gather whatever you',
      'judge necessary before deciding. Call as many or as few as you need.',
      '',
      'Apply this methodology once you have evidence:',
      methodology,
      '',
      'When you have enough evidence, call submit_rating with your final rating; issue_relevant (true only if a',
      'specific issue genuinely influenced THIS factor); relevant_issues (the exact issue description text for each',
      'issue that applied, empty array otherwise); issue_note (one short phrase, under 15 words, on why issues were',
      'or weren\'t relevant); and justification (must include the structured WHY, HOW ACCURATE, and CONCLUSION sections).'
    ].join('\n');
  }

  public getInherentFactorSystemPrompt(): string {
    return this.getAgentSystemPrompt(
      'InherentAssessmentAgent',
      'You are Ema, an inherent risk factor evaluator. You investigate before you conclude: gather the rubric and issue context via the available tools, then submit exactly one final rating.'
    );
  }

  public getInherentCritiquePrompt(blocks: string): string {
    return [
      this.getCritiqueInstructions('InherentAssessmentAgent'),
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
  }

  public getInherentJustificationSynthesisPrompt(lines: string, calcBlock: string): string {
    return [
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
  }

  // ==========================================================================
  // Critique Prompts
  // ==========================================================================

  public getCritiqueInstructions(agentName: string): string {
    return [
      `You are Ema, acting as an independent second reviewer of draft ${agentName} ratings (skills.md SKILL-05).`,
      'Check whether each draft rating genuinely follows from the evidence shown.',
      'If supported, respond action="confirm". If not supported or out-of-scale, respond action="revise" with the corrected rating and note.'
    ].join('\n');
  }
}

export const promptLoader = MarkdownPromptLoader.getInstance();
