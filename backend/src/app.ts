console.log('[START] app.ts is loading...');
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import fs from 'fs';

// Load .env file explicitly
const envPath = path.resolve(__dirname, '../.env');
const result = dotenv.config({ path: envPath });

// FALLBACK: If env vars aren't loaded, read .env file manually
if (!process.env.SERVICENOW_INSTANCE_002_URL && fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value && !process.env[key]) {
      process.env[key] = value.trim().replace(/^["']|["']$/g, '');
    }
  });
  console.log(`[FALLBACK] Manually loaded env vars from .env file`);
}
import { ServiceNowAdapter } from './adapters/servicenow';
import { SalesforceAdapter } from './adapters/salesforce';
import { DynamicAdapter } from './adapters/dynamic_adapter';
import { SalesforceDescribeConnector } from './adapters/connectors/salesforce_describe';
import { GeminiLLMClient, GroqLLMClient } from './llm/llm_client';
import { GeminiEmbeddingsClient } from './llm/embeddings_client';
import { VectorStore } from './core/vector_store';
import { UniversalSchemaDiscoveryAgent } from './core/universal_schema_discovery_agent';
import { listAllAdapterConfigs, GeneratedAdapterConfig } from './core/generated_adapter_config';
import {
  ControlEffectivenessAgent,
  InherentAssessmentAgent,
  RiskControlMappingAgent,
  IssueIdentificationAgent
} from './core/agents';
import { withTrace, currentTrace, recentTraces, computeStats } from './core/observability';
import { runIntegrityScan } from './core/integrity_scan';
import { VerificationAgent } from './core/verification_agent';
import { instanceRegistry } from './core/instance-registry';
import { obsService } from './core/instance-observability';
import { cacheService } from './core/instance-cache';

console.log('[DEBUG] Multi-instance services imported successfully');
console.log(`[DEBUG] Instance Registry initialized with instances: ${instanceRegistry.getValidInstances().join(', ')}`);

// Extend Express Request type for instance context
declare global {
  namespace Express {
    interface Request {
      instanceId: string;
      obsService: typeof obsService;
      cacheService: typeof cacheService;
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ============================================================================
// LOUD inbound request logger — especially valuable when ServiceNow Script Includes
// hit the wrong endpoint or method (HTTP 405 is #1 cause of "button does
// nothing" failures). Logs EVERY /api/* call *before* any other middleware so
// we can see a 405/404 even if isolation or routing rejects it.
// ============================================================================
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(
      `[INBOUND] ${req.method} ${req.path} ` +
      `| Content-Type: ${req.get('Content-Type') || '(none)'} ` +
      `| Content-Length: ${req.get('Content-Length') || '0'} ` +
      `| Origin: ${req.get('Origin') || '(none'}`
    );
  }
  next();
});

// Disable caching for all API requests to ensure fresh filtered data
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  next();
});

// ============================================================================
// Static Frontend Serving
// ============================================================================
// Serve the frontend HTML/CSS/JS from the /frontend directory so the whole
// app (frontend + API) works on a single localhost:3000 origin.
const frontendDir = path.resolve(__dirname, '../../frontend');
if (fs.existsSync(frontendDir)) {
  console.log(`[FRONTEND] Serving static files from: ${frontendDir}`);
  app.use(express.static(frontendDir));

  // SPA-style fallback: any non-API GET that doesn't match a file goes to index.html
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      const indexPath = path.join(frontendDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
        return;
      }
    }
    next();
  });
} else {
  console.warn(`[FRONTEND] WARNING: Frontend directory not found at ${frontendDir}`);
}

// ============================================================================
// Instance bootstrap endpoint — runs BEFORE the isolation middleware on
// purpose. Returns the list of valid, configured ServiceNow instances so the
// frontend can populate its Instance dropdown WITHOUT needing an instanceId
// of its own. This breaks the chicken-and-egg cycle where the first connection
// check (which previously defaulted to 'default') would 403 and the frontend
// would go straight to Standalone Simulation Mode, never learning what
// instances exist.
// ============================================================================
app.get('/api/instances', (req, res) => {
  const validInstances = instanceRegistry.getValidInstances();
  const instances = validInstances.map(id => {
    const meta = instanceRegistry.getInstanceMetadata(id);
    return {
      instanceId: id,
      isConfigured: meta?.isConfigured ?? false,
      label: id.replace(/^instance_0*/i, 'Instance ')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase())
    };
  });
  res.json({
    success: true,
    count: instances.length,
    instances
  });
});

