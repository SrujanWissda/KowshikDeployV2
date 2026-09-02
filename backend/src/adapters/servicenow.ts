import { BaseGRCAdapter } from './base';
import { Risk, Control, TestEvidence, Factor, FactorResponse, Issue } from '../core/models';
import axios from 'axios';
import { AgentTracer } from '../core/tracer';
import { recordSpan } from '../core/observability';

// ============================================================================
// Helper Utilities for Safe Live Field Resolution
// ============================================================================
function getValue(field: any): string {
  if (field === null || field === undefined) return '';
  if (typeof field === 'object') return String(field.value ?? field.display_value ?? '');
  return String(field);
}

function getDisplayValue(field: any): string {
  if (field === null || field === undefined) return '';
  if (typeof field === 'object') return String(field.display_value ?? field.value ?? '');
  return String(field);
}

// ============================================================================
// Mock ServiceNow GlideRecord Database (Simulation Fallback)
// ============================================================================

const sn_grc_profile = [
  { sys_id: 'profile_db_server', name: 'Core DB Cluster', type: 'Database / IT Infrastructure', description: 'Primary relational and NoSQL database clusters storing customer accounts, financial records, and credentials.' },
  { sys_id: 'profile_corp_it', name: 'Corporate IT Infrastructure', type: 'Internal IT / Endpoints', description: 'Workstations, email gateways, identity providers, and corporate network perimeter.' },
  { sys_id: 'profile_fin_ops', name: 'Financial Operations & Billing', type: 'Business Process', description: 'Payment processing, invoice reconciliation, and general ledger operations.' },
  { sys_id: 'profile_cust_support', name: 'Customer Support Operations', type: 'Business Process', description: 'Omnichannel customer support ticketing, call center recording, and customer PII handling.' }
];

const sn_risk_risk: Array<{
  sys_id: string;
  name: string;
  description: string;
  profile: string;
  profile_name: string;
  u_citations?: string;
  u_ai_recommendation?: string;
}> = [
  { sys_id: 'risk_001', name: 'Unauthorized DB Access', description: 'Risk of malicious actors gaining direct access to customer DB records.', profile: 'profile_db_server', profile_name: 'Core DB Cluster', u_citations: 'obl_001,obl_003' },
  { sys_id: 'risk_002', name: 'Phishing Hack Outage', description: 'Employees click phishing links leading to ransomware deployment and service outage.', profile: 'profile_corp_it', profile_name: 'Corporate IT Infrastructure', u_citations: 'obl_002' }
];

const sn_compliance_control = [
  { sys_id: 'ctrl_101', name: 'Database Password Rotation', description: 'Rotate database master keys and connection pool passwords every 90 days.', profile: 'profile_db_server', active: true, category: 'Database Security' },
  { sys_id: 'ctrl_102', name: 'Multi-Factor Authentication', description: 'Enforce MFA for all user logins, including admin shell accesses.', profile: 'profile_db_server', active: true, category: 'Access Control' },
  { sys_id: 'ctrl_103', name: 'Daily Backup Integrity Tests', description: 'Verify integrity of backups daily by mounting on isolated nodes.', profile: 'profile_db_server', active: true, category: 'Backup & Recovery' },
  { sys_id: 'ctrl_104', name: 'Phishing Simulation and Training', description: 'Quarterly campaigns to test and educate users on phishing links.', profile: 'profile_corp_it', active: true, category: 'Security Awareness' }
];

const sn_risk_advanced_risk_assessment_instance = [
  { sys_id: 'inst_301', risk: 'risk_001', state: '1', number: 'RASMT0010001' },
  { sys_id: 'inst_302', risk: 'risk_002', state: '3', number: 'RASMT0010002' }
];

interface ServiceNowResponse {
  sys_id: string;
  assessment_instance_id: string;
  factor: string;
  factor_name: string;
  control: string;
  control_name: string;
  factor_response: string | null;
  qualitative_response: number | null;
  additional_comments: string;
  u_wissda_fingerprint: string | null;
}

const sn_risk_advanced_risk_assessment_instance_response: ServiceNowResponse[] = [
  { sys_id: 'resp_401', assessment_instance_id: 'inst_301', factor: 'fact_ef_01', factor_name: 'Control Effectiveness Factor', control: 'ctrl_101', control_name: 'Database Password Rotation', factor_response: null, qualitative_response: null, additional_comments: '', u_wissda_fingerprint: null },
  { sys_id: 'resp_402', assessment_instance_id: 'inst_301', factor: 'fact_ef_01', factor_name: 'Control Effectiveness Factor', control: 'ctrl_102', control_name: 'Multi-Factor Authentication', factor_response: null, qualitative_response: null, additional_comments: '', u_wissda_fingerprint: null },
  { sys_id: 'resp_403', assessment_instance_id: 'inst_301', factor: 'fact_inh_01', factor_name: 'Data Sensitivity', control: '', control_name: '', factor_response: null, qualitative_response: null, additional_comments: '', u_wissda_fingerprint: null },
  { sys_id: 'resp_404', assessment_instance_id: 'inst_301', factor: 'fact_inh_02', factor_name: 'External Threat Exposure', control: '', control_name: '', factor_response: null, qualitative_response: null, additional_comments: '', u_wissda_fingerprint: null },
  { sys_id: 'resp_405', assessment_instance_id: 'inst_302', factor: 'fact_ef_01', factor_name: 'Control Effectiveness Factor', control: 'ctrl_104', control_name: 'Phishing Simulation and Training', factor_response: null, qualitative_response: null, additional_comments: '', u_wissda_fingerprint: null }
];

const sn_risk_advanced_factor = [
  { sys_id: 'fact_ef_01', name: 'Control Effectiveness Factor', description: 'Degree of mitigation provided by this control.', guidance: 'Select Satisfactory for zero open issues, Needs Improvement for minor open issues, Weak for failing tests.', sys_class_name: 'sn_risk_advanced_manual_factor' },
  { sys_id: 'fact_inh_01', name: 'Data Sensitivity', description: 'Assess the classification level of data handled.', guidance: 'Select High for PII/PCI data, Medium for business internal, Low for public.', sys_class_name: 'sn_risk_advanced_manual_factor' },
  { sys_id: 'fact_inh_02', name: 'External Threat Exposure', description: 'Exposure to public internet endpoints.', guidance: 'Select High if public facing, Medium if VPC only, Low if fully isolated.', sys_class_name: 'sn_risk_advanced_manual_factor' }
];

const sn_risk_advanced_factor_choice = [
  { factor: 'fact_ef_01', display_value: 'Satisfactory', score: 3 },
  { factor: 'fact_ef_01', display_value: 'Needs Improvement', score: 2 },
  { factor: 'fact_ef_01', display_value: 'Weak', score: 1 },
  { factor: 'fact_inh_01', display_value: 'High', score: 3 },
  { factor: 'fact_inh_01', display_value: 'Medium', score: 2 },
  { factor: 'fact_inh_01', display_value: 'Low', score: 1 },
  { factor: 'fact_inh_02', display_value: 'High', score: 3 },
  { factor: 'fact_inh_02', display_value: 'Medium', score: 2 },
  { factor: 'fact_inh_02', display_value: 'Low', score: 1 }
];

const sn_audit_control_test = [
  { sys_id: 'test_501', control: 'ctrl_101', number: 'TEST001', short_description: 'Verify 90-day password rotation script', state: 'Complete', control_effectiveness: 'Effective', status: 'Passed' },
  { sys_id: 'test_502', control: 'ctrl_102', number: 'TEST002', short_description: 'Audit admin console logon logs', state: 'Complete', control_effectiveness: 'Ineffective', status: 'Failed' }
];

const sn_audit_test_result = [
  { u_control_test: 'test_501', u_test_result: 'Password change script executed successfully on all db nodes.', u_testing_date: '2026-06-15' },
  { u_control_test: 'test_502', u_test_result: 'Found 3 admin SSH accounts with MFA bypass active.', u_testing_date: '2026-07-01' }
];

const sn_grc_issue = [
  { sys_id: 'iss_601', parent: 'test_502', item: 'risk_001', short_description: 'MFA bypassed on backup server credentials', state: '1', number: 'ISS001' },
  { sys_id: 'iss_602', parent: 'test_501', item: 'risk_001', short_description: 'DB script missing doc block comments', state: '8', number: 'ISS002' }
];

const sn_risk_m2m_risk_control: Array<{ sn_risk_risk: string, sn_compliance_control: string }> = [];

const sn_compliance_authority_document = [
  { sys_id: 'auth_doc_001', name: 'Basel III Framework', number: 'AD001', type: 'Regulation', description: 'Basel III regulatory framework for banking supervision and capital adequacy.', category: 'Banking' },
  { sys_id: 'auth_doc_002', name: 'GDPR Compliance', number: 'AD002', type: 'Regulation', description: 'General Data Protection Regulation standards for personal data privacy and governance.', category: 'Privacy' },
  { sys_id: 'auth_doc_003', name: 'SOX Section 404', number: 'AD003', type: 'Statute', description: 'Sarbanes-Oxley Act Management Assessment of Internal Controls and financial reporting integrity.', category: 'Financial' }
];

const sn_compliance_citation = [
  { sys_id: 'obl_001', name: 'Customer Data Protection Obligation', description: 'Ensure customer PII and sensitive financial data are encrypted at rest and in transit across all databases and communication pipelines.', reference: 'Section 4.1', document: 'auth_doc_002', sys_created_on: '2026-01-10' },
  { sys_id: 'obl_002', name: 'Data Breach Notification Obligation', description: 'Notify supervisory authorities and affected customers within 72 hours of becoming aware of a personal data breach or reporting failure.', reference: 'Article 33', document: 'auth_doc_002', sys_created_on: '2026-02-15' },
  { sys_id: 'obl_003', name: 'Internal Control Audit Trail Obligation', description: 'Maintain immutable audit trails for financial transaction records, user privilege escalations, and system configuration changes.', reference: 'Section 404(a)', document: 'auth_doc_003', sys_created_on: '2026-03-01' },
  { sys_id: 'obl_004', name: 'Privileged Access & Segregation of Duties Obligation', description: 'Enforce strict role-based access control (RBAC), multi-factor authentication, and separation of duties for all production administration.', reference: 'Basel Section 5.3', document: 'auth_doc_001', sys_created_on: '2026-03-12' },
  { sys_id: 'obl_005', name: 'Third-Party Vendor Risk & SLA Governance', description: 'Conduct mandatory security assessments and continuous compliance monitoring for all external contractors, sub-processors, and cloud service providers.', reference: 'Section 9.4', document: 'auth_doc_001', sys_created_on: '2026-03-20' }
];

// ============================================================================
// ServiceNow Adapter Implementation
// ============================================================================

export class ServiceNowAdapter extends BaseGRCAdapter {
  private useLive: boolean = false;
  private instanceUrl: string = '';
  private authHeader: string = '';
  private instanceId: string = '';

  /**
   * Create adapter for specific ServiceNow instance
   *
   * ISOLATION:
   * - Each adapter instance is tied to ONE instanceId
   * - Credentials are instance-specific
   * - All read/write operations are scoped to this instance only
   *
   * @param instanceId - Unique identifier for this instance (e.g., "instance_001")
   * @param instanceUrl - Full URL to ServiceNow instance (e.g., https://client1.service-now.com)
   * @param apiKey - API key for authentication (Basic auth, not OAuth)
   */
  constructor(
    instanceId: string = 'default',
    instanceUrl: string = '',
    apiKey: string = ''
  ) {
    super();
    this.instanceId = instanceId;

    // ✅ ISOLATION: Use provided credentials, or read from environment variables as fallback
    // This ensures each adapter is completely isolated
    let url = instanceUrl;
    let credentials = apiKey;

    // If no credentials provided, try to read from environment variables
    if (!url || !credentials) {
      if (instanceId === 'default') {
        // Backward compatibility: use legacy env vars
        url = url || process.env.SERVICENOW_INSTANCE_URL || '';

        // Try API key first, then username/password
        credentials = credentials || process.env.SERVICENOW_INSTANCE_KEY || '';
        if (!credentials) {
          const username = process.env.SERVICENOW_INSTANCE_USERNAME || '';
          const password = process.env.SERVICENOW_INSTANCE_PASSWORD || '';
          if (username && password) {
            credentials = `${username}:${password}`;
          }
        }
      } else {
        // Multi-instance mode: extract numeric suffix (e.g., "instance_002" -> "002")
        const envSuffix = instanceId.replace(/^instance_/i, '').toUpperCase();
        url = url || process.env[`SERVICENOW_INSTANCE_${envSuffix}_URL`] || '';

        // Try API key first, then username/password
        credentials = credentials || process.env[`SERVICENOW_INSTANCE_${envSuffix}_KEY`] || '';
        if (!credentials) {
          const username = process.env[`SERVICENOW_INSTANCE_${envSuffix}_USERNAME`] || '';
          const password = process.env[`SERVICENOW_INSTANCE_${envSuffix}_PASSWORD`] || '';
          if (username && password) {
            credentials = `${username}:${password}`;
          }
        }
      }
    }

    this.useLive = !!(url && credentials);
    this.instanceUrl = url;

    if (credentials) {
      // Support two credential formats:
      // 1. API Key: "abc123xyz" → Basic auth as "abc123xyz:x"
      // 2. Username:Password: "admin:password123" → Basic auth as "admin:password123"
      const credentialPair = credentials.includes(':')
        ? credentials  // Already in username:password format
        : `${credentials}:x`;  // API key format, add dummy password

      this.authHeader = 'Basic ' + Buffer.from(credentialPair).toString('base64');
    }

    console.log(`[ADAPTER-DEBUG] Instance: ${instanceId}`);
    console.log(`[ADAPTER-DEBUG]   URL from param: "${instanceUrl}"`);
    console.log(`[ADAPTER-DEBUG]   Credentials from param: "${apiKey ? '***set***' : '(none)'}"`);
    console.log(`[ADAPTER-DEBUG]   Env var URL: "${url}"`);
    console.log(`[ADAPTER-DEBUG]   Env var credentials: "${credentials ? '***set***' : '(none)'}"`);
    console.log(`[ADAPTER-DEBUG]   useLive = ${this.useLive}`);
    console.log(
      `[ServiceNowAdapter] Instance '${instanceId}' initialized. ` +
      `Live mode: ${this.useLive ? 'YES' : 'NO'} (URL: ${this.instanceUrl ? 'configured' : 'missing'})`
    );

    if (!this.useLive) {
      console.warn(
        `[ServiceNowAdapter] Instance '${instanceId}' running in mock mode ` +
        `(missing instanceUrl or credentials). Only fallback data will be served.`
      );
    }
  }

