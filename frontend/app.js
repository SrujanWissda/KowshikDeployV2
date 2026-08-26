/* ============================================================================
   Agnostic GRC AI Agent Hub - Frontend Logic
   Handles dynamic tab switching, console flow animations, API requests,
   and provides a complete client-side GRC simulation fallback.
   ============================================================================ */

// Use a relative path so the frontend works on both Vercel (where frontend
// and API are on the same domain) and locally via `vercel dev`.
const API_BASE = '/api';
let isStandaloneMode = true;
let currentInstanceId = '';
let availableInstances = [];

function withInstanceId(url) {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}instanceId=${encodeURIComponent(currentInstanceId)}`;
}

async function bootstrapInstances() {
  try {
    const res = await fetch(`${API_BASE}/instances`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    availableInstances = data.instances || [];
    const instSel = document.getElementById('select-instance');
    if (instSel && availableInstances.length > 0) {
      instSel.innerHTML = availableInstances
        .map(i => `<option value="${i.instanceId}">${i.label}${i.isConfigured ? '' : ' (unconfigured)'}</option>`)
        .join('');
      currentInstanceId = availableInstances[0].instanceId;
      instSel.value = currentInstanceId;
    } else if (instSel) {
      instSel.innerHTML = '<option disabled>No instances configured on server</option>';
    }
    return availableInstances.length > 0;
  } catch (e) {
    return false;
  }
}

// Dynamic Data Store for simulation fallback
const localData = {
  servicenow: {
    targets: [
      { id: 'inst_301', name: 'Assessment Instance (inst_301) - Core DB Cluster' },
      { id: 'risk_001', name: 'Risk Record (risk_001) - Unauthorized DB Access' }
    ],
    rawRecords: {
      inst_301: {
        assessment_instance: { sys_id: 'inst_301', risk: 'risk_001', state: '1' },
        responses: [
          { sys_id: 'resp_401', factor: 'fact_ef_01', factor_name: 'Control Effectiveness Factor', control: 'ctrl_101', control_name: 'Database Password Rotation' },
          { sys_id: 'resp_402', factor: 'fact_ef_01', factor_name: 'Control Effectiveness Factor', control: 'ctrl_102', control_name: 'Multi-Factor Authentication' },
          { sys_id: 'resp_403', factor: 'fact_inh_01', factor_name: 'Data Sensitivity', control: '', control_name: '' },
          { sys_id: 'resp_404', factor: 'fact_inh_02', factor_name: 'External Threat Exposure', control: '', control_name: '' }
        ]
      },
      risk_001: {
        sys_id: 'risk_001',
        name: 'Unauthorized DB Access',
        description: 'Risk of malicious actors gaining direct access to customer DB records.',
        profile: 'profile_db_server',
        profile_name: 'Core DB Cluster',
        controls: [
          { sys_id: 'ctrl_101', name: 'Database Password Rotation', description: 'Rotate database master keys and connection pool passwords every 90 days.', active: true },
          { sys_id: 'ctrl_102', name: 'Multi-Factor Authentication', description: 'Enforce MFA for all user logins, including admin shell accesses.', active: true },
          { sys_id: 'ctrl_103', name: 'Daily Backup Integrity Tests', description: 'Verify integrity of backups daily.', active: true }
        ]
      }
    }
  },
  salesforce: {
    targets: [
      { id: 'sf_asmt_701', name: 'Assessment Instance (sf_asmt_701) - Cloud S3' },
      { id: 'sf_risk_901', name: 'Risk Record (sf_risk_901) - Data Leak via S3' }
    ],
    rawRecords: {
      sf_asmt_701: {
        sf_assessment: { Id: 'sf_asmt_701', Risk__c: 'sf_risk_901', Status__c: 'In Progress' },
        factors: [
          { Id: 'sf_factor_item_01', Label__c: 'Control Mitigating Action', Control__c: 'sf_ctrl_801', Control_Name__c: 'S3 Block Public Access Policy' },
          { Id: 'sf_factor_item_02', Label__c: 'Control Mitigating Action', Control__c: 'sf_ctrl_802', Control_Name__c: 'CloudTrail Audit Logging' },
          { Id: 'sf_factor_item_03', Label__c: 'Financial Impact Level', Control__c: '', Control_Name__c: '' }
        ]
      },
      sf_risk_901: {
        Id: 'sf_risk_901',
        Name: 'Data Leak via S3 Buckets',
        Description__c: 'Unsecured public S3 buckets containing financial reports.',
        Account__c: 'act_101',
        Account_Name__c: 'Cloud Ops & Billing',
        controls: [
          { Id: 'sf_ctrl_801', Name__c: 'S3 Block Public Access Policy', Description__c: 'Enforce AWS Organizations policy to block all public bucket access.', Active__c: true },
          { Id: 'sf_ctrl_802', Name__c: 'CloudTrail Audit Logging', Description__c: 'Log all API operations on AWS and review weekly.', Active__c: true }
        ]
      }
    }
  }
};

// Document Loaded Setup
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupFormListeners();
  setupConsoleTabs();
  const bootstrapOk = await bootstrapInstances();
  await checkBackendConnection(bootstrapOk ? 3 : 0);
});

// ============================================================================
// Navigation Tabs Handler
// ============================================================================
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panes = document.querySelectorAll('.tab-content');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));
      
      tab.classList.add('active');
      const targetId = tab.id.replace('tab-', 'content-');
      document.getElementById(targetId).classList.add('active');
    });
  });
}

// ============================================================================
// Backend Status Checker
// ============================================================================
async function checkBackendConnection(retriesLeft = 3) {
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.getElementById('connection-status');
  const instSel = document.getElementById('select-instance');

  if (!currentInstanceId) {
    isStandaloneMode = true;
    statusDot.className = 'status-dot orange';
    statusText.innerText = 'Standalone Simulation Mode (No instances configured)';
    if (instSel) instSel.innerHTML = '<option disabled>No instances on server</option>';
    loadDropdownsMock();
    return;
  }

  try {
    const res = await fetch(withInstanceId(`${API_BASE}/platforms`));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    isStandaloneMode = false;
    statusDot.className = 'status-dot green';
    statusText.innerText = `Server Connected (Live Mode · ${currentInstanceId})`;
    loadDropdownsLive();
  } catch (e) {
    // A single failed check used to strand the page in offline mode forever,
    // even after the backend came back — including transient failures from
    // the server restarting at the exact moment the page loaded. Retry a
    // few times with a short backoff before actually giving up.
    if (retriesLeft > 0) {
      statusText.innerText = `Connecting to server... (retrying)`;
      setTimeout(() => checkBackendConnection(retriesLeft - 1), 1500);
      return;
    }
    isStandaloneMode = true;
    statusDot.className = 'status-dot orange';
    statusText.innerText = 'Standalone Simulation Mode (Offline)';
    loadDropdownsMock();
  }
}

// Manual escape hatch: lets a stuck page recover without a full reload if the
// backend comes back up later in the session. Also re-bootstraps the instance
// list in case new instances were added since page load.
async function retryBackendConnection() {
  await bootstrapInstances();
  await checkBackendConnection();
}

// ============================================================================
// Populating Form Select Dropdowns
// ============================================================================
const platformList = [
  { id: 'servicenow', name: 'ServiceNow GRC', desc: 'Adapter translating GlideRecord structures' },
  { id: 'salesforce', name: 'Salesforce GRC (Custom)', desc: 'Adapter translating custom Salesforce Objects' }
];

const agentList = [
  { id: 'control-effectiveness', name: 'Control Effectiveness Agent', desc: 'Batch evaluates control effectiveness from test evidence and audits' },
  { id: 'inherent-assessment', name: 'Inherent Assessment Agent', desc: 'Assesses inherent factor risk (PII classification, environment) using guidance' },
  { id: 'risk-control-mapping', name: 'Risk-Control Mapping Agent', desc: 'Maps relevant entity control records from compliance library' }
];

function loadDropdownsMock() {
  const selectPlat = document.getElementById('select-platform');
  const selectAgent = document.getElementById('select-agent');
  
  selectPlat.innerHTML = platformList.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
  selectAgent.innerHTML = agentList.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  
  updateHints();
  updateTargets();
}

async function loadDropdownsLive() {
  try {
    const res = await fetch(withInstanceId(`${API_BASE}/platforms`));
    const data = await res.json();
    
    const selectPlat = document.getElementById('select-platform');
    const selectAgent = document.getElementById('select-agent');
    
    selectPlat.innerHTML = data.platforms.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    selectAgent.innerHTML = data.agents.map((a) => `<option value="${a.id}">${a.name}</option>`).join('');
    
    updateHints();
    updateTargets();
  } catch (error) {
    loadDropdownsMock();
  }
}

function updateHints() {
  const platVal = document.getElementById('select-platform').value;
  const agentVal = document.getElementById('select-agent').value;
  
  const plat = platformList.find(p => p.id === platVal);
  const agent = agentList.find(a => a.id === agentVal);
  
  if (plat) document.getElementById('platform-desc').innerText = plat.desc;
  if (agent) document.getElementById('agent-desc').innerText = agent.desc;
}

async function updateTargets() {
  const platform = document.getElementById('select-platform').value;
  const agent = document.getElementById('select-agent').value;
  const selectTarget = document.getElementById('select-target');

  if (!isStandaloneMode && platform) {
    try {
      if (agent === 'risk-control-mapping') {
        // --- Live risks ---
        selectTarget.innerHTML = '<option disabled>⏳ Loading live risks...</option>';
        const res = await fetch(withInstanceId(`${API_BASE}/platforms/${platform}/risks`));
        const data = await res.json();
        if (data.success && data.risks && data.risks.length > 0) {
          selectTarget.innerHTML = data.risks
            .map(r => `<option value="${r.sysId}">${r.name}${r.profileName && r.profileName !== r.name ? ' — ' + r.profileName : ''}</option>`)
            .join('');
          return;
        }
      } else {
        // --- Live assessment instances (for control-effectiveness & inherent-assessment) ---
        selectTarget.innerHTML = '<option disabled>⏳ Loading live assessments...</option>';
        const res = await fetch(withInstanceId(`${API_BASE}/platforms/${platform}/assessments?agent=${agent}`));
        const data = await res.json();
        if (data.success && data.instances && data.instances.length > 0) {
          selectTarget.innerHTML = data.instances
            .map(i => `<option value="${i.sysId}">Assessment for: ${i.riskName} [${i.state}]</option>`)
            .join('');
          return;
        }
        console.warn(`[updateTargets] No live assessment instances found on ${platform}, using mock data.`);
      }
    } catch (e) {
      console.warn('[updateTargets] Live fetch failed, using mock data.', e);
    }
  }

  // Mock / offline fallback
  const targets = localData[platform]?.targets || [];
  let filtered = [];
  if (agent === 'risk-control-mapping') {
    filtered = targets.filter(t => t.id.includes('risk'));
  } else {
    filtered = targets.filter(t => t.id.includes('inst') || t.id.includes('asmt'));
  }
  selectTarget.innerHTML = filtered.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
}




function setupFormListeners() {
  const instSel = document.getElementById('select-instance');
  if (instSel) {
    instSel.addEventListener('change', () => {
      currentInstanceId = instSel.value;
      if (!isStandaloneMode) {
        loadDropdownsLive();
        refreshObservability();
        loadIntegrityHistory();
      }
    });
  }

  document.getElementById('select-platform').addEventListener('change', () => {
    updateHints();
    updateTargets();
  });
  
  document.getElementById('select-agent').addEventListener('change', () => {
    updateHints();
    updateTargets();
  });

  document.getElementById('btn-run').addEventListener('click', handleAgentRun);
  document.getElementById('btn-parse').addEventListener('click', handleSchemaParse);
  document.getElementById('btn-live-discover').addEventListener('click', handleLiveDiscover);
  document.getElementById('btn-obs-refresh').addEventListener('click', refreshObservability);
  document.getElementById('tab-observability').addEventListener('click', refreshObservability);
  document.getElementById('btn-integrity-run').addEventListener('click', runIntegrityScanNow);
  document.getElementById('tab-integrity').addEventListener('click', loadIntegrityHistory);
}

// ============================================================================
// AI Observability
// ============================================================================
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let observabilityTraces = [];

async function refreshObservability() {
  const statsEl = document.getElementById('obs-stats');
  const tracesEl = document.getElementById('obs-traces');

  if (isStandaloneMode) {
    statsEl.innerHTML = '';
    tracesEl.innerHTML = '<p class="field-hint">Observability needs a connected backend server (currently in Standalone Simulation Mode).</p>';
    return;
  }

  try {
    const [statsRes, tracesRes] = await Promise.all([
      fetch(withInstanceId(`${API_BASE}/observability/stats`)).then(r => r.json()),
      fetch(withInstanceId(`${API_BASE}/observability/traces?limit=25`)).then(r => r.json())
    ]);

    const s = statsRes.stats;
    const fallbackRate = s.llmCalls > 0 ? Math.round((s.llmFallbacks / s.llmCalls) * 100) : 0;
    const tiles = [
      { label: 'Agent Runs (recent)', value: s.totalRuns },
      { label: 'Failed Runs', value: s.errorRuns, cls: s.errorRuns > 0 ? 'bad' : '' },
      { label: 'Avg Run Time', value: (s.avgRunMs / 1000).toFixed(1) + 's' },
      { label: 'LLM Calls', value: s.llmCalls },
      { label: 'LLM Fallback Rate', value: fallbackRate + '%', cls: fallbackRate > 20 ? 'bad' : (fallbackRate > 0 ? 'warn' : '') },
      { label: 'Avg LLM Latency', value: (s.llmAvgMs / 1000).toFixed(1) + 's' },
      { label: 'Platform Queries', value: s.platformQueries },
      { label: 'Query Errors', value: s.platformQueryErrors, cls: s.platformQueryErrors > 0 ? 'warn' : '' },
      { label: 'Platform Writes', value: s.platformWrites },
      { label: 'Write Errors', value: s.platformWriteErrors, cls: s.platformWriteErrors > 0 ? 'bad' : '' },
      { label: 'Self-Heal Actions', value: s.selfHeals, cls: s.selfHeals > 0 ? 'warn' : '' }
    ];
    statsEl.innerHTML = tiles.map(t =>
      `<div class="obs-stat"><div class="obs-stat-value ${t.cls || ''}">${t.value}</div><div class="obs-stat-label">${t.label}</div></div>`
    ).join('');

    observabilityTraces = tracesRes.traces || [];
    renderObservabilityTraces();
  } catch (err) {
    tracesEl.innerHTML = `<p class="field-hint">Failed to load observability data: ${escapeHtml(err.message)}</p>`;
  }
}

/** True if any span in this trace is an error or a fallback (used by the "errors/fallbacks only" filter). */
function traceHasIssue(t) {
  if (t.status === 'error') return true;
  return (t.spans || []).some(sp => sp.status === 'error' || sp.status === 'fallback');
}

/** Flattens a trace (meta + every span's meta) into one lowercase string for the search box. */
function traceSearchText(t) {
  const parts = [t.kind, JSON.stringify(t.meta)];
  for (const sp of (t.spans || [])) parts.push(sp.name, JSON.stringify(sp.meta));
  return parts.join(' ').toLowerCase();
}

function toggleAllTraces() {
  const traces = document.querySelectorAll('.obs-trace');
  const anyClosed = Array.from(traces).some(el => !el.classList.contains('open'));
  traces.forEach(el => el.classList.toggle('open', anyClosed));
  document.getElementById('btn-obs-expand-all').innerText = anyClosed ? 'Collapse all' : 'Expand all';
}

function copyTraceJson(traceId) {
  const t = observabilityTraces.find(x => x.traceId === traceId);
  if (!t) return;
  navigator.clipboard.writeText(JSON.stringify(t, null, 2)).catch(() => {});
}

/** One <details> block for a long text value (SOQL, prompt, response) — collapsed by default to keep the span list scannable. */
function detailBlock(label, text) {
  if (!text) return '';
  return `<details class="obs-span-detail"><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(text)}</pre></details>`;
}

function renderObservabilityTraces() {
  const tracesEl = document.getElementById('obs-traces');
  const search = (document.getElementById('obs-search')?.value || '').toLowerCase().trim();
  const errorsOnly = document.getElementById('obs-errors-only')?.checked;

  let traces = observabilityTraces;
  if (errorsOnly) traces = traces.filter(traceHasIssue);
  if (search) traces = traces.filter(t => traceSearchText(t).includes(search));

  if (observabilityTraces.length === 0) {
    tracesEl.innerHTML = '<p class="field-hint">No traces yet — run an agent from the Sandbox tab, then hit Refresh.</p>';
    return;
  }
  if (traces.length === 0) {
    tracesEl.innerHTML = '<p class="field-hint">No traces match the current filter.</p>';
    return;
  }

  tracesEl.innerHTML = traces.map(t => {
    const title = t.kind === 'run-agent'
      ? `${escapeHtml(t.meta.agent || '?')} on ${escapeHtml(t.meta.platform || '?')}`
      : `${escapeHtml(t.kind)} — ${escapeHtml(t.meta.platformName || '')}`;

    const spanRows = (t.spans || []).map(sp => {
      const m = sp.meta || {};
      const metaBits = [];
      if (m.model) metaBits.push(m.model);
      if (m.object) metaBits.push(m.object);
      if (m.table) metaBits.push(m.table);
      if (m.recordId) metaBits.push(`id: ${m.recordId}`);
      if (m.rows !== undefined) metaBits.push(`${m.rows} rows`);
      if (m.count !== undefined) metaBits.push(`${m.count} items`);
      if (m.totalTokens) metaBits.push(`${m.totalTokens} tokens`);
      if (m.promptChars) metaBits.push(`${m.promptChars} prompt chars`);
      if (m.selfHeal) metaBits.push(`self-heal: ${m.selfHeal}`);
      if (m.reason) metaBits.push(`reason: ${m.reason}`);
      if (m.error) metaBits.push(`error: ${m.error}`);

      // The detailed, previously-hidden payloads: full SOQL text and full
      // LLM prompt/response — exactly what had to be dug out with ad-hoc
      // scripts before. Collapsed by default via <details>.
      const details = [
        detailBlock('Query', m.soql || m.query),
        detailBlock('System instruction', m.systemInstruction),
        detailBlock('Prompt', m.prompt),
        detailBlock('Response', m.response)
      ].join('');

      return `<div class="obs-span">
        <div style="flex:1; min-width:0;">
          <span class="obs-badge ${sp.status}">${sp.status}</span> ${escapeHtml(sp.name)}
          <div class="obs-span-meta">${escapeHtml(metaBits.join(' · '))}</div>
          ${details}
        </div>
        <div>${sp.durationMs} ms</div>
      </div>`;
    }).join('');

    return `<div class="obs-trace">
      <div class="obs-trace-header" onclick="this.parentElement.classList.toggle('open')">
        <div>
          <div class="obs-trace-title">${title}</div>
          <div class="obs-trace-sub">${escapeHtml(t.meta.targetId || '')} · ${new Date(t.startedAt).toLocaleString()} · ${(t.spans || []).length} span(s) · trace ${t.traceId}</div>
        </div>
        <div style="display:flex; align-items:center; gap:0.6rem;">
          <span class="obs-badge ${t.status || 'ok'}">${t.status || '?'}</span>
          <span class="obs-trace-sub">${((t.durationMs || 0) / 1000).toFixed(1)}s</span>
          <button class="obs-copy-btn" onclick="event.stopPropagation(); copyTraceJson('${t.traceId}')" title="Copy full trace as JSON">Copy JSON</button>
        </div>
      </div>
      <div class="obs-spans">${spanRows || '<p class="field-hint">No spans recorded.</p>'}</div>
    </div>`;
  }).join('');
}

// ============================================================================
// Integrity Monitoring
//
// A separate tab from Observability on purpose: Observability is a record of
// every agent RUN; this is a record of every integrity SCAN (the async check
// that catches a field drifting empty after the fact — see /api/health/integrity-scan).
// Rendering below is driven entirely by whatever `platform` string each
// adapter's scan result reports — no ServiceNow/Salesforce-specific branches,
// so a future adapter (Archer or otherwise) that implements
// scanForIntegrityIssues() shows up here automatically.
// ============================================================================
async function runIntegrityScanNow() {
  const btn = document.getElementById('btn-integrity-run');
  const statusEl = document.getElementById('integrity-run-status');

  if (isStandaloneMode) {
    statusEl.innerHTML = '<p class="field-hint">Integrity scanning needs a connected backend server (currently in Standalone Simulation Mode).</p>';
    return;
  }

  btn.disabled = true;
  statusEl.innerHTML = '<p class="field-hint">Scanning recently-updated records on every connected platform...</p>';

  const sinceHours = 24;

  try {
    const res = await fetch(withInstanceId(`${API_BASE}/health/integrity-scan?sinceHours=${sinceHours}`));
    const data = await res.json();

    if (res.status === 401) {
      statusEl.innerHTML = '<p class="field-hint">This environment protects on-demand scans with a cron secret, so it can\'t be triggered from the browser here — it still runs automatically on schedule. See Scan History below for past runs.</p>';
      return;
    }
    if (!data.success) {
      statusEl.innerHTML = `<p class="field-hint">Scan failed: ${escapeHtml(data.error || 'unknown error')}</p>`;
      return;
    }

    statusEl.innerHTML = renderIntegrityScanDetail(data, sinceHours);
    await loadIntegrityHistory();
  } catch (err) {
    statusEl.innerHTML = `<p class="field-hint">Scan failed: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

