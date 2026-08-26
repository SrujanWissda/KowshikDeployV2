import { z } from 'zod';

// Agnostic Risk Model
export const RiskSchema = z.object({
  sysId: z.string(),
  name: z.string(),
  description: z.string().default(''),
  profileSysId: z.string().optional(),
  profileName: z.string().default('Unknown entity')
});
export type Risk = z.infer<typeof RiskSchema>;

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
