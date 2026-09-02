import { z } from 'zod';

// Agnostic Risk Model
export const RiskSchema = z.object({
  sysId: z.string(),
  name: z.string(),
  description: z.string().default(''),
  profileSysId: z.string().optional(),
  profileName: z.string().default('Unknown entity'),
  citations: z.string().optional(),
  u_citations: z.string().optional()
});
export type Risk = z.infer<typeof RiskSchema>;

// Agnostic Entity / Process Model (sn_grc_profile / Account / Business Unit)
export const EntitySchema = z.object({
  sysId: z.string(),
  name: z.string(),
  type: z.string().default('Business Process'),
  description: z.string().default('')
});
export type Entity = z.infer<typeof EntitySchema>;

// Agnostic Control Model
export const ControlSchema = z.object({
  sysId: z.string(),
  name: z.string(),
  description: z.string().default(''),
  category: z.string().default('General'),
  profileSysId: z.string().optional(),
  active: z.boolean().default(true)
});
export type Control = z.infer<typeof ControlSchema>;

// Agnostic GRC Issue Model
export const IssueSchema = z.object({
  sysId: z.string(),
  number: z.string(),
  desc: z.string(),
  state: z.string(),
  priority: z.string().optional()
});
export type Issue = z.infer<typeof IssueSchema>;

// Agnostic Control Test Evidence Model
export const TestEvidenceSchema = z.object({
  sysId: z.string(),
  number: z.string(),
  name: z.string(),
  state: z.string(),
  effectiveness: z.string().optional(),
  status: z.string().optional(),
  latestResult: z.string().optional(),
  resultDate: z.string().optional(),
  openIssues: z.array(IssueSchema).default([]),
  closedIssues: z.number().default(0)
});
export type TestEvidence = z.infer<typeof TestEvidenceSchema>;

// Agnostic Assessment Instance Model
export const AssessmentInstanceSchema = z.object({
  sysId: z.string(),
  riskSysId: z.string(),
  number: z.string().optional()
});
export type AssessmentInstance = z.infer<typeof AssessmentInstanceSchema>;

// Factor (inherent or question-based factor assessment row)
export const FactorSchema = z.object({
  sysId: z.string(),
  factorSysId: z.string(),
  factorName: z.string(),
  factorDesc: z.string().default(''),
  guidance: z.string().default(''),
  choiceList: z.array(z.string()),
  choiceMap: z.record(z.string(), z.number()) // maps label -> numeric score
});
export type Factor = z.infer<typeof FactorSchema>;

// Factor Response Row (linked to control or standalone)
export const FactorResponseSchema = z.object({
  sysId: z.string(),
  factorSysId: z.string(),
  factorName: z.string(),
  controlSysId: z.string().optional(),
  controlName: z.string().optional()
});
export type FactorResponse = z.infer<typeof FactorResponseSchema>;

// --- Agent Result Schemas ---

// Inherent Assessment Agent Response
export const InherentAssessmentResultSchema = z.object({
  rating: z.string(),
  issue_relevant: z.boolean(),
  justification: z.string()
});
export type InherentAssessmentResult = z.infer<typeof InherentAssessmentResultSchema>;

// Control Effectiveness Agent Response (Batch Item)
export const ControlEffectivenessResultSchema = z.object({
  index: z.number(),
  rating: z.string(),
  justification: z.string()
});
export type ControlEffectivenessResult = z.infer<typeof ControlEffectivenessResultSchema>;

// Risk-Control Mapping Agent Response
export const MappingResultSchema = z.object({
  match: z.boolean(),
  matches: z.array(z.object({
    index: z.number(),
    reason: z.string()
  })).default([]),
  rejected: z.array(z.object({
    index: z.number(),
    reason: z.string()
  })).default([]),
  overall_justification: z.string(),
  gaps: z.string(),
  recommendation: z.string().optional()
});
export type MappingResult = z.infer<typeof MappingResultSchema>;

// Schema Onboarding & Mapping Configuration Result
export const SchemaDiscoveryResultSchema = z.object({
  platformName: z.string(),
  tables: z.array(z.object({
    sourceTableName: z.string(),
    description: z.string(),
    targetAgnosticModel: z.enum(['Risk', 'Control', 'TestEvidence', 'Issue', 'AssessmentInstance', 'Factor']),
    fieldMappings: z.array(z.object({
      sourceField: z.string(),
      sourceType: z.string(),
      targetField: z.string(),
      rationale: z.string()
    }))
  }))
});
export type SchemaDiscoveryResult = z.infer<typeof SchemaDiscoveryResultSchema>;