/**
 * Full "what just happened" breakdown for a just-run scan: one open card per
 * platform showing what was checked and, if anything was wrong, exactly what
 * and where — not just a pass/fail count. Same building block (integrityPlatformCard)
 * powers the Scan History cards below, so a live run and a historical one look identical.
 */
function renderIntegrityScanDetail(data, sinceHours) {
  const results = data.results || [];
  const platformCards = results.map(r => integrityPlatformCard({
    platform: r.platform,
    supported: r.supported,
    findings: r.findings || [],
    sinceHours
  })).join('');

  return `<div class="obs-trace open">
    <div class="obs-trace-header" style="cursor:default;">
      <div>
        <div class="obs-trace-title">Scan Results</div>
        <div class="obs-trace-sub">${new Date().toLocaleString()} · ${results.length} platform(s) checked · last ${sinceHours}h window</div>
      </div>
      <span class="obs-badge ${data.totalFindings > 0 ? 'fallback' : 'ok'}">${data.totalFindings > 0 ? data.totalFindings + ' finding(s)' : 'clean'}</span>
    </div>
    <div class="obs-spans">${platformCards || '<p class="field-hint">No platforms returned a result.</p>'}</div>
  </div>`;
}

/**
 * One platform's detail row — used by both the just-run view and Scan History.
 * Shows what was checked (table-level checks the adapter runs: rated factors
 * missing comments, rated assessments missing justification summaries) and,
 * when something's wrong, the specific record, issue, and context — no
 * platform-specific branching, driven entirely by the `platform` string and
 * `findings` array the adapter's own scan reported.
 */
