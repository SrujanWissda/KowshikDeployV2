import { Risk, Control, TestEvidence, AssessmentInstance, Factor, FactorResponse } from '../core/models';
import { FieldMetadata, PlatformTerminology, FieldRelationship } from '../core/generated_adapter_config';

export abstract class BaseGRCAdapter {
  // Metadata
  abstract getEntityLabel(): string;
  abstract getPlatformName(): string;

  // Field metadata (discovered during schema discovery, used for smart formatting)
  getFieldMetadata(): FieldMetadata[] | undefined { return undefined; }
  getTerminology(): PlatformTerminology | undefined { return undefined; }
  getFieldRelationships(): FieldRelationship[] | undefined { return undefined; }

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
  
  // Write Operations — each returns whether the write was VERIFIED (read back
  // and confirmed the critical field(s) actually landed), not just that the
  // HTTP call didn't throw. ServiceNow has been observed returning 200/201
  // while silently dropping a field's value on certain tables — a plain
  // "didn't throw" check missed that. Adapters with no evidence of this
  // failure mode may simply return true after a successful write.
  abstract writeControlEffectiveness(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    evidenceSummary: string,
    auditTrail: string,
    fingerprint: string
  ): Promise<boolean>;

  abstract writeInherentFactor(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    comment: string,
    auditTrail: string
  ): Promise<boolean>;

  abstract writeRiskControlMapping(
    riskSysId: string,
    matchedControls: Array<{ sysId: string; reason: string }>,
    justification: string,
    gaps: string,
    recommendations: string
  ): Promise<boolean>;

  abstract writeFailure(rowSysId: string, reason: string): Promise<void>;
}
