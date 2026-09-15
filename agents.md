# GRC Agent Architecture Specification (`agents.md`)

This document defines the canonical specification, execution lifecycle, input/output contracts, tool loops, and orchestration for all autonomous agents in the GRC platform.

---

## 🏛️ Foundational Schema: Wissda Foundational Element Model (FEM v1.2)

All agents, data ingestion adapters, schema discovery mechanisms, and cross-platform integrations MUST adhere to the **Wissda Foundational Element Model (FEM v1.2)**.

### 1. Topology & Traversal Rules

```text
                  PRODUCT
                     |
                     | delivered_by (FEM-C-016)
                     v
REGULATION        PROCESS
    |                |
    | decomposes_to  | exposed_to
    v                v
OBLIGATION --raises-> RISK <--- governs --- POLICY (FEM-C-003)
    |                |    |
    | addressed_by   |    +---- implemented_by (optional) ----+
    |                v                                        |
    +-----------> CONTROL <-----------------------------------+
```

#### The Five Valid Traversal Chains
| Chain | Path | Purpose |
|-------|------|---------|
| **`PPRC`** | `product → process → risk → control` | The **only** route from a product to a control. |
| **`PRC`** | `process → risk → control` | The **only** route from a process to a control. |
| **`ROC`** | `regulation → obligation → control` | Regulatory coverage operationalization. |
| **`ROP`** | `regulation → obligation → policy` | Policy coverage and alignment. |
| **`PRR`** | `policy → risk (+ optional policy → control)` | Policy sets the risk appetite/position. |

#### Forbidden by Construction (Schema Invariants)
The schema outright rejects direct relationships between these pairs:
- ❌ `process → control` (Coverage of a process by a control is **never asserted directly**; it is derived by traversing `process → risk → control`).
- ❌ `regulation → control` (Must traverse `regulation → obligation → control`).
- ❌ `regulation → policy` (Must traverse `regulation → obligation → policy`).
- ❌ `regulation → risk` (`obligation_raises_risk` is the bridge that brings regulatory exposure into the risk register).
- ❌ `process → obligation`
- ❌ `product → control`, `product → risk`, `product → obligation`, `product → regulation` (`Product` is a scoping element, not a risk-bearing one; it connects only via `delivered_by → process`).

---

### 2. Scoping and Assessment Layer
- **Entity Tagging**: Every `process`, `risk`, `control`, and `product` belongs to an `ENTITY`. Each entity is tagged to at least one `business_unit` and/or `legal_entity` (`FEM-C-014`).
- **Assessment Unit**: Risk is scored at the `ASSESSMENT UNIT` (`FEM-C-013`), which comprises 1..N `business_unit(s)` (`FEM-C-015`). Risk scores are never stored as flat isolated fields without an assessment unit context.
- **Identifier Conventions**: `ENT-`, `ASU-`, `PRD-`, `PRC-`, `RSK-`, `CTL-`, `REG-`, `OBL-`, `POL-`, `REL-`.
- **M2M Relationship Tables**: Risk-to-issue linkage is modeled exclusively via a **many-to-many (M2M) join table** — there are no direct reference fields on the issue record pointing to risks. Entity-to-issue linkage uses a separate M2M join table mapping entities/profiles to issues. Agents must resolve issue relationships through these join tables, never by assuming direct foreign-key fields on issue records.

---

## Agent Registry & Overview

