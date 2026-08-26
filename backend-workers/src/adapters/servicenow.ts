import { BaseGRCAdapter } from './base';
import { Risk, Control, TestEvidence, Factor, FactorResponse, Issue } from '../core/models';
import axios from 'axios';
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

const sn_risk_risk = [
  { sys_id: 'risk_001', name: 'Unauthorized DB Access', description: 'Risk of malicious actors gaining direct access to customer DB records.', profile: 'profile_db_server', profile_name: 'Core DB Cluster' },
  { sys_id: 'risk_002', name: 'Phishing Hack Outage', description: 'Employees click phishing links leading to ransomware deployment and service outage.', profile: 'profile_corp_it', profile_name: 'Corporate IT Infrastructure' }
];

const sn_compliance_control = [
  { sys_id: 'ctrl_101', name: 'Database Password Rotation', description: 'Rotate database master keys and connection pool passwords every 90 days.', profile: 'profile_db_server', active: true, category: 'Database Security' },
  { sys_id: 'ctrl_102', name: 'Multi-Factor Authentication', description: 'Enforce MFA for all user logins, including admin shell accesses.', profile: 'profile_db_server', active: true, category: 'Access Control' },
  { sys_id: 'ctrl_103', name: 'Daily Backup Integrity Tests', description: 'Verify integrity of backups daily by mounting on isolated nodes.', profile: 'profile_db_server', active: true, category: 'Backup & Recovery' },
  { sys_id: 'ctrl_104', name: 'Phishing Simulation and Training', description: 'Quarterly campaigns to test and educate users on phishing links.', profile: 'profile_corp_it', active: true, category: 'Security Awareness' }
];