// Citation to Risk Mapping Candidate Evaluation (FEM-OC-01, FEM-OC-02, FEM-OC-03)
export const CitationRiskCandidateSchema = z.object({
  risk_index: z.number(),
  risk_name: z.string(),
  entity_name: z.string(),
  confidence_score: z.number(), // 0.0 - 1.0
  is_adequate_match: z.boolean(), // FEM-OC-02: explicit flag, never force match
  rationale: z.string()
});
export type CitationRiskCandidate = z.infer<typeof CitationRiskCandidateSchema>;

// Citation to Risk Mapping Agent Structured Response
export const CitationRiskMappingResultSchema = z.object({
  ranked_candidates: z.array(CitationRiskCandidateSchema).default([]),
  matched_existing_risks: z.array(z.object({
    risk_index: z.number(),
    risk_name: z.string(),
    entity_name: z.string(),
    mapping_justification: z.string()
  })).default([]),
  draft_risks_on_gap: z.array(z.object({
    entity_name: z.string(),
    profile_sys_id: z.string(),
    proposed_risk_name: z.string(),
    proposed_description: z.string(),
    gap_rationale: z.string(),
    category: z.string().default('Regulatory / Compliance')
  })).default([]),
  coverage_summary: z.string(),
  overall_analysis: z.string()
});
export type CitationRiskMappingResult = z.infer<typeof CitationRiskMappingResultSchema>;

// ============================================================================
// FEM-RD (Regulatory Decomposition) Schemas — FEM-RD-01 through FEM-RD-10
// ============================================================================

// Single-duty obligation record (FEM-RD-02, FEM-RD-03, FEM-RD-05, FEM-RD-06, FEM-RD-07)
export const DecomposedObligationSchema = z.object({
  duty: z.string(), // FEM-RD-02: Single enforceable duty statement
  citation_reference: z.string(), // FEM-RD-03: Full hierarchy path (e.g. "Part 386 > Subpart B > Section 386.11(b)")
  source_snippet: z.string().optional(), // Original verbatim passage
  proposed_name: z.string(), // Concise title for obligation record
  proposed_description: z.string(), // Enforceable duty specification
  applicability_proposal: z.enum(['in_scope', 'out_of_scope']), // FEM-RD-07
  applicability_rationale: z.string(), // FEM-RD-07 reasoning for human reviewer
  duplicate_status: z.enum(['unique', 'exact_duplicate', 'near_duplicate']).default('unique'), // FEM-RD-05, FEM-RD-09
  linked_existing_sys_id: z.string().optional(), // Sys ID if linking to existing library record
  linked_existing_name: z.string().optional(),
  change_type: z.enum(['added', 'amended', 'withdrawn', 'unchanged']).default('added'), // FEM-RD-06
  change_rationale: z.string().optional()
});
export type DecomposedObligation = z.infer<typeof DecomposedObligationSchema>;

// Non-obligation classified text (FEM-RD-04)
export const ClassifiedNonDutyTextSchema = z.object({
  category: z.enum(['definition', 'scope_statement', 'recital', 'commentary', 'administrative', 'authority_preamble']),
  section_reference: z.string(),
  text_snippet: z.string(),
  exclusion_reason: z.string() // Reason why this is not an enforceable duty
});
export type ClassifiedNonDutyText = z.infer<typeof ClassifiedNonDutyTextSchema>;

// Regulatory Decomposition Result (FEM-RD-01 to FEM-RD-10)
export const RegulatoryDecompositionResultSchema = z.object({
  authority_name: z.string(),
  authority_reference: z.string().optional(),
  scenario_executed: z.enum(['feed_reconciliation', 'manual_maintenance', 'greenfield_build']),
  is_first_pass_greenfield: z.boolean().default(false), // FEM-RD-10
  decomposed_obligations: z.array(DecomposedObligationSchema).default([]),
  classified_non_obligations: z.array(ClassifiedNonDutyTextSchema).default([]),
  delta_summary: z.object({
    added: z.number().default(0),
    amended: z.number().default(0),
    withdrawn: z.number().default(0),
    unchanged: z.number().default(0)
  }).default({ added: 0, amended: 0, withdrawn: 0, unchanged: 0 }),
  stale_obligations: z.array(z.object({
    obligation_name: z.string(),
    sys_id: z.string(),
    reason: z.string()
  })).default([]), // FEM-RD-09
  feed_divergences: z.array(z.object({
    feed_obligation: z.string(),
    issue: z.string(),
    proposed_correction: z.string()
  })).default([]), // FEM-RD-08
  coverage_and_hierarchy_summary: z.string(),
  overall_compliance_analysis: z.string()
});
export type RegulatoryDecompositionResult = z.infer<typeof RegulatoryDecompositionResultSchema>;