| Agent Name | Primary Responsibility | Input Contract | Target Writeback / Output | Mapped Skills (`skills.md`) | FEM Alignment |
|------------|------------------------|----------------|---------------------------|-----------------------------|---------------|
| **`ControlEffectivenessAgent`** | Evaluates operating effectiveness of controls against linked risks | `instanceSysId: string` | Assessment Response Record, Audit Trail Rationale | `SKILL-01`, `SKILL-05`, `SKILL-06`, `SKILL-12` | Evaluates `CTL-` mitigating `RSK-` |
| **`InherentAssessmentAgent`** | Multi-factor inherent risk scoring (Financial, Regulatory, Customer Conduct, Reputational) | `instanceSysId: string` | Assessment Response Record, Audit Trail Rationale | `SKILL-02`, `SKILL-03`, `SKILL-04`, `SKILL-05`, `SKILL-06`, `SKILL-12` | Evaluates `RSK-` in `ASU-` |
| **`RiskControlMappingAgent`** | Semantic gap analysis & automated control recommendation | `riskSysId: string`, `candidateControlSysIds?: string[]` | Risk-Control Join Table, AI Recommendation Field | `SKILL-07`, `SKILL-05`, `SKILL-12` | Validates `RSK- -> CTL-` (PRC chain) |
| **`IssueIdentificationAgent`** | GRC issue clustering, root cause extraction, and repeat finding discovery | `riskSysId: string` or `profileSysId: string` | Issue Register, Executive Issue Summary Field | `SKILL-04`, `SKILL-07`, `SKILL-12` | Links findings to `CTL-` & `RSK-` |
| **`AuthorityDocumentCitationAgent`** | FEM-RD-01 to FEM-RD-10 regulatory decomposition & single-duty obligation extraction | `authorityDocumentSysId: string` or `rawText: string` | Obligation/Citation Register, Policy Statement Register | `SKILL-08`, `SKILL-05`, `SKILL-12` | `REG- -> OBL-` decomposition |
| **`CitationRiskMappingAgent`** | FEM-OC-01 to FEM-OC-03 citation-to-risk matching, gap identification, and draft risk generation | `citationSysId: string` | Risk Register, Citation-Risk Join Table | `SKILL-09`, `SKILL-07`, `SKILL-12` | `OBL- --raises--> RSK-` bridge |
| **`UniversalSchemaDiscoveryAgent`** | 4-stage introspection, cosine vector ranking, and automated adapter configuration | `connectionConfig: ConnectionConfig` | `GeneratedAdapterConfig` JSON file | `SKILL-10`, `SKILL-04` | Discovers & maps FEM entities |
| **`VerificationAgent`** | Independent dual-model cross-validation with weakest-link & hard-veto rules | `instanceSysId: string` | Verification Output Field on Audit Trail Record | `SKILL-11`, `SKILL-01`, `SKILL-12` | Re-verifies `CTL-` & `RSK-` evidence |

---

## Detailed Agent Specifications

### 1. Control Effectiveness Agent (`ControlEffectivenessAgent`)
- **Mission**: Evaluate the operational performance of mitigating controls linked to an active risk assessment instance.
- **Workflow**:
  1. **Fingerprint Verification**: Read control test results and open issues. Check if identical evidence was evaluated in a prior closed assessment. If match found, carry forward with audit stamp (`SKILL-06`).
  2. **Fast-Track Check**: If zero tests, zero issues, and no prior assessment exist, immediately assign the weakest valid rating (`SKILL-06`).
  3. **Tool-Calling Investigation Loop**:
     - `get_control_details`: Fetch control name and operational scope.
     - `get_test_evidence`: Retrieve test results, status, effectiveness, and test-level open issues.
     - `get_associated_issues`: Retrieve unclosed issues associated directly with the control.
     - `get_prior_assessment`: Retrieve historic score and rationale for delta analysis.
     - `submit_assessment`: Finalize rating from exact choice map with evidence justification.
  4. **Self-Critique Reflection Pass** (`SKILL-05`): Batch critique of all rated controls. Revises ratings that contradict open issues or test findings.
  5. **Instance-Level Narrative Synthesis**: Generates `control_justification` and `residual_justification` aligning with authoritative platform scores.
  6. **Write-Back & Observability** (`SKILL-12`): Two-attempt verified write, HTML audit trail logging.

---

### 2. Inherent Assessment Agent (`InherentAssessmentAgent`)
- **Mission**: Determine gross risk exposure across four orthogonal dimensions before applying mitigating controls.
- **Factor Dimensions**:
  - **Financial**: Direct loss event queries (loss events dataset), expected loss threshold evaluation.
  - **Regulatory**: Internal audit/exam findings and open issue records + live external regulatory search (`SKILL-03` SEC EDGAR, Fed, OCC).
  - **Customer Conduct**: Semantic LLM filtering of operational incident data (`SKILL-04`).
  - **Reputational**: Internal/external loss and event databases + news & community sentiment analysis (`SKILL-03` Google News, Reddit, Bing).