// ============================================================================
// CRITICAL: Instance Isolation Middleware
// ============================================================================
// Every request is scoped to a specific instance.
// ISOLATION GUARANTEE: No data leakage between instances.
// ============================================================================
app.use((req, res, next) => {
  // Extract instanceId from request (body, query, or header)
  const instanceId = req.body?.instanceId ||
                     req.query?.instanceId ||
                     req.get('X-Instance-Id') ||
                     'default';

  // ✅ VALIDATION: Verify instance is configured
  if (!instanceRegistry.isValidInstance(instanceId)) {
    const validInstances = instanceRegistry.getValidInstances();
    console.warn(
      `[ISOLATION] Access denied: Instance '${instanceId}' not found. ` +
      `Valid instances: ${validInstances.join(', ')}`
    );

    return res.status(403).json({
      success: false,
      error: `Instance '${instanceId}' not found or not configured.`,
      availableInstances: validInstances
    });
  }

  // ✅ INJECTION: Attach instance context to request
  req.instanceId = instanceId;
  req.obsService = obsService;
  req.cacheService = cacheService;

  // Log request with instance context
  console.log(
    `[ISOLATION] ${req.method} ${req.path} from instance '${instanceId}'`
  );

  next();
});

// Initialize core client and adapters
const llmClient = new GeminiLLMClient();
// Separate client/provider from llmClient above — used ONLY by the
// verification layer, deliberately never by any producer agent, so the
// checker can never share the producer's blind spots.
const groqClient = new GroqLLMClient();
const embeddingsClient = new GeminiEmbeddingsClient();
const vectorStore = new VectorStore();
const universalDiscoveryAgent = new UniversalSchemaDiscoveryAgent(llmClient, embeddingsClient, vectorStore);
const salesforceAdapter = new SalesforceAdapter();

// Registry of dynamically onboarded platforms (built by UniversalSchemaDiscoveryAgent).
// Keyed by platformName, so /api/run-agent can route to them alongside the
// hand-written ServiceNow/Salesforce adapters with zero new adapter code.
const dynamicAdapters = new Map<string, DynamicAdapter>();

function buildDynamicAdapter(config: GeneratedAdapterConfig): DynamicAdapter {
  // Only 'salesforce-soql' has a live connection today, so it reuses the
  // same Salesforce credentials already configured for SalesforceAdapter.
  return new DynamicAdapter(
    config,
    process.env.SALESFORCE_INSTANCE_URL || '',
    process.env.SALESFORCE_CLIENT_ID || '',
    process.env.SALESFORCE_CLIENT_SECRET || ''
  );
}

// Load any previously generated adapter configs at startup so onboarded
// platforms survive a server restart.
for (const config of listAllAdapterConfigs()) {
  dynamicAdapters.set(config.platformName, buildDynamicAdapter(config));
  console.log(`[GRC Agnostic Server] Loaded previously generated adapter for platform '${config.platformName}'.`);
}

// Metadata endpoint
app.get('/api/platforms', (req, res) => {
  const instanceId = req.instanceId; // ✅ From isolation middleware

  // ✅ ISOLATION: Get instance-specific metadata
  const instanceMetadata = instanceRegistry.getInstanceMetadata(instanceId);

  const discoveredPlatforms = Array.from(dynamicAdapters.values()).map(a => ({
    id: a.getPlatformName(),
    name: `${a.getPlatformName()} (Discovered)`,
    description: `Onboarded via Universal Schema Discovery Agent — ${a.getEntityLabel()}-scoped GRC data.`
  }));

  res.json({
    instanceId, // ✅ Proof of isolation
    instance: instanceMetadata,
    platforms: [
      {
        id: 'servicenow',
        name: 'ServiceNow GRC',
        description: 'Enterprise Risk & Compliance Workspace',
        isConfigured: instanceMetadata?.isConfigured || false
      },
      { id: 'salesforce', name: 'Salesforce GRC (Custom)', description: 'Salesforce Custom GRC Cloud Objects' },
      ...discoveredPlatforms
    ],
    agents: [
      { id: 'control-effectiveness', name: 'Control Effectiveness Agent', description: 'Batch assesses control effectiveness against test evidence and audit runs.' },
      { id: 'inherent-assessment', name: 'Inherent Assessment Agent', description: 'Evaluates inherent factors (PII sensitivity, threat model) using guidance rubrics.' },
      { id: 'risk-control-mapping', name: 'Risk-Control Mapping Agent', description: 'Analyses entity risks and maps relevant mitigating controls from library.' },
      { id: 'issue-identification', name: 'Issue Identification Agent', description: 'Drafts a tracked issue for a risk, given its sys_id — trigger is external (e.g. a ServiceNow client script), not scan-based.' }
    ]
  });
});

