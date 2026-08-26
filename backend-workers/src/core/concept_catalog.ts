// ============================================================================
// Agnostic Concept Catalog
//
// Text descriptions of the platform-agnostic GRC models (see models.ts) and
// their fields. These descriptions are embedded once and used as the
// matching target when the Universal Schema Discovery agent scans a new
// platform's tables/fields — each discovered table/field is embedded the
// same way and compared via cosine similarity to shortlist candidates
// before any LLM call is made.
// ============================================================================

export type AgnosticModelName = 'Risk' | 'Control' | 'TestEvidence' | 'Issue' | 'AssessmentInstance' | 'Factor';

export interface ConceptField {
  field: string;
  description: string;
}

export interface AgnosticConcept {
  model: AgnosticModelName;
  tableDescription: string;
  fields: ConceptField[];
}

export const CONCEPT_CATALOG: AgnosticConcept[] = [
  {
    model: 'Risk',
    tableDescription: 'A business risk register entry describing a potential threat or hazard, its narrative description, and the owning business unit or entity it applies to.',
    fields: [
      { field: 'sysId', description: 'Unique identifier / primary key of the risk record.' },
      { field: 'name', description: 'Short title or name of the risk.' },
      { field: 'description', description: 'Long-form narrative description of the risk and its potential impact.' },
      { field: 'profileSysId', description: 'Foreign key to the owning business unit, entity, department, or account this risk belongs to.' },
      { field: 'profileName', description: 'Display name of the owning business unit, entity, department, or account.' }
    ]
  },
  {
    model: 'Control',
    tableDescription: 'A mitigating control, policy, or safeguard implemented to reduce the likelihood or impact of one or more risks, belonging to a control library or catalog.',
    fields: [
      { field: 'sysId', description: 'Unique identifier / primary key of the control record.' },
      { field: 'name', description: 'Short title or name of the control.' },
      { field: 'description', description: 'Narrative description of what the control does and how it mitigates risk.' },
      { field: 'category', description: 'Category or classification of the control, e.g. Access Control, Database Security, Monitoring.' },
      { field: 'profileSysId', description: 'Foreign key to the business unit, entity, or account that owns/implements this control.' },
      { field: 'active', description: 'Boolean or status flag indicating whether the control is currently active/implemented.' }
    ]
  },
  {
    model: 'TestEvidence',
    tableDescription: 'A control test or audit run and its result, capturing whether a control was verified effective, including linked test evidence and result notes.',
    fields: [
      { field: 'sysId', description: 'Unique identifier / primary key of the control test or test result record.' },
      { field: 'number', description: 'Human-readable ticket/test number, e.g. TEST001.' },
      { field: 'name', description: 'Short description or title of the test performed.' },
      { field: 'state', description: 'Workflow state of the test, e.g. Complete, In Progress.' },
      { field: 'effectiveness', description: 'Effectiveness rating of the control as determined by this test, e.g. Effective, Ineffective.' },
      { field: 'status', description: 'Pass/fail status of the test result.' },
      { field: 'latestResult', description: 'Free-text notes describing the outcome of the most recent test.' },
      { field: 'resultDate', description: 'Date the test was performed or the result recorded.' },
      { field: 'openIssues', description: 'List of unresolved issues or findings linked to this test or control.' },
      { field: 'closedIssues', description: 'Count of resolved/closed issues linked to this test or control.' }
    ]
  },
  {
    model: 'Issue',
    tableDescription: 'An audit finding, defect, or remediation issue raised against a control, test, risk, or entity, tracked through to closure.',
    fields: [
      { field: 'sysId', description: 'Unique identifier / primary key of the issue record.' },
      { field: 'number', description: 'Human-readable issue/ticket number, e.g. ISS001.' },
      { field: 'desc', description: 'Short description of the finding or issue.' },
      { field: 'state', description: 'Workflow state of the issue, e.g. Open, In Progress, Closed Complete.' }
    ]
  },
  {
    model: 'AssessmentInstance',
    tableDescription: 'A single run/instance of a risk assessment workflow linking a specific risk to its assessment lifecycle (inherent, control, residual stages).',
    fields: [
      { field: 'sysId', description: 'Unique identifier / primary key of the assessment instance record.' },
      { field: 'riskSysId', description: 'Foreign key to the risk being assessed in this instance.' }
    ]
  },
  {
    model: 'Factor',
    tableDescription: 'A scoreable rating factor within an assessment — either an inherent risk factor (e.g. data sensitivity, likelihood, impact) or a control-effectiveness factor — with a guidance rubric and a set of scoring choices.',
    fields: [
      { field: 'sysId', description: 'Unique identifier / primary key of the factor response row within an assessment.' },
      { field: 'factorSysId', description: 'Foreign key to the factor definition / rating scale being answered.' },
      { field: 'factorName', description: 'Name of the factor, e.g. Data Sensitivity, Likelihood, Impact, Control Effectiveness.' },
      { field: 'factorDesc', description: 'Description of what this factor measures.' },
      { field: 'guidance', description: 'Rubric guidance text explaining how to select a rating for this factor.' },
      { field: 'choiceList', description: 'List of valid rating choice labels for this factor, e.g. High/Medium/Low or Satisfactory/Weak.' },
      { field: 'choiceMap', description: 'Mapping of each choice label to a numeric score.' }
    ]
  }
];

/** Flattened embedding text for a table-level concept match. */
export function conceptTableEmbeddingText(concept: AgnosticConcept): string {
  return `${concept.model}: ${concept.tableDescription}`;
}

/** Flattened embedding text for a single field-level concept match. */
export function conceptFieldEmbeddingText(concept: AgnosticConcept, field: ConceptField): string {
  return `${concept.model}.${field.field}: ${field.description}`;
}
