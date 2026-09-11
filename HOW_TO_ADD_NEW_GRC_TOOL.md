# How to Add a New GRC Tool / System (`HOW_TO_ADD_NEW_GRC_TOOL.md`)

This guide explains how to connect and run all 8 autonomous GRC agents against any new enterprise GRC tool (e.g., **RSA Archer, MetricStream, Workiva, AuditBoard, Jira GRC, or custom databases**) **without modifying any agent code**.

---

## 🧭 Overview of the Integration Architecture

Our agents are decoupled from specific platforms through:
1. **The Wissda Foundational Element Model (FEM v1.2)**: Normalized data ontology (`Risk`, `Control`, `TestEvidence`, `Issue`, `AssessmentInstance`, `Factor`).
2. **`BaseGRCAdapter` Interface**: Standard CRUD and query contract.
3. **`DynamicAdapter` & `UniversalSchemaDiscoveryAgent`**: Automated schema mapping engine.

```
┌─────────────────────────┐
│   New GRC Platform      │ (RSA Archer, Workiva, Custom SQL, REST API)
└───────────┬─────────────┘
            │
            ▼
┌─────────────────────────┐
│ Universal Schema Agent  │ (Introspects tables, embeds metadata, validates FEM chains)
└───────────┬─────────────┘
            │ Generates
            ▼
┌─────────────────────────┐
│ GeneratedAdapterConfig  │ (JSON Field & Relationship Map)
└───────────┬─────────────┘
            │ Loads into
            ▼
┌─────────────────────────┐
│     DynamicAdapter      │ (Implements BaseGRCAdapter)
└───────────┬─────────────┘
            │ Plugs directly into
            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       All 8 Autonomous GRC Agents                           │
│ (ControlEffectiveness, InherentAssessment, Verification, RiskMapping, etc.) │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## ⚡ Method 1: Automated Zero-Code Onboarding (Recommended)

Use this method when the new GRC platform has an API that allows inspecting table/object metadata.

### Step 1: Trigger Schema Discovery via API
Make a `POST` request to `/api/agents/schema-discovery` with your connection credentials:

```bash
POST /api/agents/schema-discovery
Content-Type: application/json

{
  "connectionType": "rest", // Options: "servicenow", "salesforce", "rest", "database"
  "connectionConfig": {
    "instanceUrl": "https://your-grc-instance.com/api/v1",
    "apiKey": "YOUR_API_KEY",
    "headers": {
      "Authorization": "Bearer YOUR_TOKEN"
    }
  }
}
```

### Step 2: What Happens Under the Hood
1. **Stage 1 (Introspection)**: Reads table definitions, column types, and foreign key references.
2. **Stage 2 (Vector Matching)**: Uses cosine similarity against the Agnostic Concept Catalog (`concept_catalog.ts`) to shortlist matching tables.
3. **Stage 3 (LLM Reasoning & FEM Topology Check)**:
   - Maps columns to canonical models (`models.ts`).
   - Verifies the 5 FEM v1.2 traversal chains (`PPRC`, `PRC`, `ROC`, `ROP`, `PRR`).
   - Identifies write-back fields (scores, justification narratives, change hashes).
4. **Stage 4 (Sample Validation)**: Runs non-destructive read queries to verify non-null data.
5. **Generates Config**: Automatically outputs a JSON configuration file (e.g. `configs/my_grc_config.json`).

### Step 3: Instantiate and Run Agents
```typescript
import { DynamicAdapter } from './backend/src/adapters/dynamic_adapter';
import { loadAdapterConfigFromPath } from './backend/src/core/generated_adapter_config';
import { ControlEffectivenessAgent } from './backend/src/core/agents';
import { GeminiLLMClient } from './backend/src/llm/llm_client';

// 1. Load the generated JSON config
const config = loadAdapterConfigFromPath('./configs/my_grc_config.json');

// 2. Create the dynamic adapter
const adapter = new DynamicAdapter(config);
const llm = new GeminiLLMClient(process.env.GEMINI_API_KEY);