function integrityPlatformCard({ platform, supported, findings, sinceHours }) {
  if (!supported) {
    return `<div class="obs-span">
      <div style="flex:1; min-width:0;">
        <span class="obs-badge ok">not applicable</span> ${escapeHtml(platform)}
        <div class="obs-span-meta">This adapter doesn't implement an integrity scan yet — nothing was checked here.</div>
      </div>
    </div>`;
  }

  const badgeCls = findings.length > 0 ? 'fallback' : 'ok';
  const badgeText = findings.length > 0 ? `${findings.length} finding(s)` : 'clean';
  const windowText = sinceHours !== undefined ? `records updated in the last ${sinceHours}h` : 'recently-updated records';

  const findingsList = findings.length > 0
    ? findings.map(f => `<div class="obs-span-detail-row">⚠️ <strong>${escapeHtml(f.recordType)}</strong> — ${escapeHtml(f.issue)}<br><span class="obs-span-meta">${escapeHtml(f.context)} · record ${escapeHtml(f.recordId)}</span></div>`).join('')
    : `<div class="obs-span-meta" style="margin-top:0.3rem;">Checked ${windowText} for rated factors/controls missing their required narrative (comments, justification summaries) — none found.</div>`;

  return `<div class="obs-span" style="display:block;">
    <div style="display:flex; justify-content:space-between; align-items:baseline; gap:0.75rem;">
      <div><span class="obs-badge ${badgeCls}">${badgeText}</span> ${escapeHtml(platform)}</div>
    </div>
    <div style="margin-top:0.4rem;">${findingsList}</div>
  </div>`;
}