const sn_risk_advanced_risk_assessment_instance = [
  { sys_id: 'inst_301', risk: 'risk_001', state: '1' },
  { sys_id: 'inst_302', risk: 'risk_002', state: '3' }
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

// ============================================================================
// ServiceNow Adapter Implementation
// ============================================================================

export class ServiceNowAdapter extends BaseGRCAdapter {
  private useLive: boolean;
  private instanceUrl: string;
  private authHeader: string = '';

  // Workers has no global `process.env` — these come from the caller (Env
  // secrets/vars) instead of being read here directly. `btoa` replaces
  // `Buffer.from(...).toString('base64')`, since it's a native Workers
  // runtime global and needs no nodejs_compat surface for a plain ASCII
  // "username:password" pair.
  constructor(useLive: boolean, instanceUrl: string, username: string, password: string) {
    super();
    this.useLive = useLive;
    this.instanceUrl = instanceUrl;
    if (username && password) {
      this.authHeader = 'Basic ' + btoa(`${username}:${password}`);
    }
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
          sysparm_query: `sys_idIN${issueSysIds.join(',')}^state!=3`
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
      throw new Error('ServiceNow credentials or instance URL not configured.');
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
        platform: 'servicenow', table: tableName,
        query: queryParams.sysparm_query || '', rows: rows.length
      });
      return rows;
    } catch (e: any) {
      recordSpan('platform.query', t0, 'error', {
        platform: 'servicenow', table: tableName,
        query: queryParams.sysparm_query || '', error: e.message
      });
      throw e;
    }
  }

  /** Instrumented PUT to a ServiceNow table record. */
  private async putRecord(tableName: string, sysId: string, payload: Record<string, any>): Promise<void> {
    let url = this.instanceUrl.endsWith('/') ? this.instanceUrl : `${this.instanceUrl}/`;
    url += `api/now/table/${tableName}/${sysId}`;
    const t0 = Date.now();
    try {
      await axios.put(url, payload, {
        headers: {
          'Authorization': this.authHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      recordSpan('platform.update', t0, 'ok', { platform: 'servicenow', object: tableName, recordId: sysId });
    } catch (e: any) {
      recordSpan('platform.update', t0, 'error', { platform: 'servicenow', object: tableName, recordId: sysId, error: e.message });
      throw e;
    }
  }

  /** Instrumented POST creating a ServiceNow table record. */
  private async postRecord(tableName: string, payload: Record<string, any>): Promise<void> {
    let url = this.instanceUrl.endsWith('/') ? this.instanceUrl : `${this.instanceUrl}/`;
    url += `api/now/table/${tableName}`;
    const t0 = Date.now();
    try {
      await axios.post(url, payload, {
        headers: {
          'Authorization': this.authHeader,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
      recordSpan('platform.create', t0, 'ok', { platform: 'servicenow', object: tableName });
    } catch (e: any) {
      recordSpan('platform.create', t0, 'error', { platform: 'servicenow', object: tableName, error: e.message });
      throw e;
    }
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
          sysparm_limit: '200',
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
          sysparm_limit: '50',
          sysparm_fields: 'sys_id,name,short_description,description,profile,sys_created_on',
          sysparm_query: 'sys_created_onONThis week@javascript:gs.beginningOfThisWeek()@javascript:gs.endOfThisWeek()^ORDERBYDESCsys_created_on'
        });
        return results.map((record: any) => ({
          sysId: getValue(record.sys_id),
          name: getDisplayValue(record.name) || getDisplayValue(record.short_description) || 'Unnamed Risk',
          description: getDisplayValue(record.description),
          profileSysId: getValue(record.profile),
          profileName: getDisplayValue(record.profile) || 'Unknown Entity'
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
      profileName: r.profile_name
    }));
  }

  async getRisk(riskSysId: string): Promise<Risk | null> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_risk', { sysparm_query: `sys_id=${riskSysId}` });
        if (results.length > 0) {
          const record = results[0];
          return {
            sysId: getValue(record.sys_id),
            name: getDisplayValue(record.name) || getDisplayValue(record.short_description),
            description: getDisplayValue(record.description),
            profileSysId: getValue(record.profile),
            profileName: getDisplayValue(record.profile) || 'Unknown entity'
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
      profileName: record.profile_name
    };
  }

  async getControlsForEntity(profileSysId: string): Promise<Control[]> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_compliance_control', {
          sysparm_query: `profile=${profileSysId}^active=true`
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

  async getAssessmentInstance(instanceSysId: string): Promise<{ sysId: string, riskSysId: string } | null> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance', { sysparm_query: `sys_id=${instanceSysId}` });
        if (results.length > 0) {
          const record = results[0];
          return {
            sysId: getValue(record.sys_id),
            riskSysId: getValue(record.risk)
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
      riskSysId: record.risk
    };
  }

  async getControlFactorRows(instanceSysId: string): Promise<FactorResponse[]> {
    if (this.useLive) {
      try {
        const results = await this.queryTable<any>('sn_risk_advanced_risk_assessment_instance_response', {
          sysparm_query: `assessment_instance_id=${instanceSysId}^controlISNOTEMPTY`
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
          sysparm_query: `assessment_instance_id=${instanceSysId}^controlISEMPTY`
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
        const facts = await this.queryTable<any>('sn_risk_advanced_factor', { sysparm_query: `sys_id=${factorSysId}` });
        if (facts.length > 0) {
          const fact = facts[0];
          const choices = await this.queryTable<any>('sn_risk_advanced_factor_choice', { sysparm_query: `factor=${factorSysId}` });
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
        // 1. Fetch control tests (sn_audit_control_test linked via control field)
        const tests = await this.queryTable<any>('sn_audit_control_test', {
          sysparm_query: `control=${controlSysId}`
        });

        const evidenceTests: any[] = [];
        for (const test of tests) {
          const testId = getValue(test.sys_id);
          const results = await this.queryTable<any>('sn_audit_test_result', {
            sysparm_query: `u_control_test=${testId}`
          });
          const resultRec = results[0];

          // Issues linked to the test (via parent field)
          const testIssues = await this.queryTable<any>('sn_grc_issue', {
            sysparm_query: `parent=${testId}`
          });

          // An issue is open unless it is in state '3' (Closed Complete)
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

        // 2. Fetch issues directly linked to this control record
        // sn_compliance_control extends sn_grc_item: issues use item=controlSysId
        const directControlIssues = await this.queryTable<any>('sn_grc_issue', {
          sysparm_query: `item=${controlSysId}`
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

        const controls = await this.queryTable<any>('sn_compliance_control', {
          sysparm_query: `sys_id=${controlSysId}`
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
        comments: '🔍 WISSDASENSE INVESTIGATION\n\nRating: Satisfactory\nConfidence: Grounded\n\nCONCLUSION:\nRotation script works perfectly on all db servers. Zero open issues on record.',
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
  ): Promise<void> {
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

        await this.putRecord('sn_risk_advanced_risk_assessment_instance_response', rowSysId, payload);
        console.log(`[ServiceNow LIVE UPDATE] Successfully updated response row ${rowSysId} on PDI.`);
        console.log(`[ServiceNow LIVE UPDATE] additional_comments:\n${evidenceSummary}`);
        if (auditTrail) {
          console.log(`[ServiceNow LIVE UPDATE] u_rationale_auditing_purpose:\n${auditTrail}`);
        }
        return;
      } catch (e: any) {
        console.warn(`[ServiceNow LIVE UPDATE] Failed to write back to PDI, writing to local mock instead. Error: ${e.message}`);
      }
    }

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
    }
  }

  async writeInherentFactor(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    comment: string,
    auditTrail: string
  ): Promise<void> {
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

        await this.putRecord('sn_risk_advanced_risk_assessment_instance_response', rowSysId, payload);
        console.log(`[ServiceNow LIVE UPDATE] Successfully updated inherent factor response row ${rowSysId} on PDI.`);
        console.log(`[ServiceNow LIVE UPDATE] additional_comments:\n${comment}`);
        if (auditTrail) {
          console.log(`[ServiceNow LIVE UPDATE] u_rationale_auditing_purpose:\n${auditTrail}`);
        }
        return;
      } catch (e: any) {
        console.warn(`[ServiceNow LIVE UPDATE] Failed to write back to PDI, writing to local mock instead. Error: ${e.message}`);
      }
    }

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
    }
  }

  async writeRiskControlMapping(
    riskSysId: string,
    matchedControls: Array<{ sysId: string; reason: string }>,
    justification: string,
    gaps: string,
    recommendations: string
  ): Promise<void> {
    if (this.useLive) {
      try {
        for (const ctrl of matchedControls) {
          await this.postRecord('sn_risk_m2m_risk_control', {
            sn_risk_risk: riskSysId,
            sn_compliance_control: ctrl.sysId
          });
        }
        console.log(`[ServiceNow LIVE UPDATE] Created ${matchedControls.length} risk-control links in sn_risk_m2m_risk_control table.`);
        return;
      } catch (e: any) {
        console.warn(`[ServiceNow LIVE UPDATE] Failed to write risk control mappings to PDI, updating mock database instead. Error: ${e.message}`);
      }
    }

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

  async writeControlJustificationSummary(instanceSysId: string, text: string): Promise<void> {
    if (!this.useLive) return;
    try {
      await this.putRecord('sn_risk_advanced_risk_assessment_instance', instanceSysId, { control_justification: text });
      console.log(`[ServiceNow LIVE UPDATE] Wrote control_justification on instance ${instanceSysId}.`);
    } catch (e: any) {
      console.warn(`[ServiceNow LIVE UPDATE] Failed to write control_justification: ${e.message}`);
    }
  }

  async writeResidualJustification(instanceSysId: string, text: string): Promise<void> {
    if (!this.useLive) return;
    try {
      await this.putRecord('sn_risk_advanced_risk_assessment_instance', instanceSysId, { residual_justification: text });
      console.log(`[ServiceNow LIVE UPDATE] Wrote residual_justification on instance ${instanceSysId}.`);
    } catch (e: any) {
      console.warn(`[ServiceNow LIVE UPDATE] Failed to write residual_justification: ${e.message}`);
    }
  }

  // Instance-level executive narrative for inherent risk factors, symmetric to
  // writeControlJustificationSummary — duck-typed the same way, called by
  // InherentAssessmentAgent once all factors are answered.
  async writeInherentJustificationSummary(instanceSysId: string, text: string): Promise<void> {
    if (!this.useLive) return;
    try {
      await this.putRecord('sn_risk_advanced_risk_assessment_instance', instanceSysId, { inherent_justification: text });
      console.log(`[ServiceNow LIVE UPDATE] Wrote inherent_justification on instance ${instanceSysId}.`);
    } catch (e: any) {
      console.warn(`[ServiceNow LIVE UPDATE] Failed to write inherent_justification: ${e.message}`);
    }
  }

  async writeFailure(rowSysId: string, reason: string): Promise<void> {
    if (this.useLive) {
      try {
        await this.putRecord('sn_risk_advanced_risk_assessment_instance_response', rowSysId, {
          additional_comments: `❌ WissdaSense assessment failed: ${reason}`
        });
        return;
      } catch (e: any) {
        console.warn(`[ServiceNow LIVE UPDATE] Failed to mark failure on PDI. Error: ${e.message}`);
      }
    }

    const row = sn_risk_advanced_risk_assessment_instance_response.find(r => r.sys_id === rowSysId);
    if (row) {
      row.additional_comments = `❌ WissdaSense assessment failed: ${reason}`;
      console.log(`[ServiceNow DB UPDATE] Row [${rowSysId}] marked with error comments`);
    }
  }
}
