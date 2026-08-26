# Walkthrough: Agnostic GRC Agent Framework & Schema Parser

We have implemented a platform-agnostic GRC (Governance, Risk, and Compliance) agent framework in **TypeScript**. This architecture decouples the database operations (Adapters) from the reasoning logic (Core Agents) and the model calls (LLM Adapter), allowing you to run compliance audits across **any GRC tool** (ServiceNow, Salesforce, Archer, etc.) simply by plugging in API mappings.

We also built a **Schema Onboarding / Metadata Parsing Agent** to automatically scan unstructured or structured target system schemas and generate conversion configs.

---

## Technical Architecture

```
                               ┌─────────────────────────────────┐
 ┌───────────────┐             │   Core GRC Reasoning Engine     │
 │  ServiceNow   │             │   (TypeScript / Zod Validation) │
 │ GlideRecords  │─(Adapter)──>│                                 │
 └───────────────┘             │  ┌───────────────────────────┐  │             ┌──────────────┐
                               │  │ Risk-Control Mapper       │  │             │              │
 ┌───────────────┐             │  ├───────────────────────────┤  │──(LLM Client)─>│ Google Gemini│
 │  Salesforce   │─(Adapter)──>│  │ Inherent Risk Assessor    │  │             │ (JSON Schema)│
 │Custom Objects │             │  ├───────────────────────────┤  │             └──────────────┘
 └───────────────┘             │  │ Control Effectiveness     │  │
                               │  ├───────────────────────────┤  │
 ┌───────────────┐             │  │ Schema Discovery (Parser) │  │
 │  Future GRC   │─(Adapter)──>│  └───────────────────────────┘  │
 │  (Archer API) │             │                                 │
 └───────────────┘             └─────────────────────────────────┘
```

---

## Code Files Created