// 3. Execute any agent
const agent = new ControlEffectivenessAgent(adapter, llm);
const result = await agent.execute('assessment_instance_sys_id_123');
console.log('Assessment Completed:', result);
```

---

## 🛠️ Method 2: Manual Code Adapter (For Custom or Legacy Protocols)

Use this method if the new platform requires custom authentication, batching protocols, or bespoke transformation logic.

### Step 1: Create `backend/src/adapters/my_custom_adapter.ts`
Extend `BaseGRCAdapter` and implement the required read/write methods:

```typescript
import { BaseGRCAdapter } from './base';
import { Risk, Control, TestEvidence, Factor, AssessmentInstance } from '../core/models';
import axios, { AxiosInstance } from 'axios';

export class MyCustomGRCAdapter extends BaseGRCAdapter {
  private client: AxiosInstance;

  constructor(instanceUrl: string, apiKey: string) {
    super();
    this.client = axios.create({
      baseURL: instanceUrl,
      headers: { 'X-API-Key': apiKey }
    });
  }

  // --- 1. Read Methods ---
  async getAssessmentInstance(instanceSysId: string): Promise<AssessmentInstance | null> {
    const res = await this.client.get(`/assessments/${instanceSysId}`);
    return {
      sysId: res.data.id,
      riskSysId: res.data.risk_id,
      number: res.data.assessment_code
    };
  }

  async getRisk(riskSysId: string): Promise<Risk | null> {
    const res = await this.client.get(`/risks/${riskSysId}`);
    return {
      sysId: res.data.id,
      name: res.data.title,
      description: res.data.narrative_desc,
      profileName: res.data.owning_business_unit_name,
      profileSysId: res.data.owning_business_unit_id
    };
  }

  async getControlEvidence(controlSysId: string): Promise<TestEvidence> {
    const testsRes = await this.client.get(`/controls/${controlSysId}/test_executions`);
    const issuesRes = await this.client.get(`/controls/${controlSysId}/open_issues`);
    
    return {
      sysId: controlSysId,
      number: `CTL-${controlSysId}`,
      name: testsRes.data.control_name,
      state: testsRes.data.latest_state,
      effectiveness: testsRes.data.effectiveness,
      latestResult: testsRes.data.result_summary,
      openIssues: issuesRes.data.map((i: any) => ({
        sysId: i.id,
        number: i.ticket_num,
        desc: i.issue_description,
        state: i.status
      })),
      closedIssues: testsRes.data.closed_issues_count || 0
    };
  }

  // --- 2. Write-Back Methods ---
  async writeControlEffectiveness(
    responseRowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    comments?: string,
    auditTrailHtml?: string,
    fingerprint?: string
  ): Promise<boolean> {
    const res = await this.client.patch(`/assessment_responses/${responseRowSysId}`, {
      score_numeric: score,
      rating: ratingLabel,
      rationale: justification,
      audit_html: auditTrailHtml,
      evidence_hash: fingerprint
    });
    return res.status >= 200 && res.status < 300;
  }
}
```

### Step 2: Register in Express API Routes (`app.ts`)
Expose endpoints for the new tool:

```typescript
// backend/src/app.ts
import { MyCustomGRCAdapter } from './adapters/my_custom_adapter';

const customAdapter = new MyCustomGRCAdapter(
  process.env.NEW_GRC_URL!,
  process.env.NEW_GRC_API_KEY!
);

app.post('/api/new-grc/control-effectiveness', async (req, res) => {
  const agent = new ControlEffectivenessAgent(customAdapter, geminiClient);
  const result = await agent.execute(req.body.instanceSysId);
  res.json(result);
});
```

---

## ✅ Integration Verification Checklist

Before deploying the new system into production, verify:

1. **FEM v1.2 Topology Compliance**:
   - [ ] Product connects **only** via `delivered_by → Process`.
   - [ ] Process exposure connects to Risks (no direct `Process → Control` shortcut).
   - [ ] Regulations decompose to Obligations before raising Risks or mitigating Controls.
   - [ ] Risks are scored within an `Assessment Unit` (`ASU-`).
2. **CRUD & Audit Verification**:
   - [ ] Read methods successfully return normalized Zod schema objects (`Risk`, `Control`, etc.).
   - [ ] Write methods persist numerical score and audit trail HTML.
   - [ ] `VerificationAgent` (Groq independent model) can re-pull raw records and verify assessments.
