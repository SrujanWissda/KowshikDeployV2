# GRC Agent Skills & Capabilities Framework (`skills.md`)

This document defines the canonical specification for all modular, reusable skills, analytical capabilities, tool implementations, and evaluation rubrics utilized across the GRC multi-agent ecosystem, fully aligned with the **Wissda Foundational Element Model (FEM v1.2)**.

---

## Skills Catalog Overview

| Skill ID | Skill Name | Associated Agents | Core Capability |
|----------|------------|-------------------|-----------------|
| **`SKILL-01`** | **Control Evidence Analysis** | `ControlEffectivenessAgent`, `VerificationAgent` | Extracts, aggregates, and weighs test execution history and open issue records against operating effectiveness criteria. |
| **`SKILL-02`** | **Multi-Factor Inherent Triangulation** | `InherentAssessmentAgent` | Triangulates 4 orthogonal risk dimensions (Financial, Regulatory, Customer Conduct, Reputational) into a unified rating. |
| **`SKILL-03`** | **Public Regulatory & Media Intelligence** | `InherentAssessmentAgent` | Real-time querying and parsing of SEC EDGAR, Federal Reserve, OCC alerts, Google News, Reddit, and Bing News APIs. |
| **`SKILL-04`** | **LLM Semantic Record Filtering** | `InherentAssessmentAgent`, `IssueIdentificationAgent`, `UniversalSchemaDiscoveryAgent` | Performs semantic relevance matching on unlinked or high-volume platform records without hardcoded schema foreign keys. |
| **`SKILL-05`** | **Two-Pass Self-Critique & Reflection** | `ControlEffectivenessAgent`, `InherentAssessmentAgent`, `AuthorityDocumentCitationAgent` | Independent secondary pass reviewing first-pass drafts against raw evidence to identify rating hallucinations or inconsistencies. |
| **`SKILL-06`** | **Fast-Track Heuristics & Fingerprinting** | `ControlEffectivenessAgent`, `InherentAssessmentAgent` | Deterministic fingerprinting to carry forward unchanged assessments and immediate weakest-rating shortcuts for zero-evidence controls. |
| **`SKILL-07`** | **Risk-to-Control Gap Analysis & Reconciliation** | `RiskControlMappingAgent`, `CitationRiskMappingAgent`, `IssueIdentificationAgent` | Evaluates mitigating coverage, scores control adequacy, flags uncovered risk facets, and drafts recommendations. |
| **`SKILL-08`** | **Regulatory Decomposition (FEM-RD)** | `AuthorityDocumentCitationAgent` | Decomposes authority documents into single enforceable duties, classifies non-duty commentary, and tracks version deltas. |
| **`SKILL-09`** | **Citation-to-Risk Mapping (FEM-OC)** | `CitationRiskMappingAgent` | Evaluates risk candidates against decomposed obligations, surfaces gaps, and drafts proposed risk register entries. |
| **`SKILL-10`** | **Schema Introspection & Vector Matching** | `UniversalSchemaDiscoveryAgent` | Embeds platform tables/fields and matches against agnostic concept catalogs using cosine similarity and write heuristics. |
| **`SKILL-11`** | **Verification Layer & Hard-Veto Rubric** | `VerificationAgent` | Independent dual-model (Groq Llama-3) cross-validation; executes fresh evidence re-pulling and hard-veto aggregation. |
| **`SKILL-12`** | **Audit Trail HTML Rendering & Observability** | All Agents | Produces structured, styled HTML audit cards and telemetry entries for compliance and regulatory review. |
| **`SKILL-13`** | **FEM Topology & Traversal Chain Validation** | `UniversalSchemaDiscoveryAgent`, `RiskControlMappingAgent`, `VerificationAgent` | Enforces the 5 canonical chains (PPRC, PRC, ROC, ROP, PRR) and blocks forbidden shortcut edges (e.g. direct process→control). |

---

## Detailed Skill Specifications

### SKILL-01: Control Evidence Analysis (`control-evidence-analysis`)
- **Inputs**: Control record, linked test results, associated open issues (resolved via risk-issue M2M join table — mapping risk/control items to open issue records).
- **Evaluation Rules**:
  1. Operating effectiveness overrides design appropriateness on paper.
  2. A passing test record with recent `resultDate` establishes high confidence.
  3. Unclosed issues represent empirical operating failure, outweighing formal passing tests.
  4. Stale test evidence (> 180 days) reduces scoring confidence.

---

### SKILL-02: Multi-Factor Inherent Triangulation (`multi-factor-triangulation`)
- **Inputs**: 4 factor assessment drafts (Financial, Regulatory, Customer Conduct, Reputational).
- **Triangulation Engine**:
  - **Convergence Rule**: If 3 or more factors share the same rating, that rating is declared the baseline inherent rating.
  - **High-Water Mark Rule**: If any factor is `Critical` or `High` with severe financial loss or regulatory enforcement, the overall rating cannot drop below that factor's severity without explicit override rationale.

---

### SKILL-03: Public Regulatory & Media Intelligence (`public-regulatory-intel`)
- **Supported Endpoints (Zero-Key Public APIs)**:
  - **SEC EDGAR**: `https://www.sec.gov/cgi-bin/browse-edgar` (enforcement filings).
  - **Federal Reserve**: `https://www.federalreserve.gov/newsevents/news` (supervisory letters & enforcement).
  - **OCC**: `https://www.occ.gov/news-issuances/alerts` (banking compliance alerts).
  - **Google News / Reddit / Bing**: Real-time sentiment and external risk mentions.