let integrityTraces = [];

async function loadIntegrityHistory() {
  const historyEl = document.getElementById('integrity-history');

  if (isStandaloneMode) {
    historyEl.innerHTML = '<p class="field-hint">Scan history needs a connected backend server (currently in Standalone Simulation Mode).</p>';
    return;
  }

  try {
    const res = await fetch(withInstanceId(`${API_BASE}/observability/traces?kind=integrity-scan&limit=20`));
    const data = await res.json();
    integrityTraces = data.traces || [];

    if (integrityTraces.length === 0) {
      historyEl.innerHTML = '<p class="field-hint">No scan runs recorded yet — click Refresh, or Run Scan Now above.</p>';
      return;
    }

    historyEl.innerHTML = integrityTraces.map(t => {
      // Each platform scanned within this run recorded its own span — see
      // recordSpan('integrity.scan', ...) in backend/src/core/integrity_scan.ts.
      const scanSpans = (t.spans || []).filter(sp => sp.name === 'integrity.scan');

      const platformCards = scanSpans.map(sp => {
        const m = sp.meta || {};
        return integrityPlatformCard({
          platform: m.platform || 'unknown platform',
          supported: m.supported,
          findings: m.findings || [],
          sinceHours: m.sinceHours
        });
      }).join('');

      return `<div class="obs-trace">
        <div class="obs-trace-header" onclick="this.parentElement.classList.toggle('open')">
          <div>
            <div class="obs-trace-title">Integrity Scan</div>
            <div class="obs-trace-sub">${new Date(t.startedAt).toLocaleString()} · ${scanSpans.length} platform(s) · trace ${t.traceId}</div>
          </div>
          <span class="obs-badge ${t.status || 'ok'}">${t.status || '?'}</span>
        </div>
        <div class="obs-spans">${platformCards || '<p class="field-hint">No platform results recorded.</p>'}</div>
      </div>`;
    }).join('');
  } catch (err) {
    historyEl.innerHTML = `<p class="field-hint">Failed to load scan history: ${escapeHtml(err.message)}</p>`;
  }
}

