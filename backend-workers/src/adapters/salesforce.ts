import axios from 'axios';
import { BaseGRCAdapter } from './base';
import { Risk, Control, TestEvidence, Factor, FactorResponse } from '../core/models';
import { recordSpan } from '../core/observability';

// ============================================================================
// Mock Salesforce Custom Objects (Schema Simulation — fallback when LIVE=false)
// ============================================================================

const sf_risks = [
  { Id: 'sf_risk_901', Name: 'Data Leak via S3 Buckets', Description__c: 'Unsecured public S3 buckets containing financial reports.', Account__c: 'act_101', Account_Name__c: 'Cloud Ops & Billing' }
];

const sf_controls = [
  { Id: 'sf_ctrl_801', Name__c: 'S3 Block Public Access Policy', Description__c: 'Enforce AWS Organizations policy to block all public bucket access.', Active__c: true, Account__c: 'act_101', Category__c: 'Cloud Security' },
  { Id: 'sf_ctrl_802', Name__c: 'CloudTrail Audit Logging', Description__c: 'Log all API operations on AWS and review weekly.', Active__c: true, Account__c: 'act_101', Category__c: 'Monitoring & Audit' }
];

const sf_assessments = [
  { Id: 'sf_asmt_701', Risk__c: 'sf_risk_901', Status__c: 'In Progress' }
];

const sf_assessment_factors = [
  // Effectiveness Factors
  { Id: 'sf_factor_item_01', Assessment__c: 'sf_asmt_701', Label__c: 'Control Mitigating Action', Control__c: 'sf_ctrl_801', Control_Name__c: 'S3 Block Public Access Policy', Score__c: null, Comments__c: '', Hash__c: '' },
  { Id: 'sf_factor_item_02', Assessment__c: 'sf_asmt_701', Label__c: 'Control Mitigating Action', Control__c: 'sf_ctrl_802', Control_Name__c: 'CloudTrail Audit Logging', Score__c: null, Comments__c: '', Hash__c: '' },
  // Standalone inherent factors
  { Id: 'sf_factor_item_03', Assessment__c: 'sf_asmt_701', Label__c: 'Financial Impact Level', Control__c: '', Control_Name__c: '', Score__c: null, Comments__c: '', Hash__c: '' }
];

const sf_factor_metadata = {
  'Financial Impact Level': {
    guidance: 'High is >$500k loss potential, Medium is $100k-$500k, Low is <$100k.',
    choices: ['High', 'Medium', 'Low'],
    scores: { High: 3, Medium: 2, Low: 1 }
  },
  'Control Mitigating Action': {
    guidance: 'Evaluate the strength of the controls. Choices are Satisfactory, Needs Work, or Ineffective.',
    choices: ['Satisfactory', 'Needs Work', 'Ineffective'],
    scores: { Satisfactory: 3, 'Needs Work': 2, Ineffective: 1 }
  }
};

const sf_control_mappings: Array<{ Risk__c: string, Control__c: string }> = [];

// ============================================================================
// Salesforce Adapter Implementation
// ============================================================================

export class SalesforceAdapter extends BaseGRCAdapter {
  private useLive: boolean;
  private instanceUrl: string;
  private clientId: string;
  private clientSecret: string;
  private cachedToken: string | null = null;
  private tokenExpiry: number = 0;
  // Cache of scoring category IDs keyed by category name (fetched once per session)
  private scoringCategoryCache: Map<string, string> = new Map();

  // Workers has no global `process.env` — these come from the caller (Env
  // secrets/vars) instead of being read here directly.
  constructor(useLive: boolean, instanceUrl: string, clientId: string, clientSecret: string) {
    super();
    this.instanceUrl = (instanceUrl || '').replace(/\/$/, '');
    this.clientId = clientId || '';
    this.clientSecret = clientSecret || '';

    if (useLive && this.instanceUrl && this.clientId) {
      this.useLive = true;
      console.log(`[SalesforceAdapter] Configured in LIVE mode for instance: ${this.instanceUrl}`);
    } else if (useLive) {
      console.warn('[SalesforceAdapter] LIVE mode requested but credentials are incomplete. Falling back to mock.');
      this.useLive = false;
    } else {
      this.useLive = false;
      console.log('[SalesforceAdapter] Running in MOCK/SIMULATION mode.');
    }
  }

  getEntityLabel(): string {
    return 'Business Unit';
  }

  getPlatformName(): string {
    return 'salesforce';
  }