- **Resilience**: Timeout guards (2500ms max per source), best-effort fallback to internal records if network unavailable.

---

### SKILL-04: LLM Semantic Record Filtering (`semantic-llm-filtering`)
- **Methodology**:
  1. Retrieve platform records (e.g. operational incidents, open issue records — issue linkage resolved via risk-issue M2M join table for risks and entity-issue M2M join table for entities, not via direct fields on issue records).
  2. Batch records into compact JSON index blocks: `[{ index: 0, text: "..." }]`.
  3. Prompt LLM to identify relevant indices related to the risk/entity scope.
  4. Filter candidate array using returned index list.

---

### SKILL-05: Two-Pass Self-Critique & Reflection (`two-pass-self-critique`)
- **Methodology**:
  - First pass: Formulate ratings and draft justifications per item.
  - Critique pass: Review all draft blocks together against raw test evidence and open issue summaries.
  - Action options: `confirm` (maintain rating) or `revise` (update rating to exact valid scale item with correction note).

---

### SKILL-06: Fast-Track Heuristics & Fingerprinting (`fast-track-heuristics`)
- **Evidence Fingerprinting**:
  - Hash string format: `sysId||testName~state~effectiveness~latestResult~openIssues||...`
  - If fingerprint matches prior closed assessment, immediately carry forward prior score and rationale.
- **Zero-Evidence Shortcut**:
  - If `tests.length === 0 && openIssues.length === 0 && !hasPriorAssessment`: immediately assign lowest valid scale rating without burning LLM turn budget.

---

### SKILL-07: Risk-to-Control Gap Analysis (`risk-control-gap-mapping`)
- **Rubric**:
  - `Adequate Match` (Score >= 0.75): Control directly mitigates identified risk scenario.
  - `Partial Match` (0.40 <= Score < 0.75): Control addresses secondary symptoms but leaves core vulnerability unmitigated.
  - `Unmitigated Gap` (Score < 0.40): Synthesizes recommended control specification for inclusion in remediation plan.

---

### SKILL-08: Regulatory Decomposition (FEM-RD) (`regulatory-decomposition`)
- **Standards (FEM-RD-01 to FEM-RD-10)**:
  - Extract single enforceable duties (one requirement per record).
  - Include full hierarchy reference (e.g., `Part 386 > Subpart B > Section 386.11(b)`).
  - Exclude non-duty text (recitals, commentary, definitions).
  - Compute delta comparison against existing obligations (added, amended, withdrawn, unchanged).

---

### SKILL-09: Citation-to-Risk Mapping (FEM-OC) (`citation-risk-mapping`)
- **Standards (FEM-OC-01 to FEM-OC-03)**:
  - Explicitly evaluate risk candidates with confidence score (0.0 to 1.0).
  - Set `is_adequate_match = false` when existing risks do not cover the enforceable obligation.
  - Auto-generate draft risk register entries when gaps are detected.

---

### SKILL-10: Schema Introspection & Vector Matching (`schema-vector-discovery`)
- **Methodology**:
  - Connect via target platform metadata introspection APIs (e.g., describe endpoints, data dictionaries).
  - Generate text embeddings for discovered tables/fields and compare via cosine similarity against Agnostic Concept Catalog.
  - Apply write heuristics for score, justification, and fingerprint field detection.
  - Verify non-empty data via sample record checks.

---

### SKILL-11: Verification Layer & Hard-Veto Rubric (`verification-hard-veto`)
- **Execution Protocol**:
  - Re-pull raw evidence via `getControlEvidence` independent of producer.
  - Query Groq LLM (Llama-3) to evaluate `grounded` (evidence exists) and `consistent` (rating follows evidence).
  - Confidence threshold: `< 0.75` triggers human audit review; contradiction triggers hard veto.

---

### SKILL-12: Audit Trail HTML Rendering & Observability (`audit-trail-observability`)
- **Formatting Guidelines**:
  - Section headers: Bold with brand color (`#1a3d7c`).
  - Outcomes: Positive markers (`✓`, `#1a7f52`) vs Negative/Rejected markers (`✗`, `#b23a2e`).
  - Target fields: Rationale / Audit Trail Field, Telemetry Log Field, Executive Summary Field.

---

### SKILL-13: Foundational Element Topology & Chain Validation (`fem-topology-validation`)
- **Core Invariant Rules**:
  - **Five Chains Enforcement**:
    1. `PPRC`: `Product → Process → Risk → Control` (Product reaches controls strictly through delivering processes).
    2. `PRC`: `Process → Risk → Control` (Process exposure must be modeled through risks).
    3. `ROC`: `Regulation → Obligation → Control` (Regulatory operationalization).
    4. `ROP`: `Regulation → Obligation → Policy` (Policy coverage).
    5. `PRR`: `Policy → Risk (+ optional Policy → Control)` (Policy governance).
  - **Direct Edge Rejection**: Rejects any attempted shortcuts like `process → control`, `regulation → control`, or `product → risk`.
  - **Assessment Unit Enclosure**: Ensures risk ratings belong to an `Assessment Unit` (`ASU-`) comprising 1..N `Business Units` (`ENT-`), never floating on isolated risk records alone.