// ============================================================================
// Live Discovery Handler (Universal Schema Discovery Agent)
// ============================================================================
async function handleLiveDiscover() {
  const platformName = document.getElementById('text-live-platform-name').value.trim();
  const entityLabel = document.getElementById('text-live-entity-label').value.trim();
  const runBtn = document.getElementById('btn-live-discover');
  const spinner = document.getElementById('live-discover-spinner');
  const statusEl = document.getElementById('live-discover-status');

  if (!platformName) {
    alert('Please enter a name for the new platform to onboard.');
    return;
  }

  if (isStandaloneMode) {
    statusEl.innerText = 'Live discovery requires a connected backend server (Standalone Simulation Mode is offline).';
    return;
  }

  runBtn.disabled = true;
  spinner.classList.remove('hide');
  statusEl.innerText = 'Introspecting live schema, vector-matching, and confirming with the LLM — this can take a bit longer for large orgs...';

  try {
    const res = await fetch(`${API_BASE}/schema-discovery/live`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId: currentInstanceId, platformName, entityLabel: entityLabel || undefined })
    });
    const data = await res.json();

    if (data.success) {
      statusEl.innerText = `Onboarded '${data.config.platformName}' — ${data.config.tables.length} table(s) mapped, validated: ${data.config.validation.validated}. It now appears in the Agent Sandbox platform dropdown.`;
      const out = document.getElementById('parsed-schema-output');
      out.innerHTML = `<span class="json-string">${syntaxHighlight(JSON.stringify(data.config, null, 2))}</span>`;
      await loadDropdownsLive();
    } else {
      statusEl.innerText = `Live discovery failed: ${data.error}`;
    }
  } catch (err) {
    statusEl.innerText = `Live discovery failed: ${err.message}`;
  } finally {
    runBtn.disabled = false;
    spinner.classList.add('hide');
  }
}

// ============================================================================
// Console Tab Swapper
// ============================================================================
function setupConsoleTabs() {
  const tabBtns = document.querySelectorAll('.c-tab-btn');
  const panes = document.querySelectorAll('.console-pane');
  
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      panes.forEach(p => p.classList.remove('active'));
      
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-target');
      document.getElementById(targetId).classList.add('active');
    });
  });
}

function updateConsolePane(id, content, format = 'json') {
  const pane = document.getElementById(id);
  if (format === 'json') {
    const formatted = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    pane.innerHTML = `<pre><code class="json-code">${syntaxHighlight(formatted)}</code></pre>`;
  } else {
    pane.innerHTML = `<pre><code class="text-code">${content}</code></pre>`;
  }
}

// Simple JSON Syntax Highlighter for premium feel
function syntaxHighlight(json) {
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, function (match) {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
      } else {
        cls = 'json-string';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return `<span class="${cls}">${match}</span>`;
  });
}