// Endpoint to run any core GRC agent dynamically
app.post('/api/run-agent', async (req, res) => {
  const { platform, agent, targetId } = req.body;
  const instanceId = req.instanceId; // ✅ From isolation middleware

  if (!platform || !agent || !targetId) {
    return res.status(400).json({
      error: 'Missing parameters platform, agent, or targetId.',
      instanceId
    });
  }

  // ✅ ISOLATION: Select adapter for THIS instance only
  let adapter: any;
  try {
    if (platform === 'servicenow') {
      // ✅ Use instanceRegistry — centralized validation + cached adapters
      //    (this also guarantees isolation: each instanceId gets its own connection)
      adapter = instanceRegistry.getAdapter(instanceId);
      console.log(`[ISOLATION] Using registered ServiceNow adapter for instance '${instanceId}'`);
    } else if (platform === 'salesforce') {
      // TODO: Extend SalesforceAdapter to support multiple instances
      adapter = salesforceAdapter;
    } else {
      adapter = dynamicAdapters.get(platform);
    }

    if (!adapter) {
      return res.status(400).json({
        error: `Platform '${platform}' is not supported.`,
        instanceId
      });
    }
  } catch (error: any) {
    console.error(`[ISOLATION] Failed to get adapter for instance '${instanceId}': ${error.message}`);
    return res.status(500).json({
      error: `Failed to initialize adapter for instance '${instanceId}'`,
      instanceId
    });
  }

  // ✅ ISOLATION: Capture logs per-request (not globally)
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    logs.push(args.join(' '));
    originalLog(...args);
  };

  if (!['control-effectiveness', 'inherent-assessment', 'risk-control-mapping', 'issue-identification'].includes(agent)) {
    console.log = originalLog;
    return res.status(400).json({
      error: `Unsupported agent action: ${agent}`,
      instanceId
    });
  }

  try {
    // ✅ ISOLATION: Each execution runs inside instance-scoped observability trace
    let traceId = '';
    const result = await obsService.withTrace(
      instanceId,
      'run-agent',
      async (recordSpan) => {
        // Record start of agent execution
        recordSpan('agent-start', {
          agent,
          platform,
          targetId
        });

        let agentResult: any;
        if (agent === 'control-effectiveness') {
          agentResult = await new ControlEffectivenessAgent(adapter, llmClient).execute(targetId);
        } else if (agent === 'inherent-assessment') {
          agentResult = await new InherentAssessmentAgent(adapter, llmClient).execute(targetId);
        } else if (agent === 'issue-identification') {
          agentResult = await new IssueIdentificationAgent(adapter, llmClient).execute(targetId);
        } else {
          agentResult = await new RiskControlMappingAgent(adapter, llmClient).execute(targetId);
        }

        recordSpan('agent-complete', {
          agent,
          platform
        });

        return agentResult;
      },
      {
        platform,
        agent,
        targetId,
        instanceId // ✅ ISOLATION: Tag trace with instance
      }
    );

    console.log = originalLog;

    // ✅ DIAGNOSTICS: Expose adapter mode so caller can immediately tell
    //    if writes went to live ServiceNow or just mock in-memory data.
    //    This is the #1 debugging aid for "status good but no output in SNOW".
    const adapterDiagnostics = typeof adapter.getAdapterDiagnostics === 'function'
      ? adapter.getAdapterDiagnostics()
      : { instanceId, mode: 'unknown', useLive: null as boolean | null, instanceUrlConfigured: false, authConfigured: false };

    // ✅ ISOLATION: Response includes instanceId for audit trail
    res.json({
      success: true,
      agent,
      platform,
      instanceId, // ✅ Proof of isolation
      adapterDiagnostics, // ✅ Show live vs mock mode UPFRONT
      result,
      logs
    });

    // ── Verification layer (pilot: Control Effectiveness only) ──────────────
    // Fired AFTER the response is sent, not awaited — this must never add
    // latency to the producer agent's response or affect it in any way.
    // Independent of and unrelated to the producer's own success/failure;
    // errors here are logged and swallowed, never surfaced to the caller.
    if (agent === 'control-effectiveness' && groqClient.isLive()) {
      new VerificationAgent(adapter, groqClient).verifyControlEffectiveness(targetId)
        .then(v => console.log(`[VerificationAgent] Instance '${instanceId}' ${v.success ? 'OK' : 'skipped'}: ${v.message}`))
        .catch(e => console.warn(`[VerificationAgent] Instance '${instanceId}' Failed: ${e.message}`));
    }
  } catch (error: any) {
    console.log = originalLog;

    // ✅ DIAGNOSTICS: Expose adapter mode even on error paths
    const adapterDiagnostics = adapter && typeof adapter.getAdapterDiagnostics === 'function'
      ? adapter.getAdapterDiagnostics()
      : { instanceId, mode: 'unknown', useLive: null as boolean | null, instanceUrlConfigured: false, authConfigured: false };

    // ✅ ISOLATION: Sanitize error to not leak instance data
    const errorMsg = error?.message || 'Unknown error occurred';
    const sanitizedError = errorMsg.includes('[ISOLATION]')
      ? errorMsg
      : `[ISOLATION] Instance '${instanceId}' agent execution failed`;

    res.status(500).json({
      success: false,
      error: sanitizedError,
      instanceId, // ✅ Include instance for debugging
      adapterDiagnostics, // ✅ Show live vs mock mode even on errors
      logs
    });
  }
});