  /**
   * Get instance ID this adapter is bound to
   * Used for audit logging and verification
   */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * Diagnostics: expose connection/mode status for API responses.
   * Lets callers immediately tell if the adapter is live-talking to ServiceNow
   * or serving mock fallback data. Critical for multi-instance debugging — when
   * instance_002 shows "success" but ServiceNow has no output, the FIRST thing
   * to check is adapterDiagnostics.mode === 'mock'.
   */
  getAdapterDiagnostics(): {
    instanceId: string;
    mode: 'live' | 'mock';
    useLive: boolean;
    instanceUrlConfigured: boolean;
    authConfigured: boolean;
  } {
    return {
      instanceId: this.instanceId,
      mode: this.useLive ? 'live' : 'mock',
      useLive: this.useLive,
      instanceUrlConfigured: !!this.instanceUrl,
      authConfigured: !!this.authHeader
    };
  }

  getEntityLabel(): string {
    return 'Entity';
  }

  getPlatformName(): string {
    return 'servicenow';
  }

  // Issues live on the ENTITY, not directly on the risk or via a bare `profile` field on
  // sn_grc_issue — they're linked through sn_grc_m2m_issue_to_entity (the same records
  // shown on the entity's "Downstream Issues" related list), confirmed via System
  // Definition > Dictionary Entries: entity link field = 'entity', issue link field =
  // 'sn_grc_issue' (named after the table it references, not simply 'issue'). Querying
  // sn_grc_issue directly by a `profile=` field (the prior implementation) assumed a
  // direct reference that doesn't reflect how this relationship is actually modeled.
  async getEntityIssues(profileSysId: string): Promise<Array<{ desc: string; state: string; number?: string; priority?: string }>> {
    if (this.useLive) {
      try {
        const links = await this.queryTable<any>('sn_grc_m2m_issue_to_entity', {
          sysparm_query: `entity=${profileSysId}`
        });
        const issueSysIds = Array.from(new Set(links.map(l => getValue(l.sn_grc_issue)).filter(Boolean)));
        if (issueSysIds.length === 0) return [];

        const results = await this.queryTable<any>('sn_grc_issue', {
          sysparm_query: `sys_idIN${issueSysIds.join(',')}^state!=3`,
          sysparm_fields: 'sys_id,short_description,state,number,priority'
        });
        return results.map(r => ({
          desc: getDisplayValue(r.short_description),
          state: getDisplayValue(r.state),
          number: getDisplayValue(r.number),
          priority: getDisplayValue(r.priority) || 'Not set'
        }));
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to fetch live entity issues: ${e.message}`);
      }
    }
    // Mock fallback issues for ServiceNow
    return [
      { desc: 'VPC port security leak detected during security scan', state: 'Open', number: 'IPT0020229', priority: 'High' },
      { desc: 'Missing profiles: GL Accounts', state: 'Open', number: 'IPT0010002', priority: 'Moderate' }
    ];
  }

  private async queryTable<T>(tableName: string, queryParams: Record<string, string> = {}): Promise<T[]> {
    if (!this.instanceUrl || !this.authHeader) {
      throw new Error(
        `[ISOLATION] Instance '${this.instanceId}' ServiceNow credentials or instance URL not configured.`
      );
    }

    let url = this.instanceUrl.endsWith('/') ? this.instanceUrl : `${this.instanceUrl}/`;
    url += `api/now/table/${tableName}`;

    const t0 = Date.now();
    try {
      const response = await axios.get<{ result: T[] }>(url, {
        headers: {
          'Authorization': this.authHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        params: {
          sysparm_display_value: 'all',
          ...queryParams
        },
        timeout: 15000
      });

      const rows = response.data.result || [];
      recordSpan('platform.query', t0, 'ok', {
        platform: 'servicenow',
        instanceId: this.instanceId, // ✅ ISOLATION: Tag every query with instance
        table: tableName,
        query: queryParams.sysparm_query || '',
        rows: rows.length
      });
      return rows;
    } catch (e: any) {
      // ✅ ISOLATION: Sanitize error messages to not leak instance data
      let errDetail = '';
      if (e.response?.status === 401 || e.response?.status === 403) {
        errDetail = 'Authentication failed';
      } else if (e.response?.status === 404) {
        errDetail = 'Resource not found';
      } else if (e.message === 'ECONNREFUSED' || e.message === 'ETIMEDOUT') {
        errDetail = 'Connection timeout';
      } else {
        errDetail = 'Query failed';
      }

      recordSpan('platform.query', t0, 'error', {
        platform: 'servicenow',
        instanceId: this.instanceId, // ✅ ISOLATION: Tag errors with instance
        table: tableName,
        query: queryParams.sysparm_query || '',
        error: errDetail
      });

      throw new Error(
        `[ISOLATION] Instance '${this.instanceId}' ServiceNow queryTable [${tableName}] failed: ${errDetail}`
      );
    }
  }

  /**
   * Instrumented PUT to a ServiceNow table record. Returns the persisted record
   * as ServiceNow echoes it back — callers use this to VERIFY a write actually
   * landed, since ServiceNow has been observed returning 200 while silently
   * dropping specific field values on certain tables (confirmed live: the
   * risk-control m2m links and instance justification fields both did this at
   * different points). A successful HTTP response is not proof of a real write.
   */
  private async putRecord(tableName: string, sysId: string, payload: Record<string, any>): Promise<Record<string, any>> {
    let url = this.instanceUrl.endsWith('/') ? this.instanceUrl : `${this.instanceUrl}/`;
    url += `api/now/table/${tableName}/${sysId}`;
    const t0 = Date.now();
    try {
      const response = await axios.put(url, payload, {
        headers: {
          'Authorization': this.authHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      recordSpan('platform.update', t0, 'ok', { platform: 'servicenow', object: tableName, recordId: sysId });
      return response.data?.result || {};
    } catch (e: any) {
      recordSpan('platform.update', t0, 'error', { platform: 'servicenow', object: tableName, recordId: sysId, error: e.message });
      throw e;
    }
  }

  /** Instrumented POST creating a ServiceNow table record. Returns the created record (see putRecord doc — same verify-don't-trust-the-status-code reasoning). */
  private async postRecord(tableName: string, payload: Record<string, any>): Promise<Record<string, any>> {
    let url = this.instanceUrl.endsWith('/') ? this.instanceUrl : `${this.instanceUrl}/`;
    url += `api/now/table/${tableName}`;
    const t0 = Date.now();
    try {
      const response = await axios.post(url, payload, {
        headers: {
          'Authorization': this.authHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      recordSpan('platform.create', t0, 'ok', { platform: 'servicenow', object: tableName });
      return response.data?.result || {};
    } catch (e: any) {
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      recordSpan('platform.create', t0, 'error', { platform: 'servicenow', object: tableName, error: detail });
      throw new Error(`ServiceNow POST ${tableName} failed: ${detail}`);
    }
  }

  /** True only if every named field is non-empty on the record ServiceNow echoed back from a write. */
  private isVerified(record: Record<string, any>, fields: string[]): boolean {
    return fields.every(f => getValue(record[f]).length > 0);
  }

  async getAllAssessmentInstances(agent?: string): Promise<{ sysId: string; riskSysId: string; riskName: string; state: string }[]> {
    if (this.useLive) {
      try {
        let query = 'ORDERBYDESCsys_created_on';
        if (agent === 'inherent-assessment') {
          query = 'state=2^' + query;
        } else if (agent === 'control-effectiveness') {
          query = 'state=3^' + query;
        }

        const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance', {
          sysparm_fields: 'sys_id,risk,state,sys_created_on',
          sysparm_query: query
        });
        return results.map((r: any) => ({
          sysId: getValue(r.sys_id),
          riskSysId: getValue(r.risk),
          riskName: getDisplayValue(r.risk) || 'Assessment Instance',
          state: getDisplayValue(r.state) || 'Open'
        }));
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Live getAllAssessmentInstances failed, using mock fallback. Error: ${e.message}`);
      }
    }

    // Fallback: mock records
    let filteredMock = sn_risk_advanced_risk_assessment_instance;
    if (agent === 'inherent-assessment') {
      filteredMock = sn_risk_advanced_risk_assessment_instance.filter(i => i.state === '2');
    } else if (agent === 'control-effectiveness') {
      filteredMock = sn_risk_advanced_risk_assessment_instance.filter(i => i.state === '3');
    }

    const stateLabels: Record<string, string> = {
      '0': 'Not Initiated',
      '1': 'Ready to assess',
      '2': 'Inherent assessment',
      '3': 'Control assessment',
      '4': 'Residual assessment',
      '5': 'Respond',
      '6': 'Awaiting approval',
      '7': 'Monitor',
      '8': 'Closed',
      '9': 'Cancelled',
      '10': 'Target assessment'
    };