// ============================================================================
// Console Flow Animations
// ============================================================================
async function animatePipeline(step) {
  const nodes = ['node-read', 'node-agnostic', 'node-llm', 'node-write'];
  const badge = document.getElementById('pipeline-step');
  
  // Reset all
  nodes.forEach(n => {
    const el = document.getElementById(n);
    el.classList.remove('active', 'processing');
  });
  
  if (step === 'idle') {
    badge.innerText = 'Idle';
    badge.style.background = 'rgba(255, 255, 255, 0.05)';
    badge.style.color = 'var(--text-secondary)';
    return;
  }

  badge.style.background = 'rgba(99, 102, 241, 0.15)';
  badge.style.color = 'var(--accent-purple)';

  if (step >= 1) {
    badge.innerText = '1/4 DB Extraction';
    document.getElementById('node-read').classList.add('active', 'processing');
    await sleep(900);
  }
  if (step >= 2) {
    badge.innerText = '2/4 Translation';
    document.getElementById('node-read').classList.remove('processing');
    document.getElementById('node-agnostic').classList.add('active', 'processing');
    await sleep(950);
  }
  if (step >= 3) {
    badge.innerText = '3/4 Gemini Reasoning';
    document.getElementById('node-agnostic').classList.remove('processing');
    document.getElementById('node-llm').classList.add('active', 'processing');
    await sleep(1500);
  }
  if (step >= 4) {
    badge.innerText = '4/4 DB Writeback';
    document.getElementById('node-llm').classList.remove('processing');
    document.getElementById('node-write').classList.add('active', 'processing');
    await sleep(800);
    document.getElementById('node-write').classList.remove('processing');
    badge.innerText = 'Success';
    badge.style.background = 'rgba(16, 185, 129, 0.15)';
    badge.style.color = 'var(--accent-emerald)';
  }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// Agent Execution Core Handlers
// ============================================================================
async function handleAgentRun() {
  const platform = document.getElementById('select-platform').value;
  const agent = document.getElementById('select-agent').value;
  const targetId = document.getElementById('select-target').value;
  
  const runBtn = document.getElementById('btn-run');
  const spinner = document.getElementById('run-spinner');
  
  runBtn.disabled = true;
  spinner.classList.remove('hide');

  try {
    if (isStandaloneMode) {
      await runLocalAgentSimulation(platform, agent, targetId);
    } else {
      await runLiveAgent(platform, agent, targetId);
    }
  } catch (err) {
    console.error(err);
    alert('Execution encounterd an error. Review logs.');
  } finally {
    runBtn.disabled = false;
    spinner.classList.add('hide');
  }
}

async function runLiveAgent(platform, agent, targetId) {
  // Reset logs
  updateConsolePane('console-raw', { status: 'Fetching database record from live instance...' });
  
  await animatePipeline(1);
  
  const response = await fetch(`${API_BASE}/run-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: currentInstanceId, platform, agent, targetId })
  });
  
  const data = await response.json();
  
  if (!data.success) {
    updateConsolePane('console-writeback', `ERROR: ${data.error}\n\n${(data.logs || []).join('\n')}`, 'text');
    animatePipeline('idle');
    throw new Error(data.error);
  }

  // Stage 2 – show live raw record (use result if localData doesn't have this live ID)
  await animatePipeline(2);
  const localRecord = localData[platform]?.rawRecords?.[targetId];
  const sourceLabel = platform === 'salesforce' ? 'Live Salesforce Org'
    : platform === 'servicenow' ? 'Live ServiceNow PDI'
    : `Live Discovered Platform (${platform})`;
  // Show the actual result data from the server as the "raw" panel
  updateConsolePane('console-raw', localRecord || { instanceId: targetId, source: sourceLabel, result: data.result });

  // Generate agnostic structure based on agent type
  let agnosticTranslation = {};
  let simulatedPrompt = '';
  const isSF = platform === 'salesforce';

  if (agent === 'control-effectiveness') {
    const details = Array.isArray(data.result?.details) ? data.result.details : [];
    agnosticTranslation = {
      agentType: 'ControlEffectivenessAgent',
      assessmentInstanceId: targetId,
      controlsAssessed: details.length,
      results: details.map(d => ({
        control: d.control,
        action: d.action,
        rating: d.rating || d.error || 'N/A'
      }))
    };
    simulatedPrompt = [
      '[WissdaSense — Control Effectiveness Prompt]',
      `Assessment Instance: ${targetId}`,
      isSF
        ? 'Controls fetched from: Risk__Control_Assessment__c, Risk__Risk_Control_Lookup__c (live)'
        : 'Controls fetched from: sn_risk_advanced_risk_assessment_instance_response (live)',
      isSF
        ? 'Test evidence fetched from: grc__Control_Test__c, grc__Control_Test_Result__c (live)'
        : 'Test evidence fetched from: sn_audit_control_test, sn_audit_test_result, sn_grc_issue (live)',
      'Fingerprint check run to detect unchanged controls (carry-forward optimisation)',
      'Gemini asked to rate each control: Satisfactory / Needs Improvement / Weak',
      `Controls queued for AI assessment: ${details.filter(d => d.action !== 'copied').length}`,
      `Controls carried forward (unchanged fingerprint): ${details.filter(d => d.action === 'copied').length}`
    ].join('\n');

  } else if (agent === 'inherent-assessment') {
    const details = Array.isArray(data.result?.details) ? data.result.details : [];
    agnosticTranslation = {
      agentType: 'InherentAssessmentAgent',
      assessmentInstanceId: targetId,
      factorsAssessed: details.length,
      results: details.map(d => ({
        factor: d.factor,
        rating: d.rating || d.error || 'N/A',
        score: d.score
      }))
    };
    simulatedPrompt = [
      '[WissdaSense — Inherent Assessment Prompt]',
      `Assessment Instance: ${targetId}`,
      isSF
        ? 'Answerable factors mapped from: Risk__Risk_Assessment__c fields (live)'
        : 'Answerable factors fetched from: sn_risk_advanced_risk_assessment_instance_response (live)',
      isSF
        ? 'Factor guidance & choice scales defined by: WissdaSense Salesforce Connector (live)'
        : 'Factor guidance & choice scales fetched from: sn_risk_advanced_factor, sn_risk_advanced_factor_choice (live)',
      'Gemini instructed to select rating per factor using official guidance rubric',
      `Factors evaluated: ${details.length}`
    ].join('\n');

  } else {
    // risk-control-mapping
    const liveResult = data.result?.details || data.result || {};
    agnosticTranslation = {
      agentType: 'RiskControlMappingAgent',
      riskId: targetId,
      matchedControls: liveResult.matches || [],
      justification: liveResult.justification || '',
      gaps: liveResult.gaps || '',
      recommendations: liveResult.recommendations || ''
    };
    simulatedPrompt = [
      '[WissdaSense GRC Mapping Prompt]',
      `Risk ID: ${targetId}`,
      isSF
        ? 'Controls retrieved from: grc__Control__c (live, filtered by business unit)'
        : 'Controls retrieved from: sn_compliance_control (live, filtered by entity profile)',
      'Gemini asked to select and rank controls that best mitigate the risk',
      `Controls matched: ${(liveResult.matches || []).length}`
    ].join('\n');
  }

  updateConsolePane('console-translation', agnosticTranslation);

  await animatePipeline(3);
  updateConsolePane('console-prompt', simulatedPrompt, 'text');

  await animatePipeline(4);

  // Build detailed writeback log from real server response
  const writebackHeader = isSF
    ? `[Live Salesforce Mode] Writeback via REST SObject API — ${new Date().toLocaleTimeString()}`
    : `[Live ServiceNow Mode] Writeback via REST Table API — ${new Date().toLocaleTimeString()}`;

  const writebackLines = [
    writebackHeader,
    ...(data.logs || []),
  ];

  if (agent === 'control-effectiveness' || agent === 'inherent-assessment') {
    const details = Array.isArray(data.result?.details) ? data.result.details : [];
    writebackLines.push('');
    writebackLines.push(`[Agent Result] ${data.result?.message || 'Completed'}`);
    details.forEach(d => {
      if (agent === 'control-effectiveness') {
        writebackLines.push(`  ├─ Control: ${d.control} → ${d.action === 'copied' ? '📋 Carried Forward' : '🤖 AI Assessed'} | Rating: ${d.rating || d.error}`);
      } else {
        writebackLines.push(`  ├─ Factor: ${d.factor} → Rating: ${d.rating || d.error} (Score: ${d.score ?? 'N/A'})`);
      }
    });
  } else {
    // risk-control-mapping — rich checklist log
    const d = data.result?.details || {};
    const matches   = Array.isArray(d.matches)  ? d.matches  : [];
    const rejected  = Array.isArray(d.rejected) ? d.rejected : [];
    const total     = d.totalControlsEvaluated ?? (matches.length + rejected.length);
    const entityLabel = d.entityLabel || 'Entity';
    const entityName  = d.entityName  || 'Unknown';

    writebackLines.push('');
    writebackLines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    writebackLines.push(`  CONTROL MAPPING AUDIT LOG`);
    writebackLines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    writebackLines.push(`  ${entityLabel}      : ${entityName}`);
    writebackLines.push(`  Total Evaluated : ${total} controls`);
    writebackLines.push(`  ✅ Selected     : ${matches.length} controls`);
    writebackLines.push(`  ❌ Rejected     : ${rejected.length} controls`);
    writebackLines.push('');

    if (matches.length > 0) {
      writebackLines.push(`✅ SELECTED CONTROLS  (${matches.length}/${total} meet business criteria)`);
      writebackLines.push(`──────────────────────────────────────────────────`);
      matches.forEach((m, i) => {
        writebackLines.push(`  [${i + 1}] ${m.name}`);
        writebackLines.push(`      Category : ${m.category || 'General'}`);
        writebackLines.push(`      Reason   : ${m.reason}`);
        writebackLines.push('');
      });
    }

    if (rejected.length > 0) {
      writebackLines.push(`❌ REJECTED CONTROLS (Grouped by Category)`);
      writebackLines.push(`──────────────────────────────────────────────────`);
      
      const groups = {};
      rejected.forEach(r => {
        const cat = r.category || 'General';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(r);
      });

      Object.keys(groups).sort().forEach(cat => {
        const list = groups[cat];
        writebackLines.push(`  📁 Category: ${cat} (${list.length} control${list.length > 1 ? 's' : ''})`);
        list.forEach(r => {
          writebackLines.push(`    • Control: ${r.name}`);
          writebackLines.push(`      Reason : ${r.reason}`);
        });
        writebackLines.push('');
      });
    }

    writebackLines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    if (d.justification) writebackLines.push(`  OVERALL JUSTIFICATION`);
    if (d.justification) writebackLines.push(`  ${d.justification}`);
    if (d.gaps)          { writebackLines.push(''); writebackLines.push(`  GAPS IDENTIFIED`); writebackLines.push(`  ${d.gaps}`); }
    if (d.recommendations) { writebackLines.push(''); writebackLines.push(`  RECOMMENDATIONS`); writebackLines.push(`  ${d.recommendations}`); }
    writebackLines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  }

  updateConsolePane('console-writeback', writebackLines.filter(l => l !== undefined).join('\n'), 'text');
}



// Client Side Fallback Simulation Engine
async function runLocalAgentSimulation(platform, agent, targetId) {
  const sourceRecord = localData[platform].rawRecords[targetId];
  if (!sourceRecord) {
    alert('Target record configuration missing in local mock database.');
    return;
  }

  // 1. DB Read
  updateConsolePane('console-raw', { status: 'Triggering connection via Platform Adapter...' });
  await animatePipeline(1);
  updateConsolePane('console-raw', sourceRecord);

  // 2. Agnostic Zod Translation
  let agnosticTranslation = {};
  if (agent === 'control-effectiveness') {
    agnosticTranslation = {
      instanceId: targetId,
      controls: (platform === 'servicenow' ? sourceRecord.responses.filter(r => r.control) : sourceRecord.factors.filter(f => f.Control__c))
        .map(c => ({
          controlId: c.control || c.Control__c,
          name: c.control_name || c.Control_Name__c,
          evidenceType: 'Automated Audit Logs',
          issuesCount: platform === 'servicenow' ? 1 : 0
        }))
    };
  } else if (agent === 'inherent-assessment') {
    agnosticTranslation = {
      instanceId: targetId,
      manualFactors: (platform === 'servicenow' ? sourceRecord.responses.filter(r => !r.control) : sourceRecord.factors.filter(f => !f.Control__c))
        .map(f => ({
          factorName: f.factor_name || f.Label__c,
          rubrics: 'Verify data scope, access configuration, and exposure indices.'
        }))
    };
  } else {
    agnosticTranslation = {
      riskId: sourceRecord.sys_id || sourceRecord.Id,
      name: sourceRecord.name || sourceRecord.Name,
      description: sourceRecord.description || sourceRecord.Description__c,
      profileName: sourceRecord.profile_name || sourceRecord.Account_Name__c,
      candidateControls: sourceRecord.controls.map(c => ({
        controlId: c.sys_id || c.Id,
        name: c.name || c.Name__c,
        description: c.description || c.Description__c
      }))
    };
  }

  await animatePipeline(2);
  updateConsolePane('console-translation', agnosticTranslation);

  // 3. Gemini Core Call
  let mockPrompt = '';
  if (agent === 'control-effectiveness') {
    mockPrompt = [
      'You are WissdaSense GRC Core Agent.',
      `Evaluate controls for Risk: ${platform === 'servicenow' ? 'Unauthorized DB Access' : 'S3 Data Leak'}`,
      `Controls: ${JSON.stringify(agnosticTranslation.controls)}`,
      'Rubrics: Choose Satisfactory (No open issues), Needs Improvement (Minor issues), Weak (Failing/critical issues).'
    ].join('\n');
  } else if (agent === 'inherent-assessment') {
    mockPrompt = [
      'You are WissdaSense GRC Inherent Assessment Agent.',
      `Factors to evaluate: ${JSON.stringify(agnosticTranslation.manualFactors)}`,
      'Determine inherent score bands based on industry guides.'
    ].join('\n');
  } else {
    mockPrompt = [
      'You are GRC Risk-Control Mapping Agent.',
      `Target Risk: ${agnosticTranslation.name} - ${agnosticTranslation.description}`,
      `Agnostic Candidates: ${JSON.stringify(agnosticTranslation.candidateControls)}`,
      'Analyze mappings and output valid JSON matrix.'
    ].join('\n');
  }

  await animatePipeline(3);
  updateConsolePane('console-prompt', mockPrompt, 'text');

  // 4. Adapter Write-back
  let logs = [];
  if (platform === 'servicenow') {
    if (agent === 'control-effectiveness') {
      logs = [
        '[ServiceNow DB UPDATE] Querying sn_risk_advanced_risk_assessment_instance_response...',
        '[ServiceNow DB UPDATE] Matching prior fingerprints for "Database Password Rotation" (ctrl_101)...',
        '  └─ FINGERPRINT MATCHED. Carrying forward prior rating: Satisfactory (Zero API tokens spent)',
        '[ServiceNow DB UPDATE] Evaluating "Multi-Factor Authentication" (ctrl_102)...',
        '  └─ Evidence changed: Found open issue ISS001. Rating: Weak',
        '[ServiceNow DB UPDATE] Row resp_401 updated with score: 3 (Satisfactory)',
        '[ServiceNow DB UPDATE] Row resp_402 updated with score: 1 (Weak)'
      ];
    } else if (agent === 'inherent-assessment') {
      logs = [
        '[ServiceNow DB UPDATE] Table [sn_risk_advanced_risk_assessment_instance_response] Factor [Data Sensitivity] -> score: 3 (High)',
        '[ServiceNow DB UPDATE] Table [sn_risk_advanced_risk_assessment_instance_response] Factor [External Threat Exposure] -> score: 2 (Medium)',
        '  └─ Comments: Informed by open issue ISS001 (MFA Bypassed on backup servers).'
      ];
    } else {
      logs = [
        '[ServiceNow DB UPDATE] Querying sn_compliance_control for entity "Core DB Cluster"...',
        '[ServiceNow DB UPDATE] Created 2 rows in [sn_risk_m2m_risk_control] linking to risk_001:',
        '  ├─ Database Password Rotation (ctrl_101) - Mapped',
        '  └─ Multi-Factor Authentication (ctrl_102) - Mapped',
        '[ServiceNow DB UPDATE] Table [sn_risk_risk] row risk_001 -> u_ai_recommendation: [HTML audit trail written]'
      ];
    }
  } else {
    // Salesforce Custom object updates
    if (agent === 'control-effectiveness') {
      logs = [
        '[Salesforce DB UPDATE] Querying Assessment_Factor__c where Assessment__c = sf_asmt_701...',
        '[Salesforce DB UPDATE] Row sf_factor_item_01 (S3 Block Public Policy) -> Score__c: 3 (Satisfactory)',
        '[Salesforce DB UPDATE] Row sf_factor_item_02 (CloudTrail Auditing) -> Score__c: 3 (Satisfactory)',
        '  └─ Audit trail hashes computed and set on Hash__c fields.'
      ];
    } else if (agent === 'inherent-assessment') {
      logs = [
        '[Salesforce DB UPDATE] Row sf_factor_item_03 (Financial Impact Level) -> Score__c: 2 (Medium)',
        '  └─ Comments: Financial scope is internal; estimated damage is $250k.'
      ];
    } else {
      logs = [
        '[Salesforce DB UPDATE] Linked Risk sf_risk_901 to 2 controls in custom mapping table Risk_Control_Mapping__c:',
        '  ├─ S3 Block Public Access Policy (sf_ctrl_801) - Mapped',
        '  └─ CloudTrail Audit Logging (sf_ctrl_802) - Mapped'
      ];
    }
  }

  await animatePipeline(4);
  updateConsolePane('console-writeback', logs.join('\n'), 'text');
}

// ============================================================================
// Schema Discovery / Onboarding Agent Handlers
// ============================================================================
async function handleSchemaParse() {
  const metadataText = document.getElementById('text-metadata').value.trim();
  const runBtn = document.getElementById('btn-parse');
  const spinner = document.getElementById('parse-spinner');
  
  if (!metadataText) {
    alert('Please enter metadata documentation or schema strings to parse.');
    return;
  }

  runBtn.disabled = true;
  spinner.classList.remove('hide');

  const statusLabel = document.getElementById('mapping-status-label');
  statusLabel.className = 'mapping-status';
  statusLabel.innerText = 'AI Discovery Agent working...';

  try {
    if (isStandaloneMode) {
      await sleep(1800); // Simulate network & AI thinking
      const simulatedMapping = simulateSchemaMapping(metadataText);
      
      statusLabel.className = 'mapping-status success';
      statusLabel.innerText = 'Agnostic Mapping Configuration Generated';
      
      const out = document.getElementById('parsed-schema-output');
      out.innerHTML = `<span class="json-string">${syntaxHighlight(JSON.stringify(simulatedMapping, null, 2))}</span>`;
    } else {
      const res = await fetch(`${API_BASE}/schema-discovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: currentInstanceId, rawMetadata: metadataText })
      });
      
      const data = await res.json();
      if (data.success) {
        statusLabel.className = 'mapping-status success';
        statusLabel.innerText = 'Agnostic Mapping Configuration Generated';
        const out = document.getElementById('parsed-schema-output');
        out.innerHTML = `<span class="json-string">${syntaxHighlight(JSON.stringify(data.result, null, 2))}</span>`;
      } else {
        throw new Error(data.error);
      }
    }
  } catch (err) {
    statusLabel.className = 'mapping-status';
    statusLabel.innerText = 'Parsing Failed';
    document.getElementById('parsed-schema-output').innerText = `Error: ${err.message}`;
  } finally {
    runBtn.disabled = false;
    spinner.classList.add('hide');
  }
}