  async getEntityIssues(profileSysId: string): Promise<Array<{ desc: string; state: string; number?: string }>> {
    if (this.useLive) {
      try {
        const results = await this.querySOQL<any>(
          `SELECT Id, Name, grc__ID__c, grc__Status__c, grc__Description__c FROM grc__Issue__c WHERE grc__Responsible_Business_Unit__c = '${profileSysId}' AND grc__Status__c != 'Closed'`
        );
        return results.map(r => ({
          desc: r.grc__Description__c || r.Name || 'Unspecified issue',
          state: r.grc__Status__c || 'Open',
          number: r.grc__ID__c || r.Name
        }));
      } catch (e: any) {
        console.warn(`[SalesforceAdapter] Failed to fetch live entity issues: ${e.message}`);
      }
    }
    // Mock fallback issues for Salesforce
    return [
      { desc: 'VPC port security leak detected during security scan', state: 'Open', number: 'I-00169' }
    ];
  }

  // --------------------------------------------------------------------------
  // OAuth 2.0 Client Credentials Token Retrieval
  // --------------------------------------------------------------------------
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiry) {
      return this.cachedToken;
    }

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', this.clientId);
    params.append('client_secret', this.clientSecret);

    const response = await axios.post(`${this.instanceUrl}/services/oauth2/token`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    this.cachedToken = response.data.access_token;
    this.tokenExpiry = now + 55 * 60 * 1000; // Cache for 55 minutes
    console.log('[SalesforceAdapter] Successfully obtained OAuth access token.');
    return this.cachedToken!;
  }

  // --------------------------------------------------------------------------
  // SOQL Query Helper
  // --------------------------------------------------------------------------
  private async querySOQL<T>(soql: string): Promise<T[]> {
    const t0 = Date.now();
    try {
      const token = await this.getAccessToken();
      const response = await axios.get(`${this.instanceUrl}/services/data/v60.0/query`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { q: soql },
        timeout: 20000
      });
      const records = response.data.records as T[];
      recordSpan('platform.query', t0, 'ok', { platform: 'salesforce', soql, rows: records.length });
      return records;
    } catch (e: any) {
      recordSpan('platform.query', t0, 'error', { platform: 'salesforce', soql, error: e.message });
      throw e;
    }
  }

  // --------------------------------------------------------------------------
  // REST POST/PATCH helper (for write-back)
  // --------------------------------------------------------------------------
  private async restCreate(sobjectName: string, data: Record<string, any>): Promise<string> {
    const token = await this.getAccessToken();
    const t0 = Date.now();
    try {
      const response = await axios.post(
        `${this.instanceUrl}/services/data/v60.0/sobjects/${sobjectName}`,
        data,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      recordSpan('platform.create', t0, 'ok', { platform: 'salesforce', object: sobjectName, recordId: response.data.id });
      return response.data.id;
    } catch (e: any) {
      if (e.response?.data) {
        console.error(`[Salesforce REST Create Error] Details:`, JSON.stringify(e.response.data));
      }
      recordSpan('platform.create', t0, 'error', { platform: 'salesforce', object: sobjectName, error: e.message });
      throw e;
    }
  }

  private async restUpdate(sobjectName: string, recordId: string, data: Record<string, any>): Promise<void> {
    const token = await this.getAccessToken();
    const t0 = Date.now();
    try {
      await axios.patch(
        `${this.instanceUrl}/services/data/v60.0/sobjects/${sobjectName}/${recordId}`,
        data,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      recordSpan('platform.update', t0, 'ok', { platform: 'salesforce', object: sobjectName, recordId });
    } catch (e: any) {
      if (e.response?.data) {
        console.error(`[Salesforce REST Update Error] Details:`, JSON.stringify(e.response.data));
      }
      recordSpan('platform.update', t0, 'error', { platform: 'salesforce', object: sobjectName, recordId, error: e.message });
      throw e;
    }
  }

  // --------------------------------------------------------------------------
  // getScoringCategoryId — fetch scoring category ID for a given category name
  //   Cached per session. Falls back to querying existing rating records.
  // --------------------------------------------------------------------------
  private async getScoringCategoryId(categoryName: string): Promise<string | null> {
    if (this.scoringCategoryCache.has(categoryName)) {
      return this.scoringCategoryCache.get(categoryName)!;
    }
    try {
      // Look up existing rating records to find the Scoring Category ID for this category
      const records = await this.querySOQL<any>(
        `SELECT Risk__Scoring_Category__c FROM Risk__Risk_Assessment_Rating__c WHERE Risk__Category__c = '${categoryName}' AND Risk__Scoring_Category__c != null LIMIT 1`
      );
      if (records.length > 0 && records[0].Risk__Scoring_Category__c) {
        const id = records[0].Risk__Scoring_Category__c;
        this.scoringCategoryCache.set(categoryName, id);
        console.log(`[SalesforceAdapter] Resolved Scoring Category '${categoryName}' -> ${id}`);
        return id;
      }
    } catch (e: any) {
      console.warn(`[SalesforceAdapter] Could not resolve scoring category ID for '${categoryName}': ${e.message}`);
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // ensureRatingRecords — creates Likelihood + Impact rating records if missing
  //   Returns the rating record IDs: { likelihoodId, impactId }
  // --------------------------------------------------------------------------
  private async ensureRatingRecords(
    assessmentId: string
  ): Promise<{ likelihoodId: string | null; impactId: string | null }> {
    // Check if they already exist
    const existing = await this.querySOQL<any>(
      `SELECT Id, Risk__Category__c FROM Risk__Risk_Assessment_Rating__c WHERE Risk__Risk_Assessment__c = '${assessmentId}' AND Risk__Mitigation__c = 'Inherent'`
    );

    let likelihoodId: string | null = null;
    let impactId: string | null = null;

    for (const rec of existing) {
      if (rec.Risk__Category__c === 'Likelihood') likelihoodId = rec.Id;
      if (rec.Risk__Category__c === 'Impact') impactId = rec.Id;
    }

    // Create Likelihood rating if missing
    if (!likelihoodId) {
      const scoringCatId = await this.getScoringCategoryId('Likelihood');
      try {
        likelihoodId = await this.restCreate('Risk__Risk_Assessment_Rating__c', {
          Risk__Risk_Assessment__c: assessmentId,
          Risk__Category__c: 'Likelihood',
          Risk__Mitigation__c: 'Inherent',
          Risk__Is_Likelihood_Type__c: true,
          Risk__Is_Likelihood_Scoring_Category__c: true,
          ...(scoringCatId ? { Risk__Scoring_Category__c: scoringCatId } : {})
        });
        console.log(`[SalesforceAdapter] Created Likelihood rating record: ${likelihoodId}`);
      } catch (e: any) {
        console.error(`[SalesforceAdapter] Failed to create Likelihood rating: ${e.message}`);
      }
    }

    // Create Impact rating if missing
    if (!impactId) {
      const scoringCatId = await this.getScoringCategoryId('Impact');
      try {
        impactId = await this.restCreate('Risk__Risk_Assessment_Rating__c', {
          Risk__Risk_Assessment__c: assessmentId,
          Risk__Category__c: 'Impact',
          Risk__Mitigation__c: 'Inherent',
          Risk__Is_Likelihood_Type__c: false,
          Risk__Is_Likelihood_Scoring_Category__c: false,
          ...(scoringCatId ? { Risk__Scoring_Category__c: scoringCatId } : {})
        });
        console.log(`[SalesforceAdapter] Created Impact rating record: ${impactId}`);
      } catch (e: any) {
        console.error(`[SalesforceAdapter] Failed to create Impact rating: ${e.message}`);
      }
    }

    return { likelihoodId, impactId };
  }

  // --------------------------------------------------------------------------
  // getAllRisks — fetches live risks from grc__Risk__c
  // --------------------------------------------------------------------------
  async getAllRisks(): Promise<Risk[]> {
    if (this.useLive) {
      try {
        const records = await this.querySOQL<any>(
          `SELECT Id, Name FROM grc__Risk__c ORDER BY Name ASC LIMIT 50`
        );
        return records.map(r => ({
          sysId: r.Id,
          name: r.Name,
          description: '',
          profileSysId: '',
          profileName: r.Name
        }));
      } catch (e: any) {
        console.warn(`[SalesforceAdapter] Live getAllRisks failed: ${e.message}. Using mock.`);
      }
    }
    return sf_risks.map(r => ({
      sysId: r.Id,
      name: r.Name,
      description: r.Description__c,
      profileSysId: r.Account__c,
      profileName: r.Account_Name__c
    }));
  }

  // --------------------------------------------------------------------------
  // getAllAssessmentInstances — fetches Risk__Risk_Assessment__c records
  // --------------------------------------------------------------------------
  async getAllAssessmentInstances(agent?: string): Promise<{ sysId: string; riskSysId: string; riskName: string; state: string }[]> {
    if (this.useLive) {
      try {
        if (agent === 'inherent-assessment') {
          // Load Risk records from grc__Risk__c (the actual Risk object in this org)
          const records = await this.querySOQL<any>(
            `SELECT Id, Name FROM grc__Risk__c ORDER BY Name ASC LIMIT 50`
          );
          return records.map(r => ({
            sysId: r.Id,
            riskSysId: r.Id,
            riskName: r.Name,
            state: 'Create New Assessment'
          }));
        }

        const records = await this.querySOQL<any>(
          `SELECT Id, Name, Risk__Risk__c, Risk__Risk__r.Name FROM Risk__Risk_Assessment__c ORDER BY Name DESC LIMIT 50`
        );
        return records.map(r => ({
          sysId: r.Id,
          riskSysId: r.Risk__Risk__c || '',
          riskName: r.Risk__Risk__r?.Name || 'Risk Assessment',
          state: r.Name  // e.g. RA-00445
        }));
      } catch (e: any) {
        console.warn(`[SalesforceAdapter] Live getAllAssessmentInstances failed: ${e.message}. Using mock.`);
      }
    }

    if (agent === 'inherent-assessment') {
      return sf_risks.map(r => ({
        sysId: r.Id,
        riskSysId: r.Id,
        riskName: r.Name,
        state: 'Create New Assessment (Mock)'
      }));
    }

    return sf_assessments.map(a => ({
      sysId: a.Id,
      riskSysId: a.Risk__c,
      riskName: sf_risks.find(r => r.Id === a.Risk__c)?.Name || 'Unknown Risk',
      state: a.Status__c
    }));
  }

  // --------------------------------------------------------------------------
  // getRisk
  // --------------------------------------------------------------------------
  async getRisk(riskSysId: string): Promise<Risk | null> {
    if (this.useLive) {
      try {
        const records = await this.querySOQL<any>(
          `SELECT Id, Name FROM grc__Risk__c WHERE Id = '${riskSysId}' LIMIT 1`
        );
        if (records.length > 0) {
          const r = records[0];
          return {
            sysId: r.Id,
            name: r.Name,
            description: '',
            profileSysId: '',
            profileName: r.Name
          };
        }
        return null;
      } catch (e: any) {
        console.warn(`[SalesforceAdapter] Live getRisk failed: ${e.message}. Using mock.`);
      }
    }
    const r = sf_risks.find(item => item.Id === riskSysId);
    if (!r) return null;
    return {
      sysId: r.Id,
      name: r.Name,
      description: r.Description__c,
      profileSysId: r.Account__c,
      profileName: r.Account_Name__c
    };
  }

  // --------------------------------------------------------------------------
  // getControlsForEntity — fetches grc__Control__c for a business unit
  // --------------------------------------------------------------------------
  async getControlsForEntity(profileSysId: string): Promise<Control[]> {
    if (this.useLive) {
      try {
        let records: any[] = [];
        // 1. Try to query controls belonging to this specific Business Unit
        if (profileSysId && profileSysId.length > 10) {
          records = await this.querySOQL<any>(
            `SELECT Id, Name, grc__Description__c, grc__Business_Unit__c, grc__Status__c, grc__Category__c FROM grc__Control__c WHERE grc__Business_Unit__c = '${profileSysId}' AND grc__Status__c IN ('Implemented', 'Not Implemented') LIMIT 50`
          );
        }

        // 2. If no controls found for that BU (or no BU specified), fetch general controls catalog
        if (records.length === 0) {
          records = await this.querySOQL<any>(
            `SELECT Id, Name, grc__Description__c, grc__Business_Unit__c, grc__Status__c, grc__Category__c FROM grc__Control__c WHERE grc__Status__c IN ('Implemented', 'Not Implemented') ORDER BY Name LIMIT 50`
          );
        }

        return records.map((c: any) => ({
          sysId: c.Id,
          name: c.Name,
          description: c.grc__Description__c || '',
          category: c.grc__Category__c || 'General',
          profileSysId: c.grc__Business_Unit__c || '',
          active: c.grc__Status__c === 'Implemented' || c.grc__Status__c === 'Not Implemented' || c.grc__Status__c == null
        }));
      } catch (e: any) {
        console.warn(`[SalesforceAdapter] Live getControlsForEntity failed: ${e.message}. Using mock.`);
      }
    }
    return sf_controls
      .filter(c => c.Account__c === profileSysId && c.Active__c)
      .map(c => ({
        sysId: c.Id,
        name: c.Name__c,
        description: c.Description__c,
        category: c.Category__c || 'General',
        profileSysId: c.Account__c,
        active: c.Active__c
      }));
  }

  // --------------------------------------------------------------------------
  // getAssessmentInstance — fetches a single Risk__Risk_Assessment__c
  //   If a grc__Risk__c ID is passed, creates a new Risk Assessment + Rating records
  // --------------------------------------------------------------------------
  async getAssessmentInstance(instanceSysId: string): Promise<{ sysId: string, riskSysId: string } | null> {
    if (this.useLive) {
      try {
        // Detect if instanceSysId is a grc__Risk__c record ID by querying it
        let isRiskId = false;
        try {
          const riskCheck = await this.querySOQL<any>(
            `SELECT Id FROM grc__Risk__c WHERE Id = '${instanceSysId}' LIMIT 1`
          );
          isRiskId = riskCheck.length > 0;
        } catch {
          isRiskId = false;
        }

        if (isRiskId) {
          console.log(`[Salesforce LIVE] Detected grc__Risk__c ID: ${instanceSysId}. Creating a new Risk__Risk_Assessment__c record...`);
          const assessmentId = await this.restCreate('Risk__Risk_Assessment__c', {
            Risk__Risk__c: instanceSysId,
            Risk__Risk_Assessment_Date__c: new Date().toISOString().split('T')[0]
          });
          console.log(`[Salesforce LIVE] Created new Risk Assessment: ${assessmentId}`);

          // Explicitly create Likelihood + Impact rating records
          console.log('[Salesforce LIVE] Creating Inherent Rating records (Likelihood + Impact)...');
          await this.ensureRatingRecords(assessmentId);

          return { sysId: assessmentId, riskSysId: instanceSysId };
        }

        const records = await this.querySOQL<any>(
          `SELECT Id, Risk__Risk__c FROM Risk__Risk_Assessment__c WHERE Id = '${instanceSysId}' LIMIT 1`
        );
        if (records.length > 0) {
          return { sysId: records[0].Id, riskSysId: records[0].Risk__Risk__c };
        }
        return null;
      } catch (e: any) {
        console.warn(`[SalesforceAdapter] Live getAssessmentInstance failed: ${e.message}. Using mock.`);
      }
    }

    const isMockRisk = instanceSysId.startsWith('sf_risk_');
    if (isMockRisk) {
      const assessmentId = 'sf_asmt_' + Math.random().toString(36).substring(2, 7);
      sf_assessments.push({ Id: assessmentId, Risk__c: instanceSysId, Status__c: 'In Progress' });
      // Create child factors
      sf_assessment_factors.push(
        { Id: assessmentId + '_impact', Assessment__c: assessmentId, Label__c: 'Inherent Impact', Control__c: '', Control_Name__c: '', Score__c: null, Comments__c: '', Hash__c: '' },
        { Id: assessmentId + '_likelihood', Assessment__c: assessmentId, Label__c: 'Inherent Likelihood', Control__c: '', Control_Name__c: '', Score__c: null, Comments__c: '', Hash__c: '' }
      );
      console.log(`[Salesforce DB UPDATE] Created mock assessment ${assessmentId} for risk ${instanceSysId}`);
      return { sysId: assessmentId, riskSysId: instanceSysId };
    }

    const a = sf_assessments.find(item => item.Id === instanceSysId);
    if (!a) return null;
    return { sysId: a.Id, riskSysId: a.Risk__c };
  }

  // --------------------------------------------------------------------------
  // getControlFactorRows — fetches Risk__Control_Assessment__c rows for a
  //   Risk__Risk_Assessment__c instance (via the Risk Control Lookup junction)
  // --------------------------------------------------------------------------
  async getControlFactorRows(instanceSysId: string): Promise<FactorResponse[]> {
    if (this.useLive) {
      try {
        // First, get the risk from the assessment
        const assessmentRecords = await this.querySOQL<any>(
          `SELECT Id, Risk__Risk__c FROM Risk__Risk_Assessment__c WHERE Id = '${instanceSysId}' LIMIT 1`
        );
        if (assessmentRecords.length === 0) return [];
        const riskId = assessmentRecords[0].Risk__Risk__c;

        // Then get control assessments for this risk
        const records = await this.querySOQL<any>(
          `SELECT Id, Name, Risk__Risk_Control_Lookup__c, Risk__Risk_Control_Lookup__r.Risk__Control__c, Risk__Risk_Control_Lookup__r.Risk__Control__r.Name FROM Risk__Control_Assessment__c WHERE Risk__Risk_Control_Lookup__r.Risk__Risk__c = '${riskId}' LIMIT 50`
        );
        return records.map((r: any) => ({
          sysId: r.Id,
          factorSysId: r.Risk__Risk_Control_Lookup__c,
          factorName: 'Control Assessment',
          controlSysId: r.Risk__Risk_Control_Lookup__r?.Risk__Control__c || '',
          controlName: r.Risk__Risk_Control_Lookup__r?.Risk__Control__r?.Name || r.Name
        }));
      } catch (e: any) {
        console.warn(`[SalesforceAdapter] Live getControlFactorRows failed: ${e.message}. Using mock.`);
      }
    }
    return sf_assessment_factors
      .filter(item => item.Assessment__c === instanceSysId && item.Control__c !== '')
      .map(item => ({
        sysId: item.Id,
        factorSysId: item.Label__c,
        factorName: item.Label__c,
        controlSysId: item.Control__c,
        controlName: item.Control_Name__c
      }));
  }

  // --------------------------------------------------------------------------
  // getAnswerableManualRows — fetches Inherent Rating rows for assessment
  //   For Salesforce, these are Risk__Risk_Assessment_Rating__c records.
  //   Only returns Likelihood and Impact (Inherent mitigation) rows.
  //   Creates them if missing (in case apex triggers didn't run).
  // --------------------------------------------------------------------------
  async getAnswerableManualRows(instanceSysId: string): Promise<Factor[]> {
    if (this.useLive) {
      try {
        // First ensure Likelihood + Impact records exist
        const { likelihoodId, impactId } = await this.ensureRatingRecords(instanceSysId);

        // Now fetch all Inherent rating records for this assessment
        const records = await this.querySOQL<any>(
          `SELECT Id, Risk__Category__c, Risk__Is_Likelihood_Type__c, Risk__Band__c, Risk__Value__c, Risk__Justification__c FROM Risk__Risk_Assessment_Rating__c WHERE Risk__Risk_Assessment__c = '${instanceSysId}' AND Risk__Mitigation__c = 'Inherent' ORDER BY Risk__Category__c`
        );

        // Filter to only Likelihood and Impact — these are the two AI-assessable dimensions
        const filtered = records.filter((r: any) =>
          r.Risk__Category__c === 'Likelihood' || r.Risk__Category__c === 'Impact'
        );

        if (filtered.length > 0) {
          return filtered.map((r: any) => {
            const isLikelihood = r.Risk__Category__c === 'Likelihood';
            return {
              sysId: r.Id,
              factorSysId: r.Id,
              factorName: r.Risk__Category__c,
              factorDesc: `Inherent ${r.Risk__Category__c} Rating — assess this risk dimension before controls.`,
              guidance: isLikelihood
                ? 'Rate the likelihood of this risk occurring: Low (1), Moderate (2), High (3) based on historical frequency and probability.'
                : 'Rate the impact if this risk materialises: Low (1), Moderate (2), High (3) based on financial, operational or reputational exposure.',
              choiceList: ['Low', 'Moderate', 'High'],
              choiceMap: { Low: 1, Moderate: 2, High: 3 }
            };
          });
        }
      } catch (e: any) {
        console.warn(`[SalesforceAdapter] Live getAnswerableManualRows failed: ${e.message}. Using mock.`);
      }
    }
    // Mock fallback: return Likelihood and Impact dummy factors
    return [
      {
        sysId: `${instanceSysId}_likelihood`,
        factorSysId: 'Inherent_Likelihood',
        factorName: 'Likelihood',
        factorDesc: 'Rate the inherent likelihood of this risk before controls.',
        guidance: 'Low (1), Moderate (2), High (3) based on probability of occurrence.',
        choiceList: ['Low', 'Moderate', 'High'],
        choiceMap: { Low: 1, Moderate: 2, High: 3 }
      },
      {
        sysId: `${instanceSysId}_impact`,
        factorSysId: 'Inherent_Impact',
        factorName: 'Impact',
        factorDesc: 'Rate the inherent impact of this risk before controls.',
        guidance: 'Low (1), Moderate (2), High (3) based on potential business impact.',
        choiceList: ['Low', 'Moderate', 'High'],
        choiceMap: { Low: 1, Moderate: 2, High: 3 }
      }
    ];
  }

  // --------------------------------------------------------------------------
  // getFactorChoices
  // --------------------------------------------------------------------------
  async getFactorChoices(factorSysId: string): Promise<Factor | null> {
    const meta = sf_factor_metadata[factorSysId as keyof typeof sf_factor_metadata];
    if (!meta) return null;
    return {
      sysId: factorSysId,
      factorSysId: factorSysId,
      factorName: factorSysId,
      factorDesc: 'Salesforce Custom Field Factor',
      guidance: meta.guidance,
      choiceList: meta.choices,
      choiceMap: meta.scores
    };
  }

  // --------------------------------------------------------------------------
  // getControlEvidence — fetches grc__Control_Test__c and grc__Control_Test_Result__c
  // --------------------------------------------------------------------------
  async getControlEvidence(controlSysId: string): Promise<TestEvidence> {
    if (this.useLive) {
      try {
        // Get the most recent test result for this control
        const testResults = await this.querySOQL<any>(
          `SELECT Id, Name, grc__Result__c, grc__Date_Of_Test__c, Testing_Comments__c, grc__Control_Test__r.Name FROM grc__Control_Test_Result__c WHERE grc__Control_Test__r.grc__Control__c = '${controlSysId}' ORDER BY grc__Date_Of_Test__c DESC LIMIT 1`
        );
        const controlRecords = await this.querySOQL<any>(
          `SELECT Id, Name, grc__Status__c FROM grc__Control__c WHERE Id = '${controlSysId}' LIMIT 1`
        );
        const ctrl = controlRecords[0] || null;
        const latest = testResults[0] || null;

        return {
          sysId: controlSysId,
          number: ctrl?.Name || controlSysId,
          name: ctrl?.Name || '',
          state: ctrl?.grc__Status__c || 'Active',
          effectiveness: latest?.grc__Result__c || 'Not Tested',
          status: latest?.grc__Result__c === 'Pass' ? 'Passed' : (latest?.grc__Result__c === 'Fail' ? 'Failed' : 'Unknown'),
          latestResult: latest?.Testing_Comments__c || latest?.grc__Result__c || 'No test results on record.',
          resultDate: latest?.grc__Date_Of_Test__c || 'N/A',
          openIssues: [],
          closedIssues: testResults.length,
          tests: [] // Salesforce exposes only the latest result, not a per-test breakdown like ServiceNow's sn_audit_control_test rows
        };
      } catch (e: any) {
        console.warn(`[SalesforceAdapter] Live getControlEvidence failed: ${e.message}. Using mock.`);
      }
    }
    const ctrl = sf_controls.find(c => c.Id === controlSysId);
    return {
      sysId: controlSysId,
      number: 'CTRL_' + controlSysId.split('_')[2],
      name: ctrl?.Name__c || '',
      state: ctrl?.Active__c ? 'Active' : 'Inactive',
      effectiveness: 'Effective',
      status: 'Passed',
      latestResult: 'Automated policy auditor confirmed block public access flag is true in org settings.',
      resultDate: '2026-07-10',
      openIssues: [],
      closedIssues: 2,
      tests: []
    };
  }

  // --------------------------------------------------------------------------
  // getPriorClosedAssessment
  // --------------------------------------------------------------------------
  async getPriorClosedAssessment(riskSysId: string, currentInstanceSysId: string): Promise<{ sysId: string; number: string } | null> {
    if (this.useLive) {
      try {
        const records = await this.querySOQL<any>(
          `SELECT Id, Name FROM Risk__Risk_Assessment__c WHERE Risk__Risk__c = '${riskSysId}' AND Id != '${currentInstanceSysId}' ORDER BY CreatedDate DESC LIMIT 1`
        );
        if (records.length > 0) {
          return { sysId: records[0].Id, number: records[0].Name || records[0].Id };
        }
        return null;
      } catch {
        return null;
      }
    }
    return null;
  }

  async getPriorControlAnswer(priorInstanceSysId: string, controlSysId: string, factorSysId: string) {
    return null;
  }

  // --------------------------------------------------------------------------
  // writeControlEffectiveness — updates Risk__Control_Assessment__c
  // --------------------------------------------------------------------------
  async writeControlEffectiveness(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    evidenceSummary: string,
    auditTrail: string,   // ServiceNow-specific field; ignored on Salesforce
    fingerprint: string
  ): Promise<void> {
    if (this.useLive) {
      try {
        // Map rating label to Salesforce picklist values
        const designMap: Record<string, string> = {
          'Satisfactory': 'Effective',
          'Needs Improvement': 'Partially Effective',
          'Ineffective': 'Ineffective',
          'Needs Work': 'Partially Effective'
        };
        await this.restUpdate('Risk__Control_Assessment__c', rowSysId, {
          Risk__Control_Effectiveness__c: designMap[ratingLabel] || ratingLabel,
          Risk__Justification__c: `[AI] ${justification}\n\nEvidence: ${evidenceSummary}`,
          Risk__Control_Effectiveness_Value__c: score,
          Risk__Assessment_Date__c: new Date().toISOString().split('T')[0]
        });
        console.log(`[Salesforce LIVE UPDATE] Updated Risk__Control_Assessment__c ${rowSysId} → ${ratingLabel}`);
      } catch (e: any) {
        console.error(`[SalesforceAdapter] writeControlEffectiveness failed for ${rowSysId}: ${e.message}`);
        throw e;
      }
      return;
    }
    const row = sf_assessment_factors.find(item => item.Id === rowSysId);
    if (row) {
      row.Score__c = score as any;
      row.Comments__c = evidenceSummary;
      row.Hash__c = fingerprint;
      console.log(`[Salesforce DB UPDATE] Object [Assessment_Factor__c] row [${rowSysId}] -> Score__c: ${score}, Hash__c: "${fingerprint.substring(0,25)}...", Comments__c: [Written]`);
    }
  }

  // --------------------------------------------------------------------------
  // writeInherentFactor — updates Risk__Risk_Assessment_Rating__c record
  //   Writes Band Number, Band Label, Best/Most Likely/Worst Case scores,
  //   and Justification onto the rating record.
  // --------------------------------------------------------------------------
  async writeInherentFactor(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    comment: string,      // plain text structured comment
    auditTrail: string    // HTML audit trail (ServiceNow-specific; ignored here)
  ): Promise<void> {
    if (this.useLive) {
      try {
        // Mock suffix IDs fall through to the live path since the real IDs are Salesforce IDs now
        if (rowSysId.endsWith('_impact') || rowSysId.endsWith('_likelihood')) {
          // Should not happen in live mode — log a warning
          console.warn(`[SalesforceAdapter] writeInherentFactor called with mock suffix ID in LIVE mode: ${rowSysId}. Skipping.`);
          return;
        }

        // Map rating label to band number and score range
        const bandMap: Record<string, { band: string; bandNum: number; bestCase: number; value: number; worstCase: number }> = {
          'Low':      { band: '1', bandNum: 1, bestCase: 1.0, value: 1.25, worstCase: 1.5 },
          'Moderate': { band: '2', bandNum: 2, bestCase: 1.5, value: 1.75, worstCase: 2.0 },
          'High':     { band: '3', bandNum: 3, bestCase: 2.0, value: 2.5,  worstCase: 3.0 }
        };
        const bandData = bandMap[ratingLabel] || { band: String(score), bandNum: score, bestCase: score - 0.25, value: score, worstCase: score + 0.25 };

        // Update the child rating record with full scoring details
        await this.restUpdate('Risk__Risk_Assessment_Rating__c', rowSysId, {
          Risk__Band__c: bandData.band,
          Risk__Band_Number__c: bandData.bandNum,
          Risk__Best_Case__c: bandData.bestCase,
          Risk__Value__c: bandData.value,
          Risk__Worst_Case__c: bandData.worstCase,
          Risk__Justification__c: comment.substring(0, 32768)
        });
        console.log(`[Salesforce LIVE UPDATE] Updated Risk__Risk_Assessment_Rating__c ${rowSysId}`);
        console.log(`  Rating: ${ratingLabel} | Band: ${bandData.band} | Best: ${bandData.bestCase} | Value: ${bandData.value} | Worst: ${bandData.worstCase}`);
        console.log(`  Justification: ${comment.substring(0, 200)}...`);
        return;
      } catch (e: any) {
        console.error(`[SalesforceAdapter] writeInherentFactor failed for ${rowSysId}: ${e.message}`);
        throw e;
      }
    }

    // Mock fallback
    if (rowSysId.endsWith('_impact') || rowSysId.endsWith('_likelihood')) {
      console.log(`[Salesforce DB UPDATE] Mock Inherent Rating [${rowSysId}] -> Score: ${score}, Band: ${ratingLabel}`);
      console.log(`  Comments:\n${comment}`);
      return;
    }
    const row = sf_assessment_factors.find(item => item.Id === rowSysId);
    if (row) {
      row.Score__c = score as any;
      row.Comments__c = comment;
      console.log(`[Salesforce DB UPDATE] Object [Assessment_Factor__c] row [${rowSysId}] -> Score__c: ${score}`);
      console.log(`  Comments:\n${comment}`);
    }
  }

  // --------------------------------------------------------------------------
  // writeRiskControlMapping — creates Risk__Risk_Control_Lookup__c records
  // --------------------------------------------------------------------------
  async writeRiskControlMapping(
    riskSysId: string,
    matchedControls: Array<{ sysId: string; reason: string }>,
    justification: string,
    gaps: string,
    recommendations: string
  ): Promise<void> {
    if (this.useLive) {
      try {
        const created: string[] = [];
        for (const ctrl of matchedControls) {
          try {
            const newId = await this.restCreate('Risk__Risk_Control_Lookup__c', {
              Risk__Risk__c: riskSysId,
              Risk__Control__c: ctrl.sysId,
              Risk__Control_Assessment_Justification__c: `[WissdaSense] ${ctrl.reason}`.substring(0, 32768)
            });
            created.push(newId);
          } catch (innerErr: any) {
            // Duplicate or constraint error — skip silently
            console.warn(`[SalesforceAdapter] Skipping control ${ctrl.sysId} for risk ${riskSysId}: ${innerErr.message}`);
          }
        }
        console.log(`[Salesforce LIVE UPDATE] Created ${created.length} Risk__Risk_Control_Lookup__c entries for risk ${riskSysId}`);
      } catch (e: any) {
        console.error(`[SalesforceAdapter] writeRiskControlMapping failed: ${e.message}`);
        throw e;
      }
      return;
    }
    matchedControls.forEach(ctrl => {
      sf_control_mappings.push({ Risk__c: riskSysId, Control__c: ctrl.sysId });
    });
    console.log(`[Salesforce DB UPDATE] Created ${matchedControls.length} entries in Risk_Control_Mapping__c. Added AI feedback summary to Risk__c: ${riskSysId}`);
  }

  // --------------------------------------------------------------------------
  // writeFailure
  // --------------------------------------------------------------------------
  async writeFailure(rowSysId: string, reason: string): Promise<void> {
    if (this.useLive) {
      try {
        await this.restUpdate('Risk__Control_Assessment__c', rowSysId, {
          Risk__Justification__c: `❌ WissdaSense Assessment failed: ${reason}`
        });
      } catch {
        // Best-effort — don't throw on failure write
      }
      return;
    }
    const row = sf_assessment_factors.find(item => item.Id === rowSysId);
    if (row) {
      row.Comments__c = `❌ WissdaSense Assessment failed: ${reason}`;
      console.log(`[Salesforce DB UPDATE] Object [Assessment_Factor__c] row [${rowSysId}] marked with error comments`);
    }
  }
}
