import { AgnosticModelName } from './concept_catalog';

// ============================================================================
// Gold-Standard Platform Catalog
//
// Knowledge extracted from the two HAND-WRITTEN, production-verified adapters
// (servicenow.ts and salesforce.ts). Each entry captures not just the table
// name but its PURPOSE — what the table is used for in the assessment
// workflow. These purpose texts are embedded and become the semantic search
// targets when discovering objects on a brand-new platform: a candidate
// object is shortlisted because its meaning matches a known table's *use*,
// not because its name shares a keyword.
// ============================================================================

export interface GoldStandardTable {
  platform: 'servicenow' | 'salesforce';
  sourceTableName: string;
  targetAgnosticModel: AgnosticModelName;
  purpose: string;
  keyFields: Record<string, string>; // sourceField -> agnosticField
  relationships: Record<string, string>; // relationName -> sourceField
}

export const GOLD_STANDARD_TABLES: GoldStandardTable[] = [
  // --------------------------------------------------------------------------
  // ServiceNow GRC (from servicenow.ts — Table API queries)
  // --------------------------------------------------------------------------
  {
    platform: 'servicenow',
    sourceTableName: 'sn_risk_risk',
    targetAgnosticModel: 'Risk',
    purpose: 'Enterprise risk register. One row per identified business risk with its narrative description and a link to the owning entity profile. Used as the root record that assessments and control mappings hang off.',
    keyFields: { sys_id: 'sysId', name: 'name', description: 'description', profile: 'profileSysId' },
    relationships: { profile: 'profile' }
  },
  {
    platform: 'servicenow',
    sourceTableName: 'sn_compliance_control',
    targetAgnosticModel: 'Control',
    purpose: 'Controls library. One row per mitigating control or safeguard with description, category and active flag, scoped to an entity profile. Queried to build the candidate list when mapping controls to a risk.',
    keyFields: { sys_id: 'sysId', name: 'name', description: 'description', category: 'category', active: 'active', profile: 'profileSysId' },
    relationships: { profile: 'profile' }
  },
  {
    platform: 'servicenow',
    sourceTableName: 'sn_risk_advanced_risk_assessment_instance',
    targetAgnosticModel: 'AssessmentInstance',
    purpose: 'Risk assessment header record. One row per assessment run of a specific risk, tracking its lifecycle state (inherent assessment, control assessment, residual, closed). The parent that factor response rows belong to. Used to find the current assessment and prior closed assessments of the same risk.',
    keyFields: { sys_id: 'sysId', risk: 'riskSysId' },
    relationships: { risk: 'risk' }
  },
  {
    platform: 'servicenow',
    sourceTableName: 'sn_risk_advanced_risk_assessment_instance_response',
    targetAgnosticModel: 'Factor',
    purpose: 'Individual answer rows within an assessment instance. One row per factor to score — either linked to a specific control (control-effectiveness answers) or standalone (inherent factor answers). This is the table AI assessment results are written back into: score, rating comments and audit trail.',
    keyFields: { sys_id: 'sysId', factor: 'factorSysId', control: 'controlSysId', factor_response: 'score', additional_comments: 'justification' },
    relationships: { assessment: 'assessment_instance_id', control: 'control', factor: 'factor' }
  },
  {
    platform: 'servicenow',
    sourceTableName: 'sn_risk_advanced_factor',
    targetAgnosticModel: 'Factor',
    purpose: 'Factor definitions: what each rating dimension measures (data sensitivity, threat exposure, control effectiveness) plus the guidance rubric text an assessor follows when scoring it.',
    keyFields: { sys_id: 'sysId', name: 'factorName', description: 'factorDesc', guidance: 'guidance' },
    relationships: {}
  },
  {
    platform: 'servicenow',
    sourceTableName: 'sn_risk_advanced_factor_choice',
    targetAgnosticModel: 'Factor',
    purpose: 'Rating scale options for a factor: the valid choice labels (High/Medium/Low, Satisfactory/Weak) and the numeric score each maps to. Joined to factor definitions to build the answerable scale.',
    keyFields: { factor: 'factorSysId', display_value: 'choiceLabel', score: 'choiceScore' },
    relationships: { factor: 'factor' }
  },
  {
    platform: 'servicenow',
    sourceTableName: 'sn_audit_control_test',
    targetAgnosticModel: 'TestEvidence',
    purpose: 'Control test executions. One row per audit test run against a control, holding workflow state, pass/fail status and the effectiveness verdict. Primary evidence source when judging whether a control actually works.',
    keyFields: { sys_id: 'sysId', number: 'number', short_description: 'name', state: 'state', control_effectiveness: 'effectiveness', status: 'status' },
    relationships: { control: 'control' }
  },
  {
    platform: 'servicenow',
    sourceTableName: 'sn_audit_test_result',
    targetAgnosticModel: 'TestEvidence',
    purpose: 'Detailed result notes for a control test: free-text outcome narrative and the testing date. Joined to the test record to enrich evidence with what was actually observed.',
    keyFields: { u_control_test: 'testSysId', u_test_result: 'latestResult', u_testing_date: 'resultDate' },
    relationships: { test: 'u_control_test' }
  },
  {
    platform: 'servicenow',
    sourceTableName: 'sn_grc_issue',
    targetAgnosticModel: 'Issue',
    purpose: 'Findings and remediation issues raised against controls, tests, risks or entities, tracked by workflow state until Closed Complete. Open issues degrade control-effectiveness ratings and inform inherent risk scoring.',
    keyFields: { sys_id: 'sysId', number: 'number', short_description: 'desc', state: 'state' },
    relationships: { parent: 'parent', item: 'item', profile: 'profile' }
  },
  {
    platform: 'servicenow',
    sourceTableName: 'sn_risk_m2m_risk_control',
    targetAgnosticModel: 'Control',
    purpose: 'Many-to-many junction linking risks to their mitigating controls. Rows are inserted here when the mapping agent decides a control addresses a risk.',
    keyFields: { sn_risk_risk: 'riskSysId', sn_compliance_control: 'controlSysId' },
    relationships: { risk: 'sn_risk_risk', control: 'sn_compliance_control' }
  },

  // --------------------------------------------------------------------------
  // Salesforce GRC (from salesforce.ts — SOQL queries)
  // --------------------------------------------------------------------------
  {
    platform: 'salesforce',
    sourceTableName: 'grc__Risk__c',
    targetAgnosticModel: 'Risk',
    purpose: 'Enterprise risk register object. One record per identified business risk, linked to a responsible business unit. Root object that risk assessments are created against.',
    keyFields: { Id: 'sysId', Name: 'name', grc__Description__c: 'description', grc__Business_Unit__c: 'profileSysId' },
    relationships: { profile: 'grc__Business_Unit__c' }
  },
  {
    platform: 'salesforce',
    sourceTableName: 'grc__Control__c',
    targetAgnosticModel: 'Control',
    purpose: 'Controls library object holding each mitigating control with description, category and implementation status, owned by a business unit. Queried as the candidate pool for risk-control mapping.',
    keyFields: { Id: 'sysId', Name: 'name', grc__Description__c: 'description', grc__Category__c: 'category', grc__Status__c: 'active', grc__Business_Unit__c: 'profileSysId' },
    relationships: { profile: 'grc__Business_Unit__c' }
  },
  {
    platform: 'salesforce',
    sourceTableName: 'Risk__Risk_Assessment__c',
    targetAgnosticModel: 'AssessmentInstance',
    purpose: 'Risk assessment header record. One row per assessment run of a specific risk with its assessment date. Parent of the inherent rating rows and the anchor for finding prior assessments of the same risk. Used by the inherent-assessment stage.',
    keyFields: { Id: 'sysId', Risk__Risk__c: 'riskSysId', Risk__Risk_Assessment_Date__c: 'assessmentDate' },
    relationships: { risk: 'Risk__Risk__c' }
  },
  {
    platform: 'salesforce',
    sourceTableName: 'Risk__Risk_Assessment_Rating__c',
    targetAgnosticModel: 'Factor',
    purpose: 'Inherent rating rows under an assessment: one row per scored dimension (Likelihood, Impact) with band, numeric value range and justification. This is where inherent-assessment AI results are written back.',
    keyFields: { Id: 'sysId', Risk__Category__c: 'factorName', Risk__Band__c: 'band', Risk__Value__c: 'score', Risk__Justification__c: 'justification' },
    relationships: { assessment: 'Risk__Risk_Assessment__c' }
  },
  {
    platform: 'salesforce',
    sourceTableName: 'Risk__Control_Assessment__c',
    targetAgnosticModel: 'Factor',
    purpose: 'Control-effectiveness answer rows: one row per control being scored within a risk context, holding the effectiveness rating, numeric value and justification. This is where control-effectiveness AI results are written back. Used by the control-assessment stage.',
    keyFields: { Id: 'sysId', Risk__Control_Effectiveness__c: 'rating', Risk__Control_Effectiveness_Value__c: 'score', Risk__Justification__c: 'justification' },
    relationships: { control: 'Risk__Risk_Control_Lookup__c' }
  },
  {
    platform: 'salesforce',
    sourceTableName: 'Risk__Risk_Control_Lookup__c',
    targetAgnosticModel: 'Control',
    purpose: 'Junction object linking a risk to a mitigating control, with the mapping justification. Rows are created here when the mapping agent selects controls for a risk.',
    keyFields: { Id: 'sysId', Risk__Risk__c: 'riskSysId', Risk__Control__c: 'controlSysId' },
    relationships: { risk: 'Risk__Risk__c', control: 'Risk__Control__c' }
  },
  {
    platform: 'salesforce',
    sourceTableName: 'grc__Control_Test_Result__c',
    targetAgnosticModel: 'TestEvidence',
    purpose: 'Control test result records: pass/fail outcome, date of test and tester comments for a control test. Latest row per control is the primary evidence when judging control effectiveness.',
    keyFields: { Id: 'sysId', Name: 'number', grc__Result__c: 'status', grc__Date_Of_Test__c: 'resultDate', Testing_Comments__c: 'latestResult' },
    relationships: { control: 'grc__Control_Test__c' }
  },
  {
    platform: 'salesforce',
    sourceTableName: 'grc__Issue__c',
    targetAgnosticModel: 'Issue',
    purpose: 'Findings and remediation issues raised against a business unit, tracked by status until closed. Open issues inform inherent risk scoring for that unit.',
    keyFields: { Id: 'sysId', grc__ID__c: 'number', grc__Description__c: 'desc', grc__Status__c: 'state' },
    relationships: { profile: 'grc__Responsible_Business_Unit__c' }
  }
];

/** Text embedded for purpose-based semantic matching of a gold-standard table. */
export function goldStandardEmbeddingText(t: GoldStandardTable): string {
  return `${t.targetAgnosticModel} table "${t.sourceTableName}": ${t.purpose}`;
}