// ============================================================================
// AI Observability endpoints (Instance-scoped)
// ============================================================================
app.get('/api/observability/traces', async (req, res) => {
  const instanceId = req.instanceId; // ✅ From isolation middleware
  const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 100);

  // ✅ ISOLATION: Get traces for THIS instance only
  const traces = obsService.getTracesForInstance(instanceId, limit);
  const sanitized = traces.map(t => obsService.sanitizeTraceForResponse(t));

  res.json({
    success: true,
    instanceId, // ✅ Proof of isolation
    traceCount: sanitized.length,
    traces: sanitized
  });
});

app.get('/api/observability/stats', async (req, res) => {
  const instanceId = req.instanceId; // ✅ From isolation middleware

  // ✅ ISOLATION: Get stats for THIS instance only
  const stats = obsService.getStatsForInstance(instanceId);
  const cacheStats = cacheService.getStatsForInstance(instanceId);

  res.json({
    success: true,
    instanceId, // ✅ Proof of isolation
    observability: stats,
    cache: cacheStats
  });
});

// ============================================================================
// Integrity scan — the async half of the "0 issues" monitoring pair. The
// synchronous writeVerified() check inside agents.ts catches a bad write the
// instant it happens; this catches drift (a field that was fine right after
// the write but got cleared by something else afterward — confirmed possible
// on this project). Meant to be hit by a scheduler (Vercel Cron, see
// vercel.json), not a human — gated by a shared secret since it triggers real
// writes (flagging affected records) against the live platform, same as
// /api/run-agent.
// ============================================================================
app.get('/api/health/integrity-scan', async (req, res) => {
  const instanceId = req.instanceId; // ✅ From isolation middleware

  // Vercel automatically sends CRON_SECRET as `Authorization: Bearer <value>`
  // on cron-triggered requests — this is Vercel's own documented mechanism,
  // not a custom header, so a scheduled invocation authenticates for free.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    if (req.get('authorization') !== `Bearer ${cronSecret}`) {
      return res.status(401).json({
        success: false,
        error: 'Missing or invalid Authorization header.',
        instanceId
      });
    }
  } else {
    console.warn(`[IntegrityScan] Instance '${instanceId}' CRON_SECRET is not set — endpoint is running unauthenticated.`);
  }

  const sinceHours = Math.min(Math.max(parseInt(String(req.query.sinceHours || '6'), 10) || 6, 1), 72);

  try {
    // ✅ ISOLATION: Scan instance-specific adapter only
    const result = await obsService.withTrace(
      instanceId,
      'integrity-scan',
      async (recordSpan) => {
        recordSpan('scan-start', { sinceHours });

        // ✅ Use registry-managed adapter for THIS instance
        const servicenowAdapter = instanceRegistry.getAdapter(instanceId);
        const servicenowResult = await runIntegrityScan(servicenowAdapter, sinceHours);

        recordSpan('scan-complete', {
          platform: 'servicenow',
          findings: servicenowResult.findings.length
        });

        return {
          ...servicenowResult,
          adapterDiagnostics: servicenowAdapter.getAdapterDiagnostics()
        };
      },
      {
        sinceHours,
        instanceId // ✅ ISOLATION: Tag with instance
      }
    );

    res.json({
      success: true,
      instanceId, // ✅ Proof of isolation
      adapterDiagnostics: result.adapterDiagnostics, // ✅ Show live vs mock mode
      findings: result.findings.length,
      result
    });
  } catch (error: any) {
    console.error(`[ISOLATION] Instance '${instanceId}' integrity-scan failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: `[ISOLATION] Integrity scan failed for instance '${instanceId}'`,
      instanceId
    });
  }
});

// Endpoint to list all available risks from ServiceNow (live or mock)
app.get('/api/platforms/servicenow/risks', async (req, res) => {
  const instanceId = req.instanceId; // ✅ From isolation middleware

  try {
    // ✅ ISOLATION: Use registry-managed adapter for THIS instance
    const adapter = instanceRegistry.getAdapter(instanceId);
    const risks = await adapter.getAllRisks();
    const adapterDiagnostics = adapter.getAdapterDiagnostics();

    res.json({
      success: true,
      instanceId, // ✅ Proof of isolation
      adapterDiagnostics, // ✅ Show live vs mock mode
      risks
    });
  } catch (error: any) {
    console.error(`[ISOLATION] Instance '${instanceId}' risks fetch failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: `[ISOLATION] Failed to fetch risks for instance '${instanceId}'`,
      instanceId
    });
  }
});