All source files are available in your workspace under [e:/ai agent](file:///e:/ai%20agent/):

1. **Core Validation Schemas**: [models.ts](file:///e:/ai%20agent/backend/src/core/models.ts)  
   Declares platform-agnostic GRC structures using Zod. Translates platform data types to a standard contract.
2. **Unified Adapter Contract**: [base.ts](file:///e:/ai%20agent/backend/src/adapters/base.ts)  
   Defines the abstract interface for all platform reads and write-backs.
3. **ServiceNow Adapter**: [servicenow.ts](file:///e:/ai%20agent/backend/src/adapters/servicenow.ts)  
   Translates raw GlideRecord tables (`sn_risk_risk`, `sn_audit_control_test`, `sn_grc_issue`) into agnostic structures.
4. **Salesforce Adapter**: [salesforce.ts](file:///e:/ai%20agent/backend/src/adapters/salesforce.ts)  
   Translates Salesforce custom objects (`Risk__c`, `Control__c`, `Assessment_Factor__c`) into the same agnostic models.
5. **Gemini LLM Interface**: [llm_client.ts](file:///e:/ai%20agent/backend/src/llm/llm_client.ts)  
   Leverages Gemini's structured output capability (`response_mime_type: "application/json"`) to guarantee output formatting, with an automatic client-side simulator.
6. **Reasoning Agents**: [agents.ts](file:///e:/ai%20agent/backend/src/core/agents.ts)  
   Contains the agent algorithms:
   - **Risk-Control Mapping**: Scans risks and profiles, matches controls, flags gaps, and suggests modifications.
   - **Inherent Risk Assessment**: Cross-references active entity issues and prompts LLM to score factors based on target rubrics.
   - **Control Effectiveness**: Performs batch audits. Includes a **deterministic fingerprinting cache** that checks if audit evidence has changed. If unchanged, it carries forward prior assessments instantly, eliminating LLM API costs.
   - **Schema Discovery Agent**: Our parsing node that scans new system catalogs to construct metadata configurations.
7. **Express Server API**: [app.ts](file:///e:/ai%20agent/backend/src/app.ts)  
   Exposes HTTP endpoints for execution runs and onboarding uploads.
8. **Demonstration Dashboard**: [index.html](file:///e:/ai%20agent/frontend/index.html), [style.css](file:///e:/ai%20agent/frontend/style.css), [app.js](file:///e:/ai%20agent/frontend/app.js)  
   A beautiful, high-fidelity dark glassmorphic dashboard showcasing live agent executions, step-by-step console logs, database write-backs, and the metadata parsing portal.

---

## Step-by-Step Execution Verification

### 1. Web Dashboard View
Open the [index.html](file:///e:/ai%20agent/frontend/index.html) file directly in your browser. The dashboard automatically starts in **Standalone Simulation Mode** if it cannot connect to the backend server, allowing you to run the complete pipeline inside the client.

- **Sandbox Tab**: Select a platform (ServiceNow or Salesforce) and run any agent. You can view the raw database records, the translated agnostic structures, the generated LLM prompts, and the final write-back logs side-by-side.
- **Schema Onboarding Tab**: Paste a raw GRC database configuration and watch the parser output mapping instructions.

### 2. Live Node.js Execution
To run the live TypeScript server and connect it to the Google Gemini API:

1. Navigate to the backend folder:
   ```bash
   cd "e:\ai agent\backend"
   ```
2. Create a `.env` file containing your Gemini API key:
   ```env
   GEMINI_API_KEY=your_actual_api_key_here
   GEMINI_MODEL=gemini-1.5-flash
   PORT=3000
   ```
3. Boot the Express API server:
   ```bash
   npm run dev
   ```
4. The dashboard will automatically detect the server (badge turns green to read **Server Connected**) and route executions through the live Gemini API endpoint.

---

## Recent Feature Enhancements (July-August 2026)

### 1. ServiceNow Integration Writeback Fixes
*   **Correct M2M Fields**: Updated the junction table mapping payload keys to use `risk` and `control` (ServiceNow's native reference fields for `sn_risk_m2m_risk_control`) instead of `sn_risk_risk` and `sn_compliance_control`, resolving the `403 Forbidden` API permission errors.
*   **Active Control Filter**: Filtered out `active = false` controls prior to writebacks to prevent triggering the `Avoid inactive items` Business Rule on ServiceNow.
*   **Dynamic recommendation fields**: The recommendation summary is now written to `u_ai_recommendation` on `sn_risk_risk` or falls back to the native `description` field.

### 2. Vercel Serverless Optimizations
*   **Persistent Dynamic Configurations**: Updated `generated_adapter_config.ts` to scan both `/tmp` (writable) and the pre-bundled `generated_adapters` directory in the repository, preventing onboarded platforms from vanishing on Vercel cold starts.
*   **Extended Timeout**: Increased Vercel function execution timeout to `300s` (`maxDuration` in `vercel.json`) to accommodate sequential multi-step inherent and control effectiveness assessments.

### 3. LLM API Resilience
*   **Nudge/Retry on Empty Responses**: Implemented an automatic retry handler inside the Gemini `runToolLoop` client when the model returns transient empty responses (no text, no tool calls) to prevent random process aborts.

### 4. Detailed Audit Log Checklist (Writeback Logs)
When running the **Risk-Control Mapping Agent**, the output log in the console now renders a rich audit trail checklist rather than a simple summary:
*   **Selected Controls (✅)**: Lists each selected control name, category (e.g., *Access Control*, *Database Security*, *General*), and the AI reason for mapping it.
*   **Rejected Controls (❌)**: Lists all candidate controls that were *not* selected, along with a custom AI-reason describing why they did not meet the business criteria for this specific risk.
*   **Entity Totals**: Displays the total count of controls evaluated, selected, and rejected under the business unit.
*   **Recommendations & Justifications**: Shows the overall recommendation, identified compliance gaps, and high-level justification.

---

## Vercel Deployment

The application is deployed on Vercel as a unified full-stack application (frontend + serverless backend).

- **Production URL:** [https://grc-agent-hub-nu.vercel.app](https://grc-agent-hub-nu.vercel.app) (or via [Dashboard](https://vercel.com/srujanwissdas-projects/grc-agent-hub))
- **Architecture**:
  - The frontend is served statically by Vercel.
  - The Express backend (`app.ts`) is wrapped by Vercel's `@vercel/node` adapter via `api/index.ts` and runs as Serverless Functions on `/api/*` routes.
  - Due to the ephemeral filesystem of Serverless Functions, Observability traces and dynamically generated adapter configurations are written to `/tmp` in production.

> [!IMPORTANT]
> Because `.env` is git-ignored, you **must** configure your API keys (Gemini, Salesforce, ServiceNow) in the Vercel dashboard:
> 1. Go to your [Vercel Project Settings](https://vercel.com/srujanwissdas-projects/grc-agent-hub/settings/environment-variables)
> 2. Add `GEMINI_API_KEY`, `SERVICENOW_INSTANCE_URL`, `SALESFORCE_CLIENT_ID`, etc., matching your local `.env` file.
> 3. After adding the variables, trigger a **re-deploy** for them to take effect.