/**
 * Intelligent client-side schema parsing simulator that inspects input text
 * and dynamically extracts table names and columns to produce realistic mappings.
 */
function simulateSchemaMapping(text) {
  // Simple heuristic checks on input
  const isArcher = text.toLowerCase().includes('archer') || text.toLowerCase().includes('arc');
  const isDb = text.toLowerCase().includes('table') || text.toLowerCase().includes('column');
  
  const platformName = isArcher ? 'Archer GRC API v4' : 'Custom GRC DB Schema';
  
  // Default generated table mappings based on raw inputs
  return {
    platformName,
    tables: [
      {
        sourceTableName: isDb ? (text.match(/table:\s*(\w+)/i)?.[1] || 'tbl_grc_risk_master') : 'RiskRegistryObject',
        description: 'Auto-identified as core Risk Registry repository containing threat profiles.',
        targetAgnosticModel: 'Risk',
        fieldMappings: [
          {
            sourceField: text.match(/(uuid|id|key)/i)?.[0] || 'Risk_ID__c',
            sourceType: 'String',
            targetField: 'sysId',
            rationale: 'Unique primary record key mapped to agnostic sysId.'
          },
          {
            sourceField: text.match(/(title|label|name)/i)?.[0] || 'Summary_Title',
            sourceType: 'String',
            targetField: 'name',
            rationale: 'Primary text label describing the risk object.'
          },
          {
            sourceField: text.match(/(desc|details|long)/i)?.[0] || 'Vulnerability_Statement',
            sourceType: 'String',
            targetField: 'description',
            rationale: 'Detailed description explaining the compliance gap or exposure.'
          }
        ]
      },
      {
        sourceTableName: isDb ? 'compliance_control_checklist' : 'ControlLibraryObject',
        description: 'Auto-identified as primary Controls Library carrying mitigation instructions.',
        targetAgnosticModel: 'Control',
        fieldMappings: [
          {
            sourceField: 'Control_Code_Index',
            sourceType: 'String',
            targetField: 'sysId',
            rationale: 'Primary unique reference index for controls catalog.'
          },
          {
            sourceField: 'Mitigating_Activity_Name',
            sourceType: 'String',
            targetField: 'name',
            rationale: 'Short descriptive identifier for security mapping checks.'
          }
        ]
      }
    ]
  };
}
