import { Risk, Control, TestEvidence, AssessmentInstance, Factor, FactorResponse } from '../core/models';

export abstract class BaseGRCAdapter {
  // Metadata
  abstract getEntityLabel(): string;
  abstract getPlatformName(): string;

  // Read Operations
  abstract getEntityIssues(profileSysId: string): Promise<Array<{ desc: string; state: string; number?: string; priority?: string }>>;
  abstract getRisk(riskSysId: string): Promise<Risk | null>;
  abstract getControlsForEntity(profileSysId: string): Promise<Control[]>;
  abstract getAssessmentInstance(instanceSysId: string): Promise<AssessmentInstance | null>;

  // Assessment and Factor Operations
  abstract getControlFactorRows(instanceSysId: string): Promise<FactorResponse[]>;
  abstract getAnswerableManualRows(instanceSysId: string): Promise<Factor[]>;
  abstract getFactorChoices(factorSysId: string): Promise<Factor | null>;
  abstract getControlEvidence(controlSysId: string): Promise<TestEvidence>;

  // Prior Assessment Retrieval
  abstract getPriorClosedAssessment(riskSysId: string, currentInstanceSysId: string): Promise<{ sysId: string; number: string } | null>;
  abstract getPriorControlAnswer(priorInstanceSysId: string, controlSysId: string, factorSysId: string): Promise<{
    factorResponse: string | null;
    qualativeResponse: number | null;
    comments: string;
    fingerprint: string | null;
    ratingLabel: string;
  } | null>;

  // Write Operations
  abstract writeControlEffectiveness(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    evidenceSummary: string,
    auditTrail: string,
    fingerprint: string
  ): Promise<void>;

  abstract writeInherentFactor(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    comment: string,
    auditTrail: string
  ): Promise<void>;

  abstract writeRiskControlMapping(
    riskSysId: string,
    matchedControls: Array<{ sysId: string; reason: string }>,
    justification: string,
    gaps: string,
    recommendations: string
  ): Promise<void>;

  abstract writeFailure(rowSysId: string, reason: string): Promise<void>;
}