    return filteredMock.map(i => ({
      sysId: i.sys_id,
      riskSysId: i.risk,
      riskName: sn_risk_risk.find(r => r.sys_id === i.risk)?.name || 'Unknown Risk',
      state: stateLabels[i.state] || 'Open'
    }));
  }

  async getAllRisks(): Promise<Risk[]> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_risk', {
          sysparm_fields: 'sys_id,name,short_description,description,profile,u_citations,sys_created_on',
          sysparm_query: 'ORDERBYDESCsys_created_on'
        });
        return results.map((record: any) => ({
          sysId: getValue(record.sys_id),
          name: getDisplayValue(record.name) || getDisplayValue(record.short_description) || 'Unnamed Risk',
          description: getDisplayValue(record.description),
          profileSysId: getValue(record.profile),
          profileName: getDisplayValue(record.profile) || 'Unknown Entity',
          citations: getValue(record.u_citations) || getValue(record.citations),
          u_citations: getValue(record.u_citations) || getValue(record.citations)
        }));
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Live getAllRisks failed, using mock fallback. Error: ${e.message}`);
      }
    }

    // Fallback: return mock risks
    return sn_risk_risk.map(r => ({
      sysId: r.sys_id,
      name: r.name,
      description: r.description,
      profileSysId: r.profile,
      profileName: r.profile_name,
      citations: r.u_citations || '',
      u_citations: r.u_citations || ''
    }));
  }

  async getRisk(riskSysId: string): Promise<Risk | null> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_risk', { 
          sysparm_query: `sys_id=${riskSysId}`,
          sysparm_fields: 'sys_id,name,short_description,description,profile,u_citations'
        });
        if (results.length > 0) {
          const record = results[0];
          return {
            sysId: getValue(record.sys_id),
            name: getDisplayValue(record.name) || getDisplayValue(record.short_description),
            description: getDisplayValue(record.description),
            profileSysId: getValue(record.profile),
            profileName: getDisplayValue(record.profile) || 'Unknown entity',
            citations: getValue(record.u_citations) || getValue(record.citations),
            u_citations: getValue(record.u_citations) || getValue(record.citations)
          };
        }
        return null;
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Live query failed for getRisk, using fallback. Error: ${e.message}`);
      }
    }

    const record = sn_risk_risk.find(r => r.sys_id === riskSysId);
    if (!record) return null;
    return {
      sysId: record.sys_id,
      name: record.name,
      description: record.description,
      profileSysId: record.profile,
      profileName: record.profile_name,
      citations: record.u_citations || '',
      u_citations: record.u_citations || ''
    };
  }

  async getControlsForEntity(profileSysId: string): Promise<Control[]> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_compliance_control', { 
          sysparm_query: `profile=${profileSysId}^active=true`,
          sysparm_fields: 'sys_id,name,short_description,description,category,profile,active'
        });
        return results.map(c => ({
          sysId: getValue(c.sys_id),
          name: getDisplayValue(c.name) || getDisplayValue(c.short_description),
          description: getDisplayValue(c.description),
          category: getDisplayValue(c.category) || 'General',
          profileSysId: getValue(c.profile),
          active: getValue(c.active) === 'true'
        }));
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Live query failed for getControlsForEntity. Error: ${e.message}`);
      }
    }

    return sn_compliance_control
      .filter(c => c.profile === profileSysId && c.active)
      .map(c => ({
        sysId: c.sys_id,
        name: c.name,
        description: c.description,
        category: c.category || 'General',
        profileSysId: c.profile,
        active: c.active
      }));
  }

  async getAssessmentInstance(instanceSysId: string): Promise<{ sysId: string, riskSysId: string, number?: string } | null> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance', { 
          sysparm_query: `sys_id=${instanceSysId}`,
          sysparm_fields: 'sys_id,risk,number'
        });
        if (results.length > 0) {
          const record = results[0];
          return {
            sysId: getValue(record.sys_id),
            riskSysId: getValue(record.risk),
            number: getValue(record.number)
          };
        }
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to fetch live assessment instance, falling back to mock DB. Error: ${e.message}`);
      }
    }

    const record = sn_risk_advanced_risk_assessment_instance.find(i => i.sys_id === instanceSysId);
    if (!record) return null;
    return {
      sysId: record.sys_id,
      riskSysId: record.risk,
      number: record.number
    };
  }

  async getControlFactorRows(instanceSysId: string): Promise<FactorResponse[]> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance_response', {
          sysparm_query: `assessment_instance_id=${instanceSysId}^controlISNOTEMPTY`,
          sysparm_fields: 'sys_id,factor,control'
        });
        return results.map(r => ({
          sysId: getValue(r.sys_id),
          factorSysId: getValue(r.factor),
          factorName: getDisplayValue(r.factor),
          controlSysId: getValue(r.control),
          controlName: getDisplayValue(r.control)
        }));
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to fetch live control factor responses, falling back to mock DB. Error: ${e.message}`);
      }
    }

    return sn_risk_advanced_risk_assessment_instance_response
      .filter(r => r.assessment_instance_id === instanceSysId && r.control !== '')
      .map(r => ({
        sysId: r.sys_id,
        factorSysId: r.factor,
        factorName: r.factor_name,
        controlSysId: r.control,
        controlName: r.control_name
      }));
  }

  async getAnswerableManualRows(instanceSysId: string): Promise<Factor[]> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance_response', {
          sysparm_query: `assessment_instance_id=${instanceSysId}^controlISEMPTY`,
          sysparm_fields: 'sys_id,factor'
        });
        const factors: Factor[] = [];
        for (const r of results) {
          const fact = await this.getFactorChoices(getValue(r.factor));
          if (fact && fact.choiceList.length > 0) {
            factors.push({
              ...fact,
              sysId: getValue(r.sys_id)
            });
          }
        }
        return factors;
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to fetch live manual rows, falling back to mock DB. Error: ${e.message}`);
      }
    }

    const answerableRows = sn_risk_advanced_risk_assessment_instance_response
      .filter(r => r.assessment_instance_id === instanceSysId && r.control === '');

    const factors: Factor[] = [];
    for (const r of answerableRows) {
      const fact = await this.getFactorChoices(r.factor);
      if (fact && fact.choiceList.length > 0) {
        factors.push({
          ...fact,
          sysId: r.sys_id
        });
      }
    }
    return factors;
  }

  async getFactorChoices(factorSysId: string): Promise<Factor | null> {
    if (this.useLive) {
      try {
        const facts = await this.queryTable<any>('sn_risk_advanced_factor', { 
          sysparm_query: `sys_id=${factorSysId}`,
          sysparm_fields: 'sys_id,name,description,guidance'
        });
        if (facts.length > 0) {
          const fact = facts[0];
          const choices = await this.queryTable<any>('sn_risk_advanced_factor_choice', { 
            sysparm_query: `factor=${factorSysId}`,
            sysparm_fields: 'sys_id,display_value,score,factor'
          });
          const choiceList = choices.map(c => getDisplayValue(c.display_value));
          const choiceMap: Record<string, number> = {};
          choices.forEach(c => {
            choiceMap[getDisplayValue(c.display_value)] = parseInt(getValue(c.score), 10) || 0;
          });

          return {
            sysId: factorSysId,
            factorSysId: factorSysId,
            factorName: getDisplayValue(fact.name),
            factorDesc: getDisplayValue(fact.description),
            guidance: getDisplayValue(fact.guidance),
            choiceList,
            choiceMap
          };
        }
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to fetch live factor choices, falling back to mock DB. Error: ${e.message}`);
      }
    }

    const fact = sn_risk_advanced_factor.find(f => f.sys_id === factorSysId);
    if (!fact) return null;

    const choices = sn_risk_advanced_factor_choice.filter(c => c.factor === factorSysId);
    const choiceList = choices.map(c => c.display_value);
    const choiceMap: Record<string, number> = {};
    choices.forEach(c => {
      choiceMap[c.display_value] = c.score;
    });

    return {
      sysId: factorSysId,
      factorSysId: factorSysId,
      factorName: fact.name,
      factorDesc: fact.description,
      guidance: fact.guidance,
      choiceList,
      choiceMap
    };
  }

  async getControlEvidence(controlSysId: string): Promise<TestEvidence> {
    if (this.useLive) {
      try {
        // 1. Fetch all control tests (1 query)
        const tests = await this.queryTable<any>('sn_audit_control_test', {
          sysparm_query: `control=${controlSysId}`,
          sysparm_fields: 'sys_id,number,short_description,name,state,control_effectiveness,status'
        });

        const testIds = tests.map(t => getValue(t.sys_id)).filter(Boolean);

        // 2. BATCH fetch all results for all tests (1 query instead of N)
        let allResults: any[] = [];
        if (testIds.length > 0) {
          allResults = await this.queryTable<any>('sn_audit_test_result', {
            sysparm_query: `u_control_testIN${testIds.join(',')}`,
            sysparm_fields: 'sys_id,u_control_test,u_test_result,u_testing_date'
          });
        }

        // 3. BATCH fetch all issues for all tests (1 query instead of N)
        let allTestIssues: any[] = [];
        if (testIds.length > 0) {
          allTestIssues = await this.queryTable<any>('sn_grc_issue', {
            sysparm_query: `parentIN${testIds.join(',')}`,
            sysparm_fields: 'sys_id,number,short_description,state,parent'
          });
        }

        // 4. Build results in-memory (no more queries)
        const resultsMap = new Map<string, any>();
        allResults.forEach(r => {
          resultsMap.set(getValue(r.u_control_test), r);
        });

        const issuesMap = new Map<string, any[]>();
        allTestIssues.forEach(iss => {
          const parentId = getValue(iss.parent);
          if (!issuesMap.has(parentId)) issuesMap.set(parentId, []);
          issuesMap.get(parentId)!.push(iss);
        });

        // 5. Construct evidence objects with pre-fetched data
        const evidenceTests: any[] = [];
        for (const test of tests) {
          const testId = getValue(test.sys_id);
          const resultRec = resultsMap.get(testId);
          const testIssues = issuesMap.get(testId) || [];

          const openIssues: Issue[] = testIssues
            .filter(iss => getValue(iss.state) !== '3')
            .map(iss => ({
              sysId: getValue(iss.sys_id),
              number: getDisplayValue(iss.number),
              desc: getDisplayValue(iss.short_description),
              state: getValue(iss.state)
            }));

          const closedIssuesCount = testIssues.filter(iss => getValue(iss.state) === '3').length;

          evidenceTests.push({
            sysId: testId,
            number: getDisplayValue(test.number),
            name: getDisplayValue(test.short_description) || getDisplayValue(test.name) || 'Audit Test Run',
            state: getDisplayValue(test.state),
            effectiveness: getDisplayValue(test.control_effectiveness),
            status: getDisplayValue(test.status),
            latestResult: resultRec ? getDisplayValue(resultRec.u_test_result) : '',
            resultDate: resultRec ? getDisplayValue(resultRec.u_testing_date) : '',
            openIssues,
            closedIssues: closedIssuesCount
          });
        }

        // 6. Fetch issues directly linked to this control record
        const directControlIssues = await this.queryTable<any>('sn_grc_issue', {
          sysparm_query: `item=${controlSysId}`,
          sysparm_fields: 'sys_id,number,short_description,state'
        });
        const directOpenIssues: Issue[] = directControlIssues
          .filter(iss => getValue(iss.state) !== '3')
          .map(iss => ({
            sysId: getValue(iss.sys_id),
            number: getDisplayValue(iss.number),
            desc: getDisplayValue(iss.short_description) || `Issue ${getDisplayValue(iss.number)}`,
            state: getValue(iss.state)
          }));
        const directClosedCount = directControlIssues.filter(iss => getValue(iss.state) === '3').length;

        // 7. Fetch control metadata
        const controls = await this.queryTable<any>('sn_compliance_control', {
          sysparm_query: `sys_id=${controlSysId}`,
          sysparm_fields: 'sys_id,name,active,description'
        });
        const ctrl = controls[0];

        return {
          sysId: controlSysId,
          number: 'CTRL_' + controlSysId.split('_')[1] || 'CTRL',
          name: ctrl ? getDisplayValue(ctrl.name) : 'Control ' + controlSysId,
          state: ctrl && getValue(ctrl.active) === 'true' ? 'Active' : 'Inactive',
          openIssues: directOpenIssues,
          closedIssues: directClosedCount,
          effectiveness: evidenceTests[0]?.effectiveness || 'Unknown',
          status: evidenceTests[0]?.status || 'Unknown',
          latestResult: ctrl ? getDisplayValue(ctrl.description) : '',
          resultDate: '',
          ...({ tests: evidenceTests } as any)
        };
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to fetch live control evidence, falling back to mock DB. Error: ${e.message}`);
      }
    }

    const ctrl = sn_compliance_control.find(c => c.sys_id === controlSysId);
    const name = ctrl ? ctrl.name : '';
    const description = ctrl ? ctrl.description : '';

    const tests = sn_audit_control_test.filter(t => t.control === controlSysId);
    const evidenceTests: any[] = [];

    for (const test of tests) {
      const resultRec = sn_audit_test_result.find(r => r.u_control_test === test.sys_id);
      const testIssues = sn_grc_issue.filter(iss => iss.parent === test.sys_id);
      
      const openIssues: Issue[] = testIssues
        .filter(iss => ['1', '2', '5', '0'].includes(iss.state))
        .map(iss => ({
          sysId: iss.sys_id,
          number: iss.number,
          desc: iss.short_description,
          state: iss.state
        }));

      const closedIssuesCount = testIssues.filter(iss => iss.state === '8').length;

      evidenceTests.push({
        sysId: test.sys_id,
        number: test.number,
        name: test.short_description,
        state: test.state,
        effectiveness: test.control_effectiveness,
        status: test.status,
        latestResult: resultRec?.u_test_result || '',
        resultDate: resultRec?.u_testing_date || '',
        openIssues,
        closedIssues: closedIssuesCount
      });
    }

    return {
      sysId: controlSysId,
      number: 'CTRL_' + controlSysId.split('_')[1],
      name,
      state: ctrl?.active ? 'Active' : 'Inactive',
      openIssues: [],
      closedIssues: 0,
      effectiveness: evidenceTests[0]?.effectiveness || 'Unknown',
      status: evidenceTests[0]?.status || 'Unknown',
      latestResult: description, // baseline description
      resultDate: '',
      ...({ tests: evidenceTests } as any) 
    };
  }

  async getPriorClosedAssessment(riskSysId: string, currentInstanceSysId: string): Promise<{ sysId: string; number: string } | null> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance', {
          sysparm_query: `risk=${riskSysId}^state=8^sys_id!=${currentInstanceSysId}`,
          sysparm_fields: 'sys_id,number'
        });
        if (results.length > 0) {
          return {
            sysId: getValue(results[0].sys_id),
            number: getDisplayValue(results[0].number) || getValue(results[0].sys_id)
          };
        }
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to fetch live prior closed assessment. Error: ${e.message}`);
      }
    }

    if (riskSysId === 'risk_001') {
      return { sysId: 'prior_inst_202', number: 'RASMT_MOCK_202' };
    }
    return null;
  }

  async getPriorControlAnswer(priorInstanceSysId: string, controlSysId: string, factorSysId: string) {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance_response', {
          sysparm_query: `assessment_instance_id=${priorInstanceSysId}^control=${controlSysId}^factor=${factorSysId}`
        });
        if (results.length > 0) {
          const row = results[0];
          return {
            factorResponse: getValue(row.factor_response),
            qualativeResponse: parseInt(getValue(row.qualitative_response), 10) || null,
            comments: getDisplayValue(row.additional_comments),
            fingerprint: getValue(row.u_wissda_fingerprint),
            ratingLabel: getDisplayValue(row.factor_response)
          };
        }
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to fetch live prior control answer. Error: ${e.message}`);
      }
    }

    if (priorInstanceSysId === 'prior_inst_202' && controlSysId === 'ctrl_101') {
      return {
        factorResponse: '3',
        qualativeResponse: 3,
        comments: '🔍 EMA INVESTIGATION\n\nRating: Satisfactory\nConfidence: Grounded\n\nCONCLUSION:\nRotation script works perfectly on all db servers. Zero open issues on record.',
        fingerprint: 'ctrl_101||Rotation script verify~Complete~Effective~Passed~Password change script executed successfully on all db nodes.~2026-06-15~open:0~closed:0',
        ratingLabel: 'Satisfactory'
      };
    }
    return null;
  }

  // --- Write-back Simulations ---

  async writeControlEffectiveness(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    evidenceSummary: string,
    auditTrail: string,
    fingerprint: string
  ): Promise<boolean> {
    if (this.useLive) {
      try {
        const payload: Record<string, any> = {
          factor_response: String(score),
          qualitative_response: score,
          additional_comments: evidenceSummary,
          u_wissda_fingerprint: fingerprint
        };

        // Write audit trail to u_rationale_auditing_purpose if available
        if (auditTrail) {
          payload.u_rationale_auditing_purpose = auditTrail;
        }

        const persisted = await this.putRecord('sn_risk_advanced_risk_assessment_instance_response', rowSysId, payload);
        const verified = this.isVerified(persisted, ['additional_comments']);
        console.log(`[ServiceNow LIVE UPDATE] ${verified ? 'Successfully updated and verified' : 'Wrote but could NOT verify'} response row ${rowSysId} on PDI.`);
        console.log(`[ServiceNow LIVE UPDATE] additional_comments:\n${evidenceSummary}`);
        if (auditTrail) {
          console.log(`[ServiceNow LIVE UPDATE] u_rationale_auditing_purpose:\n${auditTrail}`);
        }
        return verified;
      } catch (e: any) {
        console.warn(`[ServiceNow LIVE UPDATE] Failed to write back to PDI, writing to local mock instead. Error: ${e.message}`);
      }
    }

    console.warn(
      `\n================================================================================\n` +
      `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - writeControlEffectiveness\n` +
      `  ⚠️  This update ONLY affected IN-MEMORY mock data. NOTHING was sent to ServiceNow!\n` +
      `  ⚠️  Row: ${rowSysId}\n` +
      `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
      `================================================================================\n`
    );
    const row = sn_risk_advanced_risk_assessment_instance_response.find(r => r.sys_id === rowSysId);
    if (row) {
      row.factor_response = String(score);
      row.qualitative_response = score as any;
      row.additional_comments = evidenceSummary;
      row.u_wissda_fingerprint = fingerprint;
      console.log(`[ServiceNow DB UPDATE] Table [sn_risk_advanced_risk_assessment_instance_response] row [${rowSysId}]`);
      console.log(`  additional_comments:\n${evidenceSummary}`);
      if (auditTrail) {
        console.log(`  u_rationale_auditing_purpose:\n${auditTrail}`);
      }
      return true;
    }
    return false;
  }

  async writeInherentFactor(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    comment: string,
    auditTrail: string
  ): Promise<boolean> {
    if (this.useLive) {
      try {
        const payload: Record<string, any> = {
          factor_response: String(score),
          qualitative_response: score,
          additional_comments: comment
        };

        if (auditTrail) {
          payload.u_rationale_auditing_purpose = auditTrail;
        }

        const persisted = await this.putRecord('sn_risk_advanced_risk_assessment_instance_response', rowSysId, payload);
        const verified = this.isVerified(persisted, ['additional_comments']);
        console.log(`[ServiceNow LIVE UPDATE] ${verified ? 'Successfully updated and verified' : 'Wrote but could NOT verify'} inherent factor response row ${rowSysId} on PDI.`);
        console.log(`[ServiceNow LIVE UPDATE] additional_comments:\n${comment}`);
        if (auditTrail) {
          console.log(`[ServiceNow LIVE UPDATE] u_rationale_auditing_purpose:\n${auditTrail}`);
        }
        return verified;
      } catch (e: any) {
        console.warn(`[ServiceNow LIVE UPDATE] Failed to write back to PDI, writing to local mock instead. Error: ${e.message}`);
      }
    }

    console.warn(
      `\n================================================================================\n` +
      `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - writeInherentFactor\n` +
      `  ⚠️  This update ONLY affected IN-MEMORY mock data. NOTHING was sent to ServiceNow!\n` +
      `  ⚠️  Row: ${rowSysId}\n` +
      `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
      `================================================================================\n`
    );
    const row = sn_risk_advanced_risk_assessment_instance_response.find(r => r.sys_id === rowSysId);
    if (row) {
      row.factor_response = String(score);
      row.qualitative_response = score as any;
      row.additional_comments = comment;
      console.log(`[ServiceNow DB UPDATE] Table [sn_risk_advanced_risk_assessment_instance_response] row [${rowSysId}]`);
      console.log(`  additional_comments:\n${comment}`);
      if (auditTrail) {
        console.log(`  u_rationale_auditing_purpose:\n${auditTrail}`);
      }
      return true;
    }
    return false;
  }

  async writeRiskControlMapping(
    riskSysId: string,
    matchedControls: Array<{ sysId: string; reason: string }>,
    justification: string,
    gaps: string,
    recommendations: string
  ): Promise<boolean> {
    if (this.useLive) {
      try {
        let allVerified = true;
        for (const ctrl of matchedControls) {
          // If the control object has active === false, skip sending it to avoid triggering the 'Avoid inactive items' Business Rule
          if ((ctrl as any).active === false) {
            console.log(`[ServiceNow LIVE UPDATE] Skipping inactive control ${ctrl.sysId} to comply with Business Rule.`);
            continue;
          }
          const persisted = await this.postRecord('sn_risk_m2m_risk_control', {
            sn_risk_risk: riskSysId,
            sn_compliance_control: ctrl.sysId
          });
          const verified = this.isVerified(persisted, ['sn_risk_risk', 'sn_compliance_control']);
          if (!verified) {
            console.warn(`[ServiceNow LIVE UPDATE] Link for control ${ctrl.sysId} reported success but came back with empty reference fields.`);
            allVerified = false;
          }
        }
        console.log(`[ServiceNow LIVE UPDATE] ${allVerified ? 'Created and verified' : 'Attempted'} risk-control links in sn_risk_m2m_risk_control table.`);
        return allVerified;
      } catch (e: any) {
        console.warn(`[ServiceNow LIVE UPDATE] Failed to write risk control mappings to PDI, updating mock database instead. Error: ${e.message}`);
      }
    }

    console.warn(
      `\n================================================================================\n` +
      `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - writeRiskControlMapping\n` +
      `  ⚠️  This update ONLY affected IN-MEMORY mock data. NOTHING was sent to ServiceNow!\n` +
      `  ⚠️  Risk: ${riskSysId}, Controls: ${matchedControls.length}\n` +
      `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
      `================================================================================\n`
    );

    // Simulate inserting relationships into sn_risk_m2m_risk_control
    matchedControls.forEach(ctrl => {
      const exists = sn_risk_m2m_risk_control.some(m => m.sn_risk_risk === riskSysId && m.sn_compliance_control === ctrl.sysId);
      if (!exists) {
        sn_risk_m2m_risk_control.push({
          sn_risk_risk: riskSysId,
          sn_compliance_control: ctrl.sysId
        });
      }
    });

    console.log(`[ServiceNow DB UPDATE] Created ${matchedControls.length} rows in [sn_risk_m2m_risk_control] linking risk [${riskSysId}]`);
    console.log(`[ServiceNow DB UPDATE] Table [sn_risk_risk] row [${riskSysId}] -> u_ai_recommendation: [HTML summary written]`);
    return true;
  }

  // ── Optional instance-level justification concept (duck-typed) ──────────
  // ServiceNow's advanced risk module carries inherent_justification /
  // control_justification / residual_justification directly on
  // sn_risk_advanced_risk_assessment_instance, plus calculated summary_* rating
  // rollups. Most platforms have no equivalent instance-level narrative field at
  // all, so ControlEffectivenessAgent only calls this when it's present (duck-typed,
  // same convention as finalizeInherentAssessment on the Salesforce side) — there is
  // no abstract base-class requirement to implement it.
  async getInstanceJustificationContext(instanceSysId: string): Promise<{
    inherentJustification: string;
    controlJustification: string;
    calculatedRatings: string[];
  } | null> {
    // The mock DB has no representation of this concept — nothing safe to
    // synthesize from, so treat it the same as "not supported" rather than
    // inventing placeholder narrative data.
    if (!this.useLive) return null;

    try {
      const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance', {
        sysparm_query: `sys_id=${instanceSysId}`
      });
      if (results.length === 0) return null;
      const record = results[0];

      // sysparm_display_value=all (set on every queryTable call) means a field this
      // instance's schema doesn't have is simply absent from the response — getDisplayValue
      // on an undefined property returns '', which reads identically to "field exists but
      // empty". Either way the caller treats it as nothing to report, no error.
      const calculatedRatings: string[] = [];
      const calcFieldLabels: Array<[string, string]> = [
        ['summary_inherent_risk_score', 'inherent rating'],
        ['summary_control_effectiveness_score', 'control effectiveness rating'],
        ['summary_residual_risk_score', 'residual rating']
      ];
      for (const [field, label] of calcFieldLabels) {
        const dv = getDisplayValue(record[field]);
        if (dv) calculatedRatings.push(`${label}: ${dv}`);
      }

      return {
        inherentJustification: getValue(record.inherent_justification),
        controlJustification: getValue(record.control_justification),
        calculatedRatings
      };
    } catch (e: any) {
      console.warn(`[ServiceNowAdapter] Failed to read instance justification context: ${e.message}`);
      return null;
    }
  }

  // ── Optional memory-reuse for RiskControlMappingAgent (duck-typed) ──────
  // sn_risk_m2m_risk_control already holds every existing risk→control link;
  // reading it back lets the agent skip re-deciding controls that are already
  // mapped, instead of burning an LLM call (and creating a duplicate link row)
  // on every re-run. Returns null when unsupported/failed — distinct from an
  // empty Set, which correctly means "supported, but nothing mapped yet".
  async getExistingRiskControlMappings(riskSysId: string): Promise<Set<string> | null> {
    if (!this.useLive) return null; // mock DB has no meaningful representation of this
    try {
      const results = await this.queryTable<any>('sn_risk_m2m_risk_control', {
        sysparm_query: `sn_risk_risk=${riskSysId}`,
        sysparm_fields: 'sn_compliance_control'
      });
      return new Set(results.map(r => getValue(r.sn_compliance_control)).filter(Boolean));
    } catch (e: any) {
      console.warn(`[ServiceNowAdapter] Failed to fetch existing risk-control mappings: ${e.message}`);
      return null;
    }
  }

  // ── Optional Issue Identification Agent support (duck-typed) ────────────
  // Trigger decision (when to call this) lives entirely on the ServiceNow
  // side — a client script the caller writes themselves, e.g. on the risk's
  // state field reaching Monitor — not in this backend. These two methods
  // are what the agent needs once it's told which risk to act on: find the
  // relevant assessment instance, and confirm no issue already exists for it
  // (so an accidental double-call from the trigger script doesn't create a
  // duplicate issue).
  async resolveLatestAssessmentInstance(riskSysId: string): Promise<string | null> {
    if (!this.useLive) return null;
    try {
      // Most recent assessment instance for this risk — the one whose
      // calculated residual rating and approver are relevant right now (a
      // risk can have older, closed assessment cycles too).
      const instances = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance', {
        sysparm_query: `risk=${riskSysId}^ORDERBYDESCsys_created_on`,
        sysparm_fields: 'sys_id'
      });
      return instances.length > 0 ? getValue(instances[0].sys_id) : null;
    } catch (e: any) {
      console.warn(`[ServiceNowAdapter] Failed to resolve latest assessment instance for risk ${riskSysId}: ${e.message}`);
      return null;
    }
  }

  // Returns null (not false) on query failure — distinct from a confirmed
  // "no issue exists" — so the caller can fail closed (skip rather than risk
  // a duplicate) instead of silently guessing either way.
  async hasExistingIssueForAssessment(assessmentInstanceSysId: string): Promise<boolean | null> {
    if (!this.useLive) return false;
    try {
      const existingLinks = await this.queryTable<any>('sn_risk_advanced_m2m_issue_risk_assessment', {
        sysparm_query: `risk_assessment=${assessmentInstanceSysId}`,
        sysparm_fields: 'sys_id'
      });
      return existingLinks.length > 0;
    } catch (e: any) {
      console.warn(`[ServiceNowAdapter] Failed to check for existing issue on assessment ${assessmentInstanceSysId}: ${e.message}`);
      return null;
    }
  }

  // Context needed to draft an issue from an assessment instance already in
  // Monitor status: the platform-calculated residual rating (same
  // summary_residual_risk_score field read by getInstanceJustificationContext)
  // and the assessment's approver — confirmed as the correct "Issue Inputter"
  // source field (approver_user, NOT assessor_user).
  async getIssueDraftContext(assessmentInstanceSysId: string): Promise<{
    residualRatingLabel: string;
    approverUserSysId: string;
    assessmentNumber: string;
  } | null> {
    if (!this.useLive) return null;
    try {
      const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance', {
        sysparm_query: `sys_id=${assessmentInstanceSysId}`,
        sysparm_fields: 'sys_id,number,summary_residual_risk_score,approver_user'
      });
      if (results.length === 0) return null;
      const record = results[0];

      // approver_user is a glide_list (multiple approvers possible) — take
      // the first sys_id as the issue owner.
      const approverRaw = getValue(record.approver_user);
      const approverUserSysId = approverRaw.split(',')[0]?.trim() || '';

      return {
        residualRatingLabel: getDisplayValue(record.summary_residual_risk_score),
        approverUserSysId,
        assessmentNumber: getDisplayValue(record.number)
      };
    } catch (e: any) {
      console.warn(`[ServiceNowAdapter] Failed to read issue draft context: ${e.message}`);
      return null;
    }
  }

  // The 5 configured issue-rating rows (label + remediation timeframe), used
  // to fuzzy-match a residual rating label onto a real sn_grc_issue_rating
  // reference. Note the label field on this table is itself named
  // 'issue_rating' — confirmed via live dictionary lookup, not 'name'.
  async getIssueRatingOptions(): Promise<Array<{ sysId: string; label: string }>> {
    if (!this.useLive) return [];
    try {
      const results = await this.queryTable<any>('sn_grc_issue_rating', {
        sysparm_fields: 'sys_id,issue_rating'
      });
      return results
        .map(r => ({ sysId: getValue(r.sys_id), label: getDisplayValue(r.issue_rating) }))
        .filter(r => r.sysId && r.label);
    } catch (e: any) {
      console.warn(`[ServiceNowAdapter] Failed to fetch issue rating options: ${e.message}`);
      return [];
    }
  }

  // Creates the sn_grc_issue record plus its link back to the originating
  // assessment (sn_risk_advanced_m2m_issue_risk_assessment) — the confirmed
  // junction table already in real production use for issue-to-risk-assessment
  // linking. Each write is independently verified via isVerified, same
  // convention as every other write method (an HTTP 200 is not proof).
  async createRiskIssue(payload: {
    riskSysId: string;
    profileSysId: string;
    assessmentInstanceSysId: string;
    issueRatingSysId: string;
    issueManagerSysId: string;
    rationaleHtml: string;
    shortDescription: string;
    description: string;
  }): Promise<{ verified: boolean; issueSysId: string }> {
    if (!this.useLive) {
      console.warn(
        `\n================================================================================\n` +
        `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - createRiskIssue\n` +
        `  ⚠️  SILENTLY SKIPPED! Issue was NOT created in ServiceNow!\n` +
        `  ⚠️  Risk: ${payload.riskSysId}, Issue: ${payload.shortDescription}\n` +
        `  ⚠️  Returning dummy issueSysId='mock_issue' — nothing exists in live ServiceNow!\n` +
        `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
        `================================================================================\n`
      );
      return { verified: true, issueSysId: 'mock_issue' };
    }

    try {
      const issuePayload: Record<string, any> = {
        classification: '2',                                 // Risk
        // issue_type intentionally omitted — this PDI's choice list deactivated
        // the old numeric values (including '1' "Risk issue") in favor of a
        // string-based taxonomy (Self-Identified, Audit, Regulatory Affairs,
        // etc.) with no single value that fits an AI-agent-created issue.
        // Writing a stale/inactive choice value is silently dropped by
        // ServiceNow, which was failing the write-verification check below.
        issue_source: '4f6b97f6c75200107e299e0703c26031',     // "Risk Assessment" (confirmed sys_id)
        // 'item' (label "Item", references the shared sn_grc_item base table
        // that sn_risk_risk extends) is the actual risk link on an issue —
        // confirmed live: sn_risk_risk records share their sys_id with their
        // sn_grc_item row, so the risk's own sys_id is the correct value here,
        // same identifier used for every other reference to this risk.
        item: payload.riskSysId,
        short_description: payload.shortDescription,
        description: payload.description,
        u_issue_summarize_ema: payload.rationaleHtml
      };
      if (payload.issueRatingSysId) issuePayload.issue_rating = payload.issueRatingSysId;
      if (payload.issueManagerSysId) issuePayload.issue_manager = payload.issueManagerSysId;
      if (payload.profileSysId) issuePayload.profile = payload.profileSysId;
      // NOTE: sn_grc_issue.action_plan / u_action_plan_name are NOT the real
      // action-plan mechanism, despite looking like a plausible single-field
      // target — confirmed by the user. The real "Action Plans" concept is a
      // related child record on sn_grc_task (see createActionPlanTask below),
      // linked back to this issue via its own 'issue' reference field.

      const persisted = await this.postRecord('sn_grc_issue', issuePayload);
      const issueSysId = getValue(persisted.sys_id);

      const requiredFields = ['classification', 'short_description', 'item'];
      if (payload.issueRatingSysId) requiredFields.push('issue_rating');
      if (payload.issueManagerSysId) requiredFields.push('issue_manager');
      const verified = !!issueSysId && this.isVerified(persisted, requiredFields);

      if (!issueSysId) {
        console.warn(`[ServiceNow LIVE UPDATE] Issue creation for risk ${payload.riskSysId} returned no sys_id.`);
        return { verified: false, issueSysId: '' };
      }
      if (!verified) {
        console.warn(`[ServiceNow LIVE UPDATE] Issue ${issueSysId} created but one or more fields could not be verified.`);
      }

      const linkPersisted = await this.postRecord('sn_risk_advanced_m2m_issue_risk_assessment', {
        risk_assessment: payload.assessmentInstanceSysId,
        sn_grc_issue: issueSysId,
        is_issue_new: true,
        is_originator: true
      });
      const linkVerified = this.isVerified(linkPersisted, ['risk_assessment', 'sn_grc_issue']);
      if (!linkVerified) {
        console.warn(`[ServiceNow LIVE UPDATE] Issue ${issueSysId} created but link to assessment ${payload.assessmentInstanceSysId} could not be verified.`);
      }

      console.log(`[ServiceNow LIVE UPDATE] Created issue ${issueSysId} for risk ${payload.riskSysId}${linkVerified ? ' (linked)' : ' (link NOT verified)'}`);
      return { verified: verified && linkVerified, issueSysId };
    } catch (e: any) {
      console.warn(`[ServiceNow LIVE UPDATE] Failed to create issue for risk ${payload.riskSysId}: ${e.message}`);
      return { verified: false, issueSysId: '' };
    }
  }

  // Creates one Action Plan (sn_grc_task, labeled "Action Plans" on the
  // instance, extends the standard Planned Task class) linked back to an
  // issue via its own 'issue' reference field — confirmed live this is a
  // related child record, not a field on sn_grc_issue itself.
  //
  // 'state' and 'assigned_to' are deliberately NOT set here: confirmed live
  // that state is computed by platform logic regardless of what is sent (a
  // literal state=1/"Open" write was silently overridden to "Respond"), and
  // assigned_to silently stayed empty even when set to the same value that
  // DID land in u_action_plan_owner right next to it — most likely an
  // assignment_group-membership validation this task never satisfies. Rather
  // than send values that look controlled but demonstrably aren't, only
  // fields confirmed to actually persist as sent are written.
  async createActionPlanTask(payload: {
    issueSysId: string;
    title: string;
    description: string;
    ownerSysId: string;
    prioritySn: string;
  }): Promise<{ verified: boolean; taskSysId: string }> {
    if (!this.useLive) {
      console.warn(
        `\n================================================================================\n` +
        `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - createActionPlanTask\n` +
        `  ⚠️  SILENTLY SKIPPED! Action Plan Task was NOT created in ServiceNow!\n` +
        `  ⚠️  Issue: ${payload.issueSysId}, Task: ${payload.title}\n` +
        `  ⚠️  Returning dummy taskSysId='mock_task' — nothing exists in live ServiceNow!\n` +
        `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
        `================================================================================\n`
      );
      return { verified: true, taskSysId: 'mock_task' };
    }

    try {
      const taskPayload: Record<string, any> = {
        issue: payload.issueSysId,
        short_description: payload.title,
        description: payload.description
      };
      if (payload.ownerSysId) taskPayload.u_action_plan_owner = payload.ownerSysId;
      if (payload.prioritySn) taskPayload.priority = payload.prioritySn;

      const persisted = await this.postRecord('sn_grc_task', taskPayload);
      const taskSysId = getValue(persisted.sys_id);
      if (!taskSysId) {
        console.warn(`[ServiceNow LIVE UPDATE] Action plan task creation for issue ${payload.issueSysId} returned no sys_id.`);
        return { verified: false, taskSysId: '' };
      }

      const requiredFields = ['issue', 'short_description'];
      if (payload.ownerSysId) requiredFields.push('u_action_plan_owner');
      const verified = this.isVerified(persisted, requiredFields);
      if (!verified) {
        console.warn(`[ServiceNow LIVE UPDATE] Action plan task ${taskSysId} created but one or more fields could not be verified.`);
      }

      console.log(`[ServiceNow LIVE UPDATE] Created action plan task ${taskSysId} for issue ${payload.issueSysId}`);
      return { verified, taskSysId };
    } catch (e: any) {
      console.warn(`[ServiceNow LIVE UPDATE] Failed to create action plan task for issue ${payload.issueSysId}: ${e.message}`);
      return { verified: false, taskSysId: '' };
    }
  }

  async writeControlJustificationSummary(instanceSysId: string, text: string): Promise<boolean> {
    if (!this.useLive) {
      console.warn(
        `\n================================================================================\n` +
        `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - writeControlJustificationSummary\n` +
        `  ⚠️  SILENTLY SKIPPED! control_justification was NOT written to ServiceNow!\n` +
        `  ⚠️  Instance: ${instanceSysId}\n` +
        `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
        `================================================================================\n`
      );
      return true;
    }
    try {
      const persisted = await this.putRecord('sn_risk_advanced_risk_assessment_instance', instanceSysId, { control_justification: text });
      const verified = this.isVerified(persisted, ['control_justification']);
      console.log(`[ServiceNow LIVE UPDATE] ${verified ? 'Wrote and verified' : 'Wrote but could NOT verify'} control_justification on instance ${instanceSysId}.`);
      return verified;
    } catch (e: any) {
      console.warn(`[ServiceNow LIVE UPDATE] Failed to write control_justification: ${e.message}`);
      return false;
    }
  }

  async writeResidualJustification(instanceSysId: string, text: string): Promise<boolean> {
    if (!this.useLive) {
      console.warn(
        `\n================================================================================\n` +
        `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - writeResidualJustification\n` +
        `  ⚠️  SILENTLY SKIPPED! residual_justification was NOT written to ServiceNow!\n` +
        `  ⚠️  Instance: ${instanceSysId}\n` +
        `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
        `================================================================================\n`
      );
      return true;
    }
    try {
      const persisted = await this.putRecord('sn_risk_advanced_risk_assessment_instance', instanceSysId, { residual_justification: text });
      const verified = this.isVerified(persisted, ['residual_justification']);
      console.log(`[ServiceNow LIVE UPDATE] ${verified ? 'Wrote and verified' : 'Wrote but could NOT verify'} residual_justification on instance ${instanceSysId}.`);
      return verified;
    } catch (e: any) {
      console.warn(`[ServiceNow LIVE UPDATE] Failed to write residual_justification: ${e.message}`);
      return false;
    }
  }

  // Instance-level executive narrative for inherent risk factors, symmetric to
  // writeControlJustificationSummary — duck-typed the same way, called by
  // InherentAssessmentAgent once all factors are answered.
  async writeInherentJustificationSummary(instanceSysId: string, text: string): Promise<boolean> {
    if (!this.useLive) {
      console.warn(
        `\n================================================================================\n` +
        `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - writeInherentJustificationSummary\n` +
        `  ⚠️  SILENTLY SKIPPED! inherent_justification was NOT written to ServiceNow!\n` +
        `  ⚠️  Instance: ${instanceSysId}\n` +
        `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
        `================================================================================\n`
      );
      return true;
    }
    try {
      const persisted = await this.putRecord('sn_risk_advanced_risk_assessment_instance', instanceSysId, { inherent_justification: text });
      const verified = this.isVerified(persisted, ['inherent_justification']);
      console.log(`[ServiceNow LIVE UPDATE] ${verified ? 'Wrote and verified' : 'Wrote but could NOT verify'} inherent_justification on instance ${instanceSysId}.`);
      return verified;
    } catch (e: any) {
      console.warn(`[ServiceNow LIVE UPDATE] Failed to write inherent_justification: ${e.message}`);
      return false;
    }
  }

  // Risk-level narrative for RiskControlMappingAgent, duck-typed the same way as
  // the three justification writes above — called uniformly for every outcome
  // (matched, no genuine match, or no controls exist to evaluate), unlike
  // writeRiskControlMapping itself which only fires when there's an actual
  // mapping to persist.
  async writeRiskMappingSummary(riskSysId: string, text: string): Promise<boolean> {
    if (!this.useLive) {
      console.warn(
        `\n================================================================================\n` +
        `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - writeRiskMappingSummary\n` +
        `  ⚠️  SILENTLY SKIPPED! u_ai_recommendation was NOT written to ServiceNow!\n` +
        `  ⚠️  Risk: ${riskSysId}\n` +
        `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
        `================================================================================\n`
      );
      return true;
    }
    try {
      const persisted = await this.putRecord('sn_risk_risk', riskSysId, { u_ai_recommendation: text });
      const verified = this.isVerified(persisted, ['u_ai_recommendation']);
      console.log(`[ServiceNow LIVE UPDATE] ${verified ? 'Wrote and verified' : 'Wrote but could NOT verify'} u_ai_recommendation on risk ${riskSysId}.`);
      return verified;
    } catch (e: any) {
      console.warn(`[ServiceNow LIVE UPDATE] Failed to write u_ai_recommendation: ${e.message}`);
      return false;
    }
  }

  // ── Async integrity scan (duck-typed, called on a schedule, not per-run) ──
  // The synchronous writeVerified() check in agents.ts catches a bad write the
  // instant it happens. This catches DRIFT — a field that was fine right after
  // the write but got cleared by something else afterward (confirmed possible:
  // the inherent_justification clearing bug). Scans recently-touched records
  // for "rated but no rationale" and flags each one directly in the empty
  // field itself, so it surfaces exactly where a reviewer would look for it —
  // no separate alerting channel required to see something's wrong.
  async scanForIntegrityIssues(sinceHours: number): Promise<Array<{ recordId: string; recordType: string; issue: string; context: string }>> {
    const NO_COMMENT_REQUIRED_FACTOR_CLASSES = new Set([
      'sn_risk_advanced_group_factor',
      'sn_risk_advanced_automated_query_factor',
      'sn_risk_advanced_automated_scripted_factor'
    ]);
    if (!this.useLive) return [];
    // Findings are reported for developer/dashboard visibility only — this scan
    // never writes into ServiceNow itself. Earlier it flagged the empty field
    // in-place, but that surfaced developer-facing "please re-run this" text to
    // business users viewing the record, which isn't appropriate for them to see.
    const findings: Array<{ recordId: string; recordType: string; issue: string; context: string }> = [];

    try {
      const responses = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance_response', {
        sysparm_query: `sys_updated_on>=javascript:gs.hoursAgo(${sinceHours})^factor_responseISNOTEMPTY^additional_commentsISEMPTY`,
        sysparm_fields: 'sys_id,factor,assessment_instance_id,factor_response'
      });

      for (const r of responses) {
        const factorId = getValue(r.factor);
        if (!factorId) continue;
        // Exclude factor classes that don't get a human-written comment by design:
        // group/rollup factors (e.g. Likelihood, Impact GRC — computed aggregates),
        // and automated query/scripted factors (e.g. "Design effectiveness
        // implementation of controls" — system-computed, not manually rated).
        // Confirmed live: this instance has 15+ automated-factor responses with a
        // rating and no comment that would otherwise false-positive here.
        const factDefs = await this.queryTable<any>('sn_risk_advanced_factor', { sysparm_query: `sys_id=${factorId}`, sysparm_fields: 'sys_class_name' });
        const factorClass = factDefs[0] ? getValue(factDefs[0].sys_class_name) : '';
        if (NO_COMMENT_REQUIRED_FACTOR_CLASSES.has(factorClass)) continue;

        const rowSysId = getValue(r.sys_id);
        const issue = `Rated (factor_response=${getValue(r.factor_response)}) but additional_comments is empty`;
        findings.push({ recordId: rowSysId, recordType: 'factor-response', issue, context: `factor: ${getDisplayValue(r.factor)}, instance: ${getValue(r.assessment_instance_id)}` });
      }
    } catch (e: any) {
      console.warn(`[ServiceNowAdapter] Integrity scan (response rows) failed: ${e.message}`);
    }

    try {
      const instances = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance', {
        sysparm_query: `sys_updated_on>=javascript:gs.hoursAgo(${sinceHours})`,
        sysparm_fields: 'sys_id,number,inherent_justification,control_justification'
      });

      for (const inst of instances) {
        const instId = getValue(inst.sys_id);

        const ratedInherent = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance_response', {
          sysparm_query: `assessment_instance_id=${instId}^controlISEMPTY^factor_responseISNOTEMPTY`,
          sysparm_fields: 'sys_id', sysparm_limit: '1'
        });
        if (ratedInherent.length > 0 && !getValue(inst.inherent_justification)) {
          const issue = 'Has rated inherent factors but inherent_justification is empty';
          findings.push({ recordId: instId, recordType: 'assessment-instance', issue, context: `instance: ${getDisplayValue(inst.number)}` });
        }

        const ratedControl = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance_response', {
          sysparm_query: `assessment_instance_id=${instId}^controlISNOTEMPTY^factor_responseISNOTEMPTY`,
          sysparm_fields: 'sys_id', sysparm_limit: '1'
        });
        if (ratedControl.length > 0 && !getValue(inst.control_justification)) {
          const issue = 'Has rated controls but control_justification is empty';
          findings.push({ recordId: instId, recordType: 'assessment-instance', issue, context: `instance: ${getDisplayValue(inst.number)}` });
        }
      }
    } catch (e: any) {
      console.warn(`[ServiceNowAdapter] Integrity scan (instances) failed: ${e.message}`);
    }

    return findings;
  }

  async writeFailure(rowSysId: string, reason: string): Promise<void> {
    if (this.useLive) {
      try {
        await this.putRecord('sn_risk_advanced_risk_assessment_instance_response', rowSysId, {
          additional_comments: `❌ Ema assessment failed: ${reason}`
        });
        return;
      } catch (e: any) {
        console.warn(`[ServiceNow LIVE UPDATE] Failed to mark failure on PDI. Error: ${e.message}`);
      }
    }

    console.warn(
      `\n================================================================================\n` +
      `  ⚠️  MOCK-MODE WRITE [Instance: '${this.instanceId}'] - writeFailure\n` +
      `  ⚠️  Failure comment was NOT written to ServiceNow! Only in-memory mock updated.\n` +
      `  ⚠️  Row: ${rowSysId}, Reason: ${reason}\n` +
      `  ⚠️  To fix: ensure SERVICENOW_INSTANCE_${this.instanceId.replace(/^instance_/i, '').toUpperCase()}_URL and _KEY are set in .env\n` +
      `================================================================================\n`
    );
    const row = sn_risk_advanced_risk_assessment_instance_response.find(r => r.sys_id === rowSysId);
    if (row) {
      row.additional_comments = `❌ Ema assessment failed: ${reason}`;
      console.log(`[ServiceNow DB UPDATE] Row [${rowSysId}] marked with error comments`);
    }
  }

  // ============================================================================
  // Observability: Write a trace record to u_ema_audit_trail
  // Gracefully skips (no throw) if:
  //   - Not in live mode (mock environment)
  //   - The table does not exist on the instance (404 from ServiceNow)
  //   - Any other network/auth error
  // This mirrors the RiskInherentAIAssessor._traceFlush pattern from the
  // ServiceNow-side Script Include, adapted for the Vercel backend.
  // ============================================================================
  async writeObservabilityTrace(payload: {
    agentName: string;
    targetId: string;
    outcome: string;
    results: any;
    html?: string;
    riskSysId?: string;
    assessmentNumber?: string;
    summary?: string;
    authorityDocSysId?: string;
    citationSysId?: string;
  }): Promise<void> {
    // CRITICAL FIX: Write to ServiceNow if we have credentials, even if useLive detection failed
    // This ensures audit trail is created for all instances with valid URL + auth header
    const hasCredentials = this.instanceUrl && this.authHeader;

    if (!hasCredentials) {
      // In mock mode, just log to console — no HTTP call needed.
      console.log(`[Ema Observability] ${payload.agentName} | outcome=${payload.outcome} | targetId=${payload.targetId} | MOCK MODE (no credentials for instance '${this.instanceId}')`);
      return;
    }

    try {
      const traceHtml = payload.html || this.buildTraceHtml(payload);
      const postPayload: Record<string, any> = {
        u_name:  payload.agentName,
        u_trace: traceHtml
      };
      // u_ema_audit_summary is a plain string field (max 2000 chars) — no
      // markup, unlike u_trace which is HTML.
      if (payload.summary) {
        postPayload.u_ema_audit_summary = payload.summary.slice(0, 2000);
      }

      if (payload.agentName === 'AuthorityDocumentCitationAgent' || payload.authorityDocSysId) {
        postPayload.u_authority_document = payload.authorityDocSysId || payload.targetId;
      } else if (payload.agentName === 'CitationRiskMappingAgent' || payload.citationSysId) {
        postPayload.u_citation = payload.citationSysId || payload.targetId;
      } else if (payload.agentName === 'RiskControlMappingAgent' || payload.agentName === 'IssueIdentificationAgent') {
        postPayload.u_risk = payload.targetId;
      } else {
        if (payload.riskSysId) {
          postPayload.u_risk = payload.riskSysId;
        }
        if (payload.assessmentNumber) {
          postPayload.u_risk_assessment_number = payload.assessmentNumber;
        }
      }

      try {
        await this.postRecord('u_ema_audit_trail', postPayload);
        console.log(`[Ema Observability] Trace written to u_ema_audit_trail for ${payload.agentName}`);
      } catch (postErr: any) {
        // Fallback: if custom reference fields fail on the table, post core trace
        if (postPayload.u_authority_document || postPayload.u_citation) {
          const fallbackPayload = { ...postPayload };
          delete fallbackPayload.u_authority_document;
          delete fallbackPayload.u_citation;
          await this.postRecord('u_ema_audit_trail', fallbackPayload);
          console.log(`[Ema Observability] Trace written to u_ema_audit_trail (fallback without entity link) for ${payload.agentName}`);
        } else {
          throw postErr;
        }
      }
    } catch (e: any) {
      // 404 = table not present on this instance; any other error = transient.
      // Either way, observability must never block or surface to the user.
      const statusCode = e.response?.status;
      if (statusCode === 404) {
        console.log(`[Ema Observability] u_ema_audit_trail table not found on this instance — skipping trace.`);
      } else {
        console.warn(`[Ema Observability] Failed to write trace: ${e.message}`);
      }
    }
  }

  private buildTraceHtml(payload: { agentName: string; targetId: string; outcome: string; results: any }): string {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const resultsJson = JSON.stringify(payload.results, null, 2)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    return [
      `<b>🔍 Ema Observability Trace</b><br>`,
      `<b>Agent:</b> ${payload.agentName}<br>`,
      `<b>Target ID:</b> ${payload.targetId}<br>`,
      `<b>Outcome:</b> ${payload.outcome}<br>`,
      `<b>Timestamp:</b> ${ts}<br><br>`,
      `<b>Results Summary:</b><br>`,
      `<pre style="font-size:11px;background:#f5f5f5;padding:8px;border-radius:4px;">${resultsJson}</pre>`
    ].join('');
  }

  // ============================================================================
  // Verification layer support (verification_agent.ts) — three narrowly-scoped
  // methods, none of which touch anything the producer agents or their own
  // observability write (writeObservabilityTrace, above) rely on.
  // ============================================================================

  /** Locates the u_ema_audit_trail row a producer agent's run just created, so the
   * verification agent knows which row's u_verification_layer_output to fill in. */
  async findLatestAuditTrailRow(agentName: string, riskAssessmentNumber: string): Promise<string | null> {
    if (!this.useLive) return null;
    try {
      const rows = await this.queryTable<any>('u_ema_audit_trail', {
        sysparm_query: `u_name=${agentName}^u_risk_assessment_number=${riskAssessmentNumber}^ORDERBYDESCsys_created_on`,
        sysparm_fields: 'sys_id',
        sysparm_limit: '1'
      });
      return rows.length > 0 ? getValue(rows[0].sys_id) : null;
    } catch (e: any) {
      console.warn(`[Verification Layer] Failed to locate audit trail row: ${e.message}`);
      return null;
    }
  }

  /** Writes ONLY u_verification_layer_output — the verification agent must never
   * touch u_trace, u_ema_audit_summary, or any other field on this row. */
  async writeVerificationLayerOutput(auditTrailRowSysId: string, html: string): Promise<void> {
    if (!this.useLive) {
      console.log(`[Verification Layer] (mock) would write to ${auditTrailRowSysId}`);
      return;
    }
    try {
      await this.putRecord('u_ema_audit_trail', auditTrailRowSysId, { u_verification_layer_output: html });
      console.log(`[Verification Layer] Wrote verification output to u_ema_audit_trail ${auditTrailRowSysId}`);
    } catch (e: any) {
      console.warn(`[Verification Layer] Failed to write verification output: ${e.message}`);
    }
  }

  /** Reads back what a producer agent actually persisted on a response row — the
   * "claim" the verification agent checks, read fresh rather than trusted from
   * the producer's own in-memory result. */
  async getResponseRowScore(rowSysId: string): Promise<{ score: number | null; comments: string } | null> {
    if (!this.useLive) return null;
    try {
      const rows = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance_response', {
        sysparm_query: `sys_id=${rowSysId}`,
        sysparm_fields: 'qualitative_response,additional_comments'
      });
      if (rows.length === 0) return null;
      const raw = getValue(rows[0].qualitative_response);
      return {
        score: raw ? parseInt(raw, 10) : null,
        comments: getDisplayValue(rows[0].additional_comments) || ''
      };
    } catch (e: any) {
      console.warn(`[Verification Layer] Failed to read response row score: ${e.message}`);
      return null;
    }
  }

  // ── Prioritized Queries: Risk Reference First, Fallback to ALL Records ──
  // 1. If riskSysId is provided, query for records directly referencing the risk (u_risk, risk, item, risk_reference).
  // 2. If no direct records exist, query ALL records and let LLM semantic relevance filter identify related records.

  private mapFinancialEventRow(r: any, isDirect: boolean = false): any {
    return {
      sys_id: getValue(r.sys_id),
      name: getDisplayValue(r.name) || getDisplayValue(r.description),
      description: getDisplayValue(r.description),
      expected_loss: parseFloat(getValue(r.expected_loss)) || 0,
      impact: parseInt(getValue(r.impact), 10) || 0,
      discovered_on: getDisplayValue(r.discovered_on),
      is_direct_link: isDirect
    };
  }

  async getFinancialRiskEvents(riskSysId?: string): Promise<any[]> {
    if (!this.useLive) return [];
    const eventFields = 'sys_id,name,expected_loss,impact,discovered_on,description';
    try {
      if (riskSysId) {
        // Step 1: Query the M2M join table sn_risk_advanced_m2m_event_risk to get linked event sys_ids
        const joinRows = await this.queryTable<any>('sn_risk_advanced_m2m_event_risk', {
          sysparm_fields: 'sys_id,risk,risk_event',
          sysparm_query: `risk=${riskSysId}`,
          sysparm_limit: '100'
        });
        if (joinRows && joinRows.length > 0) {
          // Step 2: Fetch the actual event records by their sys_ids
          const eventIds = joinRows.map((r: any) => getValue(r.risk_event)).filter(Boolean);
          if (eventIds.length > 0) {
            const eventRows = await this.queryTable<any>('sn_risk_advanced_event', {
              sysparm_fields: eventFields,
              sysparm_query: `sys_idIN${eventIds.join(',')}^ORDERBYDESCsys_created_on`,
              sysparm_limit: '100'
            });
            if (eventRows && eventRows.length > 0) {
              return eventRows.map((r: any) => this.mapFinancialEventRow(r, true));
            }
          }
        }
      }
      // Fallback: query all events (unlinked analysis)
      const allRows = await this.queryTable<any>('sn_risk_advanced_event', {
        sysparm_fields: eventFields,
        sysparm_query: 'ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      return (allRows || []).map((r: any) => this.mapFinancialEventRow(r, false));
    } catch {
      return [];
    }
  }

  async getAllFinancialRiskEvents(): Promise<any[]> {
    if (!this.useLive) return [];
    try {
      const rows = await this.queryTable<any>('sn_risk_advanced_event', {
        sysparm_fields: 'sys_id,name,expected_loss,impact,discovered_on,description',
        sysparm_query: 'ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      return (rows || []).map((r: any) => this.mapFinancialEventRow(r, false));
    } catch {
      return [];
    }
  }

  private mapComplianceExamRow(r: any, isDirect: boolean = false): any {
    return {
      sys_id: getValue(r.sys_id),
      name: getDisplayValue(r.u_name) || getDisplayValue(r.name),
      description: getDisplayValue(r.u_description) || getDisplayValue(r.description),
      exam_date: getDisplayValue(r.u_exam_date) || getDisplayValue(r.exam_date),
      regulator_name: getDisplayValue(r.u_regulator_name) || getDisplayValue(r.regulator_name),
      formal_findings: parseInt(getValue(r.u_formal_findings), 10) || 0,
      informal_observations: parseInt(getValue(r.u_informal_observations), 10) || 0,
      status: getDisplayValue(r.u_status) || getDisplayValue(r.status),
      is_direct_link: isDirect
    };
  }

  async getComplianceExams(riskSysId?: string): Promise<any[]> {
    if (!this.useLive) return [];
    const fields = 'sys_id,name,u_name,exam_date,u_exam_date,regulator_name,u_regulator_name,type,u_status,status,u_formal_findings,u_informal_observations,u_description,description,u_risk';
    try {
      if (riskSysId) {
        const directRows = await this.queryTable<any>('sn_compliance_exam', {
          sysparm_fields: fields,
          sysparm_query: `u_risk=${riskSysId}^ORDERBYDESCsys_created_on`,
          sysparm_limit: '100'
        });
        if (directRows && directRows.length > 0) {
          return directRows.map(r => this.mapComplianceExamRow(r, true));
        }
      }
      // If none found from u_risk, query where u_risk is empty, fallback to all records
      const unlinkedRows = await this.queryTable<any>('sn_compliance_exam', {
        sysparm_fields: fields,
        sysparm_query: 'u_riskISEMPTY^ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      if (unlinkedRows && unlinkedRows.length > 0) {
        return unlinkedRows.map(r => this.mapComplianceExamRow(r, false));
      }
      const rows = await this.queryTable<any>('sn_compliance_exam', {
        sysparm_fields: fields,
        sysparm_query: 'ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      return (rows || []).map(r => this.mapComplianceExamRow(r, false));
    } catch {
      return [];
    }
  }

  async getAllComplianceExams(): Promise<any[]> {
    if (!this.useLive) return [];
    try {
      const rows = await this.queryTable<any>('sn_compliance_exam', {
        sysparm_fields: 'sys_id,name,u_name,exam_date,u_exam_date,regulator_name,u_regulator_name,type,u_status,status,u_formal_findings,u_informal_observations,u_description,description',
        sysparm_query: 'ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      return (rows || []).map(r => this.mapComplianceExamRow(r, false));
    } catch {
      return [];
    }
  }

  private mapGrcIssueRow(r: any, isDirect: boolean = false): any {
    return {
      sys_id: getValue(r.sys_id),
      name: getDisplayValue(r.short_description) || getDisplayValue(r.name),
      description: getDisplayValue(r.description) || getDisplayValue(r.short_description),
      severity: getDisplayValue(r.severity) || getDisplayValue(r.priority),
      remediation_status: getDisplayValue(r.remediation_status) || getDisplayValue(r.state),
      due_date: getDisplayValue(r.due_date),
      is_direct_link: isDirect
    };
  }

  async getGrcIssues(riskSysId?: string, examSysIds?: string[]): Promise<any[]> {
    if (!this.useLive) return [];
    const fields = 'sys_id,name,short_description,severity,remediation_status,due_date,description,priority,state,item,u_exam,parent';
    try {
      const results: any[] = [];
      const seenIds = new Set<string>();

      // Priority: Issues linked to the risk's related exams (via u_exam or parent field on sn_grc_issue)
      // Issues are discovered FROM exams, not directly from risk sys_id via item field
      if (examSysIds && examSysIds.length > 0) {
        const examQuery = examSysIds.map(eid => `u_exam=${eid}^ORparent=${eid}`).join('^OR');
        const examIssueRows = await this.queryTable<any>('sn_grc_issue', {
          sysparm_fields: fields,
          sysparm_query: `${examQuery}^ORDERBYDESCsys_created_on`,
          sysparm_limit: '100'
        });
        for (const r of examIssueRows || []) {
          const id = getValue(r.sys_id);
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            results.push(this.mapGrcIssueRow(r, true));
          }
        }
      }

      if (results.length > 0) {
        return results;
      }

      // Fallback: All issues (unlinked analysis — LLM determines relevance)
      const rows = await this.queryTable<any>('sn_grc_issue', {
        sysparm_fields: fields,
        sysparm_query: 'ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      return (rows || []).map((r: any) => this.mapGrcIssueRow(r, false));
    } catch {
      return [];
    }
  }

  async getAllGrcIssues(): Promise<any[]> {
    if (!this.useLive) return [];
    try {
      const rows = await this.queryTable<any>('sn_grc_issue', {
        sysparm_fields: 'sys_id,name,short_description,severity,remediation_status,due_date,description,priority,state',
        sysparm_query: 'ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      return (rows || []).map(r => this.mapGrcIssueRow(r, false));
    } catch {
      return [];
    }
  }

  private mapIncidentRow(r: any, isDirect: boolean = false): any {
    return {
      sys_id: getValue(r.sys_id),
      name: `${getDisplayValue(r.number)}: ${getDisplayValue(r.short_description)}`.trim(),
      short_description: getDisplayValue(r.short_description),
      description: getDisplayValue(r.description),
      incident_type: getDisplayValue(r.incident_type) || getDisplayValue(r.u_type) || getDisplayValue(r.category),
      affected_records: parseInt(getValue(r.affected_records), 10) || 0,
      impact: getDisplayValue(r.impact),
      state: getDisplayValue(r.state),
      is_direct_link: isDirect
    };
  }

  async getIncidents(riskSysId?: string): Promise<any[]> {
    if (!this.useLive) return [];
    const fields = 'sys_id,number,short_description,description,incident_type,u_type,category,affected_records,impact,state,severity,u_risk';
    try {
      if (riskSysId) {
        // Direct link: incidents linked to this risk via u_risk field
        const directRows = await this.queryTable<any>('incident', {
          sysparm_fields: fields,
          sysparm_query: `u_risk=${riskSysId}^ORDERBYDESCsys_created_on`,
          sysparm_limit: '100'
        });
        if (directRows && directRows.length > 0) {
          return directRows.map((r: any) => this.mapIncidentRow(r, true));
        }
      }
      // Fallback: all incidents (unlinked analysis)
      const rows = await this.queryTable<any>('incident', {
        sysparm_fields: fields,
        sysparm_query: 'ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      return (rows || []).map((r: any) => this.mapIncidentRow(r, false));
    } catch {
      return [];
    }
  }

  async getAllIncidents(): Promise<any[]> {
    return this.getIncidents();
  }

  private mapExternalEventRow(r: any, isDirect: boolean = false): any {
    return {
      sys_id: getValue(r.sys_id),
      name: getDisplayValue(r.u_name) || getDisplayValue(r.name),
      event_date: getDisplayValue(r.u_event_date) || getDisplayValue(r.event_date),
      event_type: getDisplayValue(r.u_event_type) || getDisplayValue(r.event_type),
      sentiment: getDisplayValue(r.u_sentiment) || getDisplayValue(r.sentiment),
      media_mention_count: parseInt(getValue(r.u_media_mention) || getValue(r.media_mention_count), 10) || 0,
      impact_scope: getDisplayValue(r.u_impact_scope) || getDisplayValue(r.impact_scope),
      duration_days: parseInt(getValue(r.u_duration_days) || getValue(r.duration_days), 10) || 0,
      status: getDisplayValue(r.u_status) || getDisplayValue(r.status),
      is_direct_link: isDirect
    };
  }

  async getExternalEvents(riskSysId?: string): Promise<any[]> {
    if (!this.useLive) return [];
    const fields = 'sys_id,name,u_name,event_date,u_event_date,event_type,u_event_type,sentiment,u_sentiment,media_mention_count,u_media_mention,impact_scope,u_impact_scope,duration_days,u_duration_days,status,u_status,u_risk';
    try {
      if (riskSysId) {
        const directRows = await this.queryTable<any>('sn_compliance_external_event', {
          sysparm_fields: fields,
          sysparm_query: `u_risk=${riskSysId}^ORDERBYDESCsys_created_on`,
          sysparm_limit: '100'
        });
        if (directRows && directRows.length > 0) {
          return directRows.map(r => this.mapExternalEventRow(r, true));
        }
      }
      // If none found from u_risk, query where u_risk is empty, fallback to all records
      const unlinkedRows = await this.queryTable<any>('sn_compliance_external_event', {
        sysparm_fields: fields,
        sysparm_query: 'u_riskISEMPTY^ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      if (unlinkedRows && unlinkedRows.length > 0) {
        return unlinkedRows.map(r => this.mapExternalEventRow(r, false));
      }
      const rows = await this.queryTable<any>('sn_compliance_external_event', {
        sysparm_fields: fields,
        sysparm_query: 'ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      return (rows || []).map(r => this.mapExternalEventRow(r, false));
    } catch {
      return [];
    }
  }

  async getAllExternalEvents(): Promise<any[]> {
    if (!this.useLive) return [];
    try {
      const rows = await this.queryTable<any>('sn_compliance_external_event', {
        sysparm_fields: 'sys_id,name,u_name,event_date,u_event_date,event_type,u_event_type,sentiment,u_sentiment,media_mention_count,u_media_mention,impact_scope,u_impact_scope,duration_days,u_duration_days,status,u_status',
        sysparm_query: 'ORDERBYDESCsys_created_on',
        sysparm_limit: '100'
      });
      return (rows || []).map(r => this.mapExternalEventRow(r, false));
    } catch {
      return [];
    }
  }

  // ── Authority Document Citation Agent Methods ─────────────────────────

  async getAuthorityDocument(sysId: string): Promise<any> {
    console.log(`[AuthorityDoc] Fetching: ${sysId}, useLive=${this.useLive}`);
    if (this.useLive) {
      const candidateTables = ['sn_compliance_authority_document', 'sn_compliance_document', 'sn_grc_document'];
      for (const table of candidateTables) {
        try {
          const results = await this.queryTable<any>(table, {
            sysparm_query: `sys_id=${sysId}`,
            sysparm_fields: 'sys_id,name,short_description,description,type,number,category'
          });
          if (results && results.length > 0) {
            const record = results[0];
            return {
              sys_id: getValue(record.sys_id),
              sysId: getValue(record.sys_id),
              name: getDisplayValue(record.name) || getDisplayValue(record.short_description) || getDisplayValue(record.number) || 'Unnamed Document',
              number: getDisplayValue(record.number),
              type: getDisplayValue(record.type),
              description: getDisplayValue(record.description) || getDisplayValue(record.short_description),
              category: getDisplayValue(record.category)
            };
          }
        } catch (error: any) {
          console.warn(`[AuthorityDoc] Query ${table} failed: ${error.message}`);
        }
      }
    }

    // Mock fallback
    const mock = sn_compliance_authority_document.find(d => d.sys_id === sysId);
    if (mock) {
      return {
        sys_id: mock.sys_id,
        sysId: mock.sys_id,
        name: mock.name,
        number: mock.number,
        type: mock.type,
        description: mock.description,
        category: mock.category
      };
    }
    return null;
  }

  async getAllAuthorityDocuments(): Promise<any[]> {
    if (this.useLive) {
      const candidateTables = ['sn_compliance_authority_document', 'sn_compliance_document', 'sn_grc_document'];
      for (const table of candidateTables) {
        try {
          const results = await this.queryTable<any>(table, {
            sysparm_fields: 'sys_id,name,short_description,description,type,number,category,sys_created_on',
            sysparm_query: 'ORDERBYDESCsys_created_on'
          });
          if (results && results.length > 0) {
            console.log(`[ServiceNowAdapter] Found ${results.length} live authority documents in ${table}`);
            return results.map((record: any) => ({
              sys_id: getValue(record.sys_id),
              sysId: getValue(record.sys_id),
              name: getDisplayValue(record.name) || getDisplayValue(record.short_description) || getDisplayValue(record.number) || 'Unnamed Document',
              number: getDisplayValue(record.number),
              type: getDisplayValue(record.type),
              description: getDisplayValue(record.description) || getDisplayValue(record.short_description),
              category: getDisplayValue(record.category)
            }));
          }
        } catch (e: any) {
          console.warn(`[ServiceNowAdapter] Live getAllAuthorityDocuments failed on ${table}: ${e.message}`);
        }
      }
    }

    // Fallback: return mock authority documents
    return sn_compliance_authority_document.map(d => ({
      sys_id: d.sys_id,
      sysId: d.sys_id,
      name: d.name,
      number: d.number,
      type: d.type,
      description: d.description,
      category: d.category
    }));
  }

  async getAllObligations(): Promise<any[]> {
    if (this.useLive) {
      const candidateTables = ['sn_compliance_citation', 'sn_compliance_policy_statement', 'sn_compliance_requirement'];
      for (const table of candidateTables) {
        try {
          const results = await this.queryTable<any>(table, {
            sysparm_fields: 'sys_id,name,short_description,description,reference,document,sys_created_on',
            sysparm_query: 'ORDERBYDESCsys_created_on'
          });
          if (results && results.length > 0) {
            console.log(`[ServiceNowAdapter] Found ${results.length} live obligations in ${table}`);
            return results.map((record: any) => ({
              sys_id: getValue(record.sys_id),
              name: getDisplayValue(record.name) || getDisplayValue(record.short_description) || 'Unnamed Obligation',
              description: getDisplayValue(record.description) || getDisplayValue(record.short_description),
              reference: getDisplayValue(record.reference),
              document: getValue(record.document),
              document_name: getDisplayValue(record.document)
            }));
          }
        } catch (e: any) {
          console.warn(`[ServiceNowAdapter] Querying obligations from ${table} failed: ${e.message}`);
        }
      }
    }

    // Mock fallback
    return sn_compliance_citation.map(o => ({
      sys_id: o.sys_id,
      name: o.name,
      description: o.description,
      reference: o.reference,
      document: o.document,
      document_name: sn_compliance_authority_document.find(d => d.sys_id === o.document)?.name || ''
    }));
  }

  async createCitationMapping(authorityDocSysId: string, obligationSysId: string, justification: string): Promise<boolean> {
    if (!this.useLive) {
      const obl = sn_compliance_citation.find(o => o.sys_id === obligationSysId);
      if (obl) {
        obl.document = authorityDocSysId;
      }
      console.log(`[ServiceNow DB UPDATE] Table [sn_compliance_citation] row [${obligationSysId}] -> document mapped to [${authorityDocSysId}]`);
      return true;
    }
    try {
      await this.putRecord('sn_compliance_citation', obligationSysId, {
        document: authorityDocSysId
      });
      return true;
    } catch (e) {
      console.warn(`[ServiceNowAdapter] Failed to create citation mapping: ${(e as Error).message}`);
      return false;
    }
  }

  async createObligation(obligation: { name: string; description: string; document: string; source: string; justification?: string }): Promise<any> {
    if (!this.useLive) {
      const newObl = {
        sys_id: `obl_mock_${Date.now()}`,
        name: obligation.name,
        description: obligation.description,
        document: obligation.document,
        reference: obligation.name,
        sys_created_on: new Date().toISOString()
      };
      sn_compliance_citation.push(newObl);
      console.log(`[ServiceNow DB UPDATE] Created obligation [${obligation.name}] linked to authority doc [${obligation.document}]`);
      return newObl;
    }
    try {
      const result = await this.postRecord('sn_compliance_citation', {
        name: obligation.name,
        description: obligation.description,
        document: obligation.document,
        reference: obligation.name
      });
      return result;
    } catch (e) {
      console.warn(`[ServiceNowAdapter] Failed to create obligation: ${(e as Error).message}`);
      return null;
    }
  }

  async writeAuthorityDocumentSummary(authorityDocSysId: string, narrativeHtml: string): Promise<boolean> {
    if (this.useLive) {
      const candidateTables = ['sn_compliance_authority_document', 'sn_compliance_document', 'sn_grc_document'];
      for (const table of candidateTables) {
        try {
          const persisted = await this.putRecord(table, authorityDocSysId, { u_ai_recommendation: narrativeHtml });
          const verified = this.isVerified(persisted, ['u_ai_recommendation']);
          console.log(`[ServiceNow LIVE UPDATE] ${verified ? 'Wrote and verified' : 'Wrote'} u_ai_recommendation on ${table} ${authorityDocSysId}.`);
          return true;
        } catch (e: any) {
          console.warn(`[ServiceNow LIVE UPDATE] Failed to write u_ai_recommendation on ${table}: ${e.message}`);
        }
      }
      return false;
    }

    console.log(`[ServiceNow DB UPDATE] Table [sn_compliance_authority_document] row [${authorityDocSysId}] -> u_ai_recommendation: [HTML justification summary written]`);
    return true;
  }

  // ── Citation to Risk Mapping Agent Methods (FEM-OC-01 to FEM-OC-06) ───

  async getAllEntities(): Promise<Array<{ sysId: string; name: string; type?: string; description?: string }>> {
    if (this.useLive) {
      const candidateTables = ['sn_grc_profile', 'sn_grc_entity', 'cmdb_ci_business_app'];
      for (const table of candidateTables) {
        try {
          const results = await this.queryTable<any>(table, {
            sysparm_fields: 'sys_id,name,short_description,description,type,sys_class_name',
            sysparm_query: 'ORDERBYname'
          });
          if (results && results.length > 0) {
            console.log(`[ServiceNowAdapter] Found ${results.length} live entities in ${table}`);
            return results.map((record: any) => ({
              sysId: getValue(record.sys_id),
              name: getDisplayValue(record.name) || getDisplayValue(record.short_description) || 'Unnamed Entity',
              type: getDisplayValue(record.type) || getDisplayValue(record.sys_class_name) || 'Business Process',
              description: getDisplayValue(record.description) || getDisplayValue(record.short_description) || ''
            }));
          }
        } catch (e: any) {
          console.warn(`[ServiceNowAdapter] Live getAllEntities failed on ${table}: ${e.message}`);
        }
      }
    }

    // Mock fallback
    return sn_grc_profile.map(e => ({
      sysId: e.sys_id,
      name: e.name,
      type: e.type,
      description: e.description
    }));
  }

  async getCitation(citationSysId: string): Promise<any> {
    if (this.useLive) {
      const candidateTables = ['sn_compliance_citation', 'sn_compliance_policy_statement'];
      for (const table of candidateTables) {
        try {
          const results = await this.queryTable<any>(table, {
            sysparm_query: `sys_id=${citationSysId}`,
            sysparm_fields: 'sys_id,name,short_description,description,reference,document,sys_created_on'
          });
          if (results && results.length > 0) {
            const record = results[0];
            return {
              sys_id: getValue(record.sys_id),
              sysId: getValue(record.sys_id),
              name: getDisplayValue(record.name) || getDisplayValue(record.short_description) || 'Unnamed Citation',
              description: getDisplayValue(record.description) || getDisplayValue(record.short_description),
              reference: getDisplayValue(record.reference),
              document: getValue(record.document),
              document_name: getDisplayValue(record.document)
            };
          }
        } catch (e: any) {
          console.warn(`[ServiceNowAdapter] getCitation query ${table} failed: ${e.message}`);
        }
      }
    }

    // Mock fallback
    const mock = sn_compliance_citation.find(c => c.sys_id === citationSysId);
    if (mock) {
      return {
        sys_id: mock.sys_id,
        sysId: mock.sys_id,
        name: mock.name,
        description: mock.description,
        reference: mock.reference,
        document: mock.document,
        document_name: sn_compliance_authority_document.find(d => d.sys_id === mock.document)?.name || ''
      };
    }
    return null;
  }

  async linkCitationToRisk(riskSysId: string, citationSysId: string, justification: string): Promise<boolean> {
    if (this.useLive) {
      try {
        // FEM-OC-06: Map at the join layer — read existing u_citations, append, deduplicate
        const existing = await this.queryTable<any>('sn_risk_risk', {
          sysparm_query: `sys_id=${riskSysId}`,
          sysparm_fields: 'sys_id,u_citations'
        });
        let currentCitations = '';
        if (existing && existing.length > 0) {
          currentCitations = getValue(existing[0].u_citations);
        }
        const citationSet = new Set(currentCitations.split(',').map(s => s.trim()).filter(Boolean));
        citationSet.add(citationSysId);
        const updatedCitations = Array.from(citationSet).join(',');

        await this.putRecord('sn_risk_risk', riskSysId, {
          u_citations: updatedCitations
        });
        console.log(`[ServiceNow LIVE UPDATE] Risk ${riskSysId} u_citations updated to: ${updatedCitations}`);
        return true;
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to link citation to risk: ${e.message}`);
        return false;
      }
    }

    // Mock mode
    const risk = sn_risk_risk.find(r => r.sys_id === riskSysId);
    if (risk) {
      const citationSet = new Set((risk.u_citations || '').split(',').map(s => s.trim()).filter(Boolean));
      citationSet.add(citationSysId);
      risk.u_citations = Array.from(citationSet).join(',');
      console.log(`[ServiceNow DB UPDATE] Table [sn_risk_risk] row [${riskSysId}] -> u_citations: [${risk.u_citations}]`);
    }
    return true;
  }

  async createRiskForEntity(risk: {
    name: string;
    description: string;
    profileSysId: string;
    citationSysId: string;
    justification?: string;
    draft?: boolean;
    category?: string;
  }): Promise<any> {
    const riskName = risk.draft ? `[DRAFT] ${risk.name}` : risk.name;

    if (this.useLive) {
      try {
        const result = await this.postRecord('sn_risk_risk', {
          name: riskName,
          description: risk.description,
          profile: risk.profileSysId,
          u_citations: risk.citationSysId,
          category: risk.category || 'Regulatory / Compliance'
        });
        console.log(`[ServiceNow LIVE CREATE] Created risk "${riskName}" for entity ${risk.profileSysId} with u_citations=${risk.citationSysId}`);
        return result;
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] Failed to create risk for entity: ${e.message}`);
        return null;
      }
    }

    // Mock mode
    const entityProfile = sn_grc_profile.find(p => p.sys_id === risk.profileSysId);
    const newRisk = {
      sys_id: `risk_draft_${Date.now()}`,
      name: riskName,
      description: risk.description,
      profile: risk.profileSysId,
      profile_name: entityProfile?.name || 'Unknown Entity',
      u_citations: risk.citationSysId
    };
    sn_risk_risk.push(newRisk);
    console.log(`[ServiceNow DB UPDATE] Created ${risk.draft ? 'DRAFT ' : ''}risk [${newRisk.name}] for entity [${entityProfile?.name}] with u_citations=[${risk.citationSysId}]`);
    return newRisk;
  }

  async writeCitationSummary(citationSysId: string, narrativeHtml: string): Promise<boolean> {
    if (this.useLive) {
      const candidateTables = ['sn_compliance_citation', 'sn_compliance_policy_statement'];
      for (const table of candidateTables) {
        try {
          let persisted;
          try {
            persisted = await this.putRecord(table, citationSysId, { u_ai_recommendation: narrativeHtml, comments: narrativeHtml });
          } catch {
            persisted = await this.putRecord(table, citationSysId, { u_ai_recommendation: narrativeHtml });
          }
          const verified = this.isVerified(persisted, ['u_ai_recommendation']);
          console.log(`[ServiceNow LIVE UPDATE] ${verified ? 'Wrote and verified' : 'Wrote'} u_ai_recommendation on ${table} ${citationSysId}.`);
          return true;
        } catch (e: any) {
          console.warn(`[ServiceNow LIVE UPDATE] Failed to write u_ai_recommendation on ${table}: ${e.message}`);
        }
      }
      return false;
    }

    // Mock fallback mode: persist justification narrative on mock citation record
    const mock = sn_compliance_citation.find(c => c.sys_id === citationSysId);
    if (mock) {
      (mock as any).u_ai_recommendation = narrativeHtml;
      (mock as any).comments = narrativeHtml;
    }
    console.log(`[ServiceNow DB UPDATE] Table [sn_compliance_citation] row [${citationSysId}] -> u_ai_recommendation: [HTML justification summary written]`);
    return true;
  }

  // ── Regulatory Decomposition Methods (FEM-RD-01 to FEM-RD-10) ───

  async getAuthorityDocumentDetails(docSysId: string): Promise<{
    sys_id: string;
    name: string;
    number?: string;
    type?: string;
    description: string;
    version?: string;
    source_payload?: string;
  } | null> {
    const doc = await this.getAuthorityDocument(docSysId);
    if (!doc) return null;
    return {
      sys_id: doc.sys_id || doc.sysId || docSysId,
      name: doc.name || 'Unnamed Authority Document',
      number: doc.number || '',
      type: doc.type || 'Regulation',
      description: doc.description || '',
      version: (doc as any).version || (doc as any).u_version || '1.0',
      source_payload: (doc as any).source_payload || (doc as any).u_source_text || doc.description
    };
  }

  async getPreviousDocumentVersion(docSysId: string): Promise<{
    sys_id: string;
    name: string;
    version?: string;
    description: string;
  } | null> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_compliance_authority_document', {
          sysparm_query: `u_previous_version=${docSysId}^ORparent=${docSysId}`,
          sysparm_fields: 'sys_id,name,description,version,u_version'
        });
        if (results && results.length > 0) {
          const r = results[0];
          return {
            sys_id: getValue(r.sys_id),
            name: getDisplayValue(r.name),
            version: getDisplayValue(r.version) || getDisplayValue(r.u_version) || '1.0',
            description: getDisplayValue(r.description)
          };
        }
      } catch (e: any) {
        console.warn(`[ServiceNowAdapter] getPreviousDocumentVersion failed: ${e.message}`);
      }
    }
    return null;
  }

  async saveDecomposedObligations(docSysId: string, obligations: Array<{
    duty: string;
    citation_reference: string;
    proposed_name: string;
    proposed_description: string;
    applicability_proposal: string;
    applicability_rationale: string;
    duplicate_status?: string;
    linked_existing_sys_id?: string;
    change_type?: string;
  }>): Promise<any[]> {
    const saved: any[] = [];

    for (const obl of obligations) {
      if (obl.duplicate_status === 'exact_duplicate' && obl.linked_existing_sys_id) {
        // FEM-RD-05: Link to existing record
        await this.createCitationMapping(docSysId, obl.linked_existing_sys_id, `Linked existing duty: ${obl.duty}`);
        saved.push({ sys_id: obl.linked_existing_sys_id, name: obl.proposed_name, action: 'linked_existing' });
        continue;
      }

      // FEM-RD-02, FEM-RD-03, FEM-RD-07: Create new single-duty obligation
      const justification = `[FEM-RD Duty] ${obl.duty}\n[Hierarchy] ${obl.citation_reference}\n[Applicability] ${obl.applicability_proposal.toUpperCase()}: ${obl.applicability_rationale}`;
      
      const created = await this.createObligation({
        name: obl.proposed_name,
        description: obl.proposed_description,
        document: docSysId,
        source: obl.citation_reference,
        justification
      });

      if (created) {
        saved.push({ ...created, action: 'created' });
      }
    }

    return saved;
  }
}
