// Hand-written to match wrangler.jsonc's bindings. Once `wrangler login` has
// run (Phase 4), `wrangler types` can regenerate/verify this against the real
// bound resources — until then this is the source of truth for the `Env` shape
// threaded through every ported module in place of Node's `process.env`.
export interface Env {
  // KV
  ADAPTER_CONFIGS: KVNamespace;
  VECTOR_CACHE: KVNamespace;

  // D1
  DB: D1Database;

  // Workflows
  CONTROL_EFFECTIVENESS_WORKFLOW: Workflow;
  INHERENT_ASSESSMENT_WORKFLOW: Workflow;
  RISK_CONTROL_MAPPING_WORKFLOW: Workflow;

  // Secrets (wrangler secret put)
  GEMINI_API_KEY: string;
  SERVICENOW_USERNAME: string;
  SERVICENOW_PASSWORD: string;
  SALESFORCE_CLIENT_ID: string;
  SALESFORCE_CLIENT_SECRET: string;
  WORKER_INBOUND_TOKEN: string;

  // Vars (wrangler.jsonc "vars")
  GEMINI_MODEL: string;
  GEMINI_EMBEDDING_MODEL: string;
  GEMINI_TIMEOUT_MS: string;
  GEMINI_TOOL_MAX_TOKENS: string;
  SERVICENOW_USE_LIVE: string;
  SERVICENOW_INSTANCE_URL: string;
  SALESFORCE_USE_LIVE: string;
  SALESFORCE_INSTANCE_URL: string;
}