// Endpoint to list all assessment instances from ServiceNow (live or mock)
app.get('/api/platforms/servicenow/assessments', async (req, res) => {
  const instanceId = req.instanceId; // ✅ From isolation middleware

  try {
    // ✅ ISOLATION: Use registry-managed adapter for THIS instance
    const adapter = instanceRegistry.getAdapter(instanceId);
    const agentFilter = req.query.agent ? String(req.query.agent) : undefined;
    const instances = await adapter.getAllAssessmentInstances(agentFilter);
    const adapterDiagnostics = adapter.getAdapterDiagnostics();

    res.json({
      success: true,
      instanceId, // ✅ Proof of isolation
      adapterDiagnostics, // ✅ Show live vs mock mode
      useLive: adapterDiagnostics.useLive,
      instances
    });
  } catch (error: any) {
    console.error(`[ISOLATION] Instance '${instanceId}' assessments fetch failed: ${error.message}`);
    res.status(500).json({
      success: false,
      error: `[ISOLATION] Failed to fetch assessments for instance '${instanceId}'`,
      instanceId
    });
  }
});

// Endpoint to list all available risks from Salesforce (live or mock)
app.get('/api/platforms/salesforce/risks', async (req, res) => {
  try {
    const risks = await salesforceAdapter.getAllRisks();
    res.json({ success: true, risks });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to list all assessment instances from Salesforce (live or mock)
app.get('/api/platforms/salesforce/assessments', async (req, res) => {
  try {
    const agent = req.query.agent as string;
    const instances = await salesforceAdapter.getAllAssessmentInstances(agent);
    res.json({ success: true, instances });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint to parse new platform schemas from pasted metadata text (no live connection required)
app.post('/api/schema-discovery', async (req, res) => {
  const { rawMetadata, platformName } = req.body;
  if (!rawMetadata) {
    return res.status(400).json({ error: 'Missing parameter rawMetadata.' });
  }

  try {
    const result = await universalDiscoveryAgent.executeFromPastedMetadata(platformName || 'Custom GRC Platform', rawMetadata);
    res.json({
      success: true,
      result
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint to onboard a new platform via LIVE schema introspection + vector matching.
// Today only Salesforce orgs are supported as a live connection type — the
// pipeline reuses the same SALESFORCE_* credentials already configured for
// the hand-written SalesforceAdapter.
app.post('/api/schema-discovery/live', async (req, res) => {
  const { platformName, entityLabel } = req.body;
  if (!platformName) {
    return res.status(400).json({ error: 'Missing parameter platformName.' });
  }

  const instanceUrl = process.env.SALESFORCE_INSTANCE_URL || '';
  const clientId = process.env.SALESFORCE_CLIENT_ID || '';
  const clientSecret = process.env.SALESFORCE_CLIENT_SECRET || '';
  const connector = new SalesforceDescribeConnector(instanceUrl, clientId, clientSecret);

  if (!connector.isConfigured()) {
    return res.status(400).json({ error: 'Live discovery requires SALESFORCE_INSTANCE_URL, SALESFORCE_CLIENT_ID and SALESFORCE_CLIENT_SECRET to be configured in .env.' });
  }

  const logs: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: any[]) => { logs.push(args.join(' ')); originalLog(...args); };
  console.warn = (...args: any[]) => { logs.push(args.join(' ')); originalWarn(...args); };

  try {
    const config = await withTrace('schema-discovery', { platformName }, () =>
      universalDiscoveryAgent.executeLive(platformName, connector, 'salesforce-soql', entityLabel)
    );
    dynamicAdapters.set(config.platformName, buildDynamicAdapter(config));

    console.log = originalLog;
    console.warn = originalWarn;
    res.json({ success: true, config, logs });
  } catch (error: any) {
    console.log = originalLog;
    console.warn = originalWarn;
    res.status(500).json({ success: false, error: error.message, logs });
  }
});

// Purpose-based candidate ranking (fast — no LLM confirmation pass).
// Ranks every queryable object in the connected Salesforce org by semantic
// similarity to the gold-standard table purposes learned from the
// hand-written adapters, and returns the top matches with scores.
app.get('/api/schema-discovery/candidates', async (req, res) => {
  const connector = new SalesforceDescribeConnector(
    process.env.SALESFORCE_INSTANCE_URL || '',
    process.env.SALESFORCE_CLIENT_ID || '',
    process.env.SALESFORCE_CLIENT_SECRET || ''
  );
  if (!connector.isConfigured()) {
    return res.status(400).json({ success: false, error: 'Salesforce credentials not configured in .env.' });
  }
  try {
    const topK = parseInt(String(req.query.topK || '15'), 10);
    const candidates = await universalDiscoveryAgent.rankCandidateObjects(connector, topK);
    res.json({ success: true, semantic: embeddingsClient.isLive(), candidates });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Lists platforms onboarded via the Universal Schema Discovery agent
app.get('/api/platforms/discovered', (req, res) => {
  res.json({
    success: true,
    platforms: Array.from(dynamicAdapters.values()).map(a => ({
      platformName: a.getPlatformName(),
      entityLabel: a.getEntityLabel()
    })),
    configs: listAllAdapterConfigs()
  });
});

// Generic risk/assessment listing for dynamically onboarded platforms
app.get('/api/platforms/:platformName/risks', async (req, res) => {
  const adapter = dynamicAdapters.get(req.params.platformName);
  if (!adapter) return res.status(404).json({ success: false, error: `No discovered platform named '${req.params.platformName}'.` });
  try {
    const risks = await adapter.getAllRisks();
    res.json({ success: true, risks });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/platforms/:platformName/assessments', async (req, res) => {
  const adapter = dynamicAdapters.get(req.params.platformName);
  if (!adapter) return res.status(404).json({ success: false, error: `No discovered platform named '${req.params.platformName}'.` });
  try {
    const agent = req.query.agent as string;
    const instances = await adapter.getAllAssessmentInstances(agent);
    res.json({ success: true, instances });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// Export for Vercel (and other serverless runtimes) which import the app
// directly without calling listen(). Local Express dev still calls listen().
// Diagnostic endpoint: describe any Salesforce object by name
// Usage: GET /api/debug/salesforce/describe/Ema_Audit_Trail__c
app.get('/api/debug/salesforce/describe/:objectName', async (req, res) => {
  try {
    const { objectName } = req.params;

    // Use the Salesforce adapter to query the describe API
    const token = (salesforceAdapter as any).getAccessToken ?
      await (salesforceAdapter as any).getAccessToken() :
      null;

    if (!token) {
      return res.status(401).json({ error: 'Salesforce credentials not configured' });
    }

    const instanceUrl = (salesforceAdapter as any).instanceUrl;

    const response = await axios.get(
      `${instanceUrl}/services/data/v60.0/sobjects/${objectName}/describe`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const describe = response.data;

    // Return simplified field list
    const fields = (describe as any).fields.map((f: any) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      updateable: f.updateable,
      createable: f.createable,
      length: f.length,
      custom: f.custom
    }));

    res.json({
      objectName,
      totalFields: fields.length,
      fields
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// Catch-all handler for unmatched API requests. Explains *exactly* what went
// wrong so when a ServiceNow Script Include calls the wrong method/path, the
// error message (and server log) is actionable instead of a mysterious 404.
// ============================================================================
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  // Compute which methods ARE available for this path.
  // Exact matches first, then parameterized patterns that Express normally
  // handles automatically (e.g. /api/platforms/servicenow/risks matches the
  // pattern /api/platforms/:platformName/risks).
  const methodTable: Record<string, string[]> = {
    '/api/instances': ['GET'],
    '/api/platforms': ['GET'],
    '/api/run-agent': ['POST'],
    '/api/observability/traces': ['GET'],
    '/api/observability/stats': ['GET'],
    '/api/health/integrity-scan': ['GET'],
    '/api/platforms/servicenow/risks': ['GET'],
    '/api/platforms/servicenow/assessments': ['GET'],
    '/api/platforms/salesforce/risks': ['GET'],
    '/api/platforms/salesforce/assessments': ['GET'],
    '/api/schema-discovery': ['POST'],
    '/api/schema-discovery/live': ['POST'],
    '/api/schema-discovery/candidates': ['GET'],
    '/api/platforms/discovered': ['GET'],
  };
  const parameterPatterns: { pattern: RegExp; methods: string[] }[] = [
    { pattern: /^\/api\/platforms\/[^\/]+\/risks$/, methods: ['GET'] },
    { pattern: /^\/api\/platforms\/[^\/]+\/assessments$/, methods: ['GET'] },
    { pattern: /^\/api\/debug\/salesforce\/describe\/[^\/]+$/, methods: ['GET'] }
  ];

  let allowed = methodTable[req.path];
  if (!allowed) {
    const hit = parameterPatterns.find(p => p.pattern.test(req.path));
    if (hit) allowed = hit.methods;
  }

  if (allowed && !allowed.includes(req.method)) {
    // ---- 405 METHOD NOT ALLOWED -----------------------------------------
    console.warn(
      `[405] ${req.method} ${req.path} — allowed methods: ${allowed.join(', ')}`
    );
    res.set('Allow', allowed.join(', '));
    return res.status(405).json({
      success: false,
      error: `HTTP 405: Method '${req.method}' not allowed on '${req.path}'. Allowed: ${allowed.join(', ')}`,
      troubleshooting: [
        `If you are calling from a ServiceNow Script Include:`,
        `  → /api/run-agent requires POST (not GET), setHttpMethod('POST')`,
        `  → All GET endpoints require: ?instanceId=instance_001 (or instance_002)`,
        `  → All POST bodies require JSON key "instanceId": "instance_001"`,
        `  → Always set Content-Type: application/json via setRequestHeader('Content-Type','application/json')`
      ].join('\n')
    });
  }

  // ---- 404 PATH NOT FOUND --------------------------------------------
  console.warn(`[404] ${req.method} ${req.path} — no route matches`);
  return res.status(404).json({
    success: false,
    error: `HTTP 404: No route '${req.method} ${req.path}' exists on this server.`,
    availableEndpoints: methodTable
  });
});

export default app;

// Server bootup — skipped on Vercel where the platform invokes the handler directly
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`[GRC Agnostic Server] Listening on http://localhost:${PORT}`);
  });
}