- **Issue Linkage Resolution**:
  - Issues linked to entities are queried exclusively via the entity-issue M2M join table.
  - Issues linked to risks are queried exclusively via the risk-issue M2M join table.
  - Direct reference fields on issue records pointing to risks are prohibited.
- **Triangulation Methodology** (`SKILL-02`):
  - Convergence detection (3+ factor agreement).
  - High-water mark rule for severe outliers.
  - Reflection critique pass before final score commitment.

---

### 3. Risk-Control Mapping Agent (`RiskControlMappingAgent`)
- **Mission**: Identify mitigating controls for unmitigated risks, detect coverage gaps, and recommend optimal controls from the compliance library.
- **Workflow**:
  1. Retrieve risk description, category, and owning entity profile.
  2. Perform vector-based semantic search across active control library.
  3. Evaluate candidate controls against risk requirements:
     - Match rationale and control adequacy score.
     - Rejection rationale for non-mitigating controls.
     - Identification of residual coverage gaps.
  4. Write verified mappings to relationship tables and log recommendation summaries.

---

### 4. Issue Identification Agent (`IssueIdentificationAgent`)
- **Mission**: Mine GRC issues and audit findings to surface repeat failure patterns, overdue remediation, and systemic root causes.
- **Workflow**:
  1. Ingest all open and recently closed issues linked to the target entity (via entity-issue M2M join) or risk (via risk-issue M2M join).
  2. Cluster issues by underlying root cause (e.g., process deficiency, inadequate staffing, system vulnerability).
  3. Generate executive issue summaries for audit committees.

---

### 5. Authority Document Citation Agent (`AuthorityDocumentCitationAgent`)
- **Mission**: Decompose dense regulatory authority documents into granular, single-duty enforceable compliance obligations (FEM-RD-01 to FEM-RD-10).
- **Workflow**:
  1. Parse source regulatory text into hierarchical sections.
  2. Classify text segments into Enforceable Duties vs Non-Duty Commentary (definitions, scope preambles).
  3. Extract single-duty statements with citation reference paths.
  4. Perform duplicate detection against existing citation library.
  5. Formulate change delta (added, amended, withdrawn, unchanged).

---

### 6. Citation-to-Risk Mapping Agent (`CitationRiskMappingAgent`)
- **Mission**: Map compliance obligations to organizational risk registers while maintaining strict gap fidelity (FEM-OC-01 to FEM-OC-03).
- **Workflow**:
  1. Ingest decomposed citation obligation.
  2. Search risk register for potential matching risks.
  3. Score candidates with explicit `is_adequate_match` flags (never force false-positive matches).
  4. If no adequate risk exists, draft new risk proposals with full gap rationale.

---

### 7. Universal Schema Discovery Agent (`UniversalSchemaDiscoveryAgent`)
- **Mission**: Automatically discover, classify, and configure GRC schema adapters on any external platform (e.g., Salesforce, ServiceNow, custom databases).
- **Workflow**:
  1. **Introspection**: Read raw metadata, tables, and fields via connector describe APIs.
  2. **Vector Shortlist**: Cosine similarity matching against Agnostic Concept Catalog (`SKILL-10`).
  3. **LLM Confirmation**: Deep semantic evaluation to select primary table keys and field mappings based on FEM schema rules.
  4. **Sample Data Validation**: Query live sample records to verify non-null rates and data types.
  5. **Config Generation**: Export validated `GeneratedAdapterConfig`.

---

### 8. Verification & Accountability Agent (`VerificationAgent`)
- **Mission**: Provide independent, second-opinion verification of producer agent outputs using an isolated secondary LLM (Groq / Llama-3).
- **Core Principles** (`SKILL-11`):
  - **Producer Isolation**: Never trust producer justifications; re-pull raw evidence fresh from the data layer.
  - **Independent Model**: Uses Groq LLM to eliminate model-family bias from Gemini producer passes.
  - **Weakest-Link & Hard Veto**: A single inconsistent or ungrounded claim triggers an audit flag.
