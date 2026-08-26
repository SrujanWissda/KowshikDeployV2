import axios from 'axios';
import { BaseGRCAdapter } from './base';
import { Risk, Control, TestEvidence, Factor, FactorResponse } from '../core/models';
import { GeneratedAdapterConfig, TableMapping, findTable, findAllTables, findTableForAgent } from '../core/generated_adapter_config';
import { recordSpan } from '../core/observability';

// ============================================================================
// Universal rating rubrics
//
// The two assessment agents (agents.ts) already hardcode the rating
// vocabulary they expect back from the LLM — Control Effectiveness always
// asks for Satisfactory/Needs Improvement/Weak, and inherent factors are
// asked for on a rubric the agent itself supplies per-factor. Rating SCALES
// are therefore agent-side concepts, not something discoverable from a
// target platform's schema, so DynamicAdapter applies the same universal
// rubric to every generically onboarded platform rather than trying to
// vector/LLM-discover a scale that doesn't exist as a "field" anywhere.
// ============================================================================
const CONTROL_EFFECTIVENESS_SCALE: Record<string, number> = { Satisfactory: 3, 'Needs Improvement': 2, Weak: 1 };
// Salesforce Risk-package rating rows store Value on a 0-100 scale (verified
// against real org data — e.g. Band 4 rows sit around 65-100, Band 2 rows
// around 35-56), not a 1-3 severity score. 25/50/75 are quartile midpoints —
// a reasonable default for THIS observed scale, not a value derived from the
// package's own (hidden) thresholds. A future platform discovered with a
// genuinely different native scale would need this reconsidered.
const INHERENT_FACTOR_SCALE: Record<string, number> = { Low: 25, Medium: 50, High: 75 };

/**
 * Generic BaseGRCAdapter implementation driven entirely by a
 * GeneratedAdapterConfig produced by UniversalSchemaDiscoveryAgent. Lets a
 * newly onboarded platform work with ControlEffectivenessAgent,
 * InherentAssessmentAgent, and RiskControlMappingAgent with zero new
 * hand-written adapter code.
 *
 * Only the 'salesforce-soql' connection type has a live query executor today
 * (matching the first live introspection connector that was built). Other
 * connection types log a clear warning and return empty results rather than
 * silently pretending to work.
 */
export class DynamicAdapter extends BaseGRCAdapter {
  private cachedToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(
    private config: GeneratedAdapterConfig,
    private instanceUrl: string,
    private clientId: string,
    private clientSecret: string
  ) {
    super();
    this.instanceUrl = instanceUrl.replace(/\/$/, '');
    if (config.connectionType !== 'salesforce-soql') {
      console.warn(`[DynamicAdapter:${config.platformName}] connectionType '${config.connectionType}' has no query executor implemented yet; read operations will return empty results.`);
    }
  }

  getEntityLabel(): string {
    return this.config.entityLabel;
  }

  getPlatformName(): string {
    return this.config.platformName;
  }

  // Field metadata for smart formatting (discovered during schema discovery)
  getFieldMetadata() {
    return this.config.fieldMetadata;
  }

  getTerminology() {
    return this.config.terminology;
  }

  getFieldRelationships() {
    return this.config.fieldRelationships;
  }

  // --------------------------------------------------------------------------
  // Query/write plumbing (Salesforce SOQL — first supported connection type)
  // --------------------------------------------------------------------------
  private supportsLiveQueries(): boolean {
    return this.config.connectionType === 'salesforce-soql';
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiry) return this.cachedToken;

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', this.clientId);
    params.append('client_secret', this.clientSecret);

    const response = await axios.post(`${this.instanceUrl}/services/oauth2/token`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    this.cachedToken = response.data.access_token;
    this.tokenExpiry = now + 55 * 60 * 1000;
    return this.cachedToken!;
  }

  private async querySOQL<T>(soql: string): Promise<T[]> {
    if (!this.supportsLiveQueries()) return [];
    const t0 = Date.now();
    try {
      const token = await this.getAccessToken();
      const response = await axios.get(`${this.instanceUrl}/services/data/v60.0/query`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { q: soql },
        timeout: 20000
      });
      const records = response.data.records as T[];
      recordSpan('platform.query', t0, 'ok', { platform: this.config.platformName, soql, rows: records.length });
      return records;
    } catch (e: any) {
      console.warn(`[DynamicAdapter:${this.config.platformName}] SOQL query failed: ${e.message}\n  Query: ${soql}`);
      recordSpan('platform.query', t0, 'error', { platform: this.config.platformName, soql, error: e.message });
      return [];
    }
  }

  private async restUpdate(sobjectName: string, recordId: string, data: Record<string, any>): Promise<boolean> {
    if (!this.supportsLiveQueries()) return false;
    const t0 = Date.now();
    const selfHeal: string[] = [];
    // Same self-healing as restCreate: drop fields Salesforce reports as
    // non-writable for this profile and retry with the rest.
    let payload = { ...data };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const token = await this.getAccessToken();
        await axios.patch(
          `${this.instanceUrl}/services/data/v60.0/sobjects/${sobjectName}/${recordId}`,
          payload,
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        recordSpan('platform.update', t0, 'ok', {
          platform: this.config.platformName, object: sobjectName, recordId,
          ...(selfHeal.length > 0 ? { selfHeal: selfHeal.join('; ') } : {})
        });
        return true;
      } catch (e: any) {
        const errors: any[] = Array.isArray(e.response?.data) ? e.response.data : [];
        const badFields = errors
          .filter(err => err.errorCode === 'INVALID_FIELD_FOR_INSERT_UPDATE')
          .flatMap(err => err.fields || []);
        if (badFields.length > 0 && badFields.some(f => f in payload)) {
          console.warn(`[DynamicAdapter:${this.config.platformName}] ${sobjectName}: field(s) not writable for this profile (${badFields.join(', ')}) — retrying update without them.`);
          selfHeal.push(`dropped non-writable: ${badFields.join(', ')}`);
          for (const f of badFields) delete payload[f];
          if (Object.keys(payload).length === 0) return false;
          continue;
        }
        if (this.truncateTooLongFields(payload, errors)) {
          console.warn(`[DynamicAdapter:${this.config.platformName}] ${sobjectName}: text exceeded a field's max length — retrying update with truncated value.`);
          selfHeal.push('truncated over-length text');
          continue;
        }
        const detail = e.response?.data ? ` Details: ${JSON.stringify(e.response.data)}` : '';
        console.error(`[DynamicAdapter:${this.config.platformName}] Write-back to ${sobjectName}/${recordId} failed: ${e.message}${detail}`);
        recordSpan('platform.update', t0, 'error', { platform: this.config.platformName, object: sobjectName, recordId, error: e.message });
        return false;
      }
    }
    recordSpan('platform.update', t0, 'error', { platform: this.config.platformName, object: sobjectName, recordId, error: 'retries exhausted' });
    return false;
  }

  /**
   * Handles STRING_TOO_LONG: Salesforce reports which field overflowed and
   * its max length ("max length=255"); truncate that field's value in place.
   * Returns true if anything was truncated (caller should retry).
   */
  private truncateTooLongFields(payload: Record<string, any>, errors: any[]): boolean {
    let truncated = false;
    for (const err of errors) {
      if (err.errorCode !== 'STRING_TOO_LONG') continue;
      const max = parseInt((String(err.message || '').match(/max length=(\d+)/) || [])[1] || '255', 10);
      for (const f of err.fields || []) {
        if (typeof payload[f] === 'string' && payload[f].length > max) {
          payload[f] = payload[f].substring(0, Math.max(0, max - 1)) + '…';
          truncated = true;
        }
      }
    }
    return truncated;
  }

  private async restCreate(sobjectName: string, data: Record<string, any>): Promise<string | null> {
    if (!this.supportsLiveQueries()) return null;
    const t0 = Date.now();
    const selfHeal: string[] = [];
    // Field writability varies per org/profile (formula fields, FLS): when
    // Salesforce reports specific fields as non-insertable, drop just those
    // and retry rather than failing the whole create.
    let payload = { ...data };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const token = await this.getAccessToken();
        const response = await axios.post(
          `${this.instanceUrl}/services/data/v60.0/sobjects/${sobjectName}`,
          payload,
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        recordSpan('platform.create', t0, 'ok', {
          platform: this.config.platformName, object: sobjectName, recordId: response.data.id,
          ...(selfHeal.length > 0 ? { selfHeal: selfHeal.join('; ') } : {})
        });
        return response.data.id as string;
      } catch (e: any) {
        const errors: any[] = Array.isArray(e.response?.data) ? e.response.data : [];
        const badFields = errors
          .filter(err => err.errorCode === 'INVALID_FIELD_FOR_INSERT_UPDATE')
          .flatMap(err => err.fields || []);
        if (badFields.length > 0) {
          console.warn(`[DynamicAdapter:${this.config.platformName}] ${sobjectName}: field(s) not writable for this profile (${badFields.join(', ')}) — retrying without them.`);
          selfHeal.push(`dropped non-writable: ${badFields.join(', ')}`);
          for (const f of badFields) delete payload[f];
          continue;
        }
        const detail = e.response?.data ? ` Details: ${JSON.stringify(e.response.data)}` : '';
        console.error(`[DynamicAdapter:${this.config.platformName}] Create on ${sobjectName} failed: ${e.message}${detail}`);
        recordSpan('platform.create', t0, 'error', { platform: this.config.platformName, object: sobjectName, error: e.message });
        return null;
      }
    }
    recordSpan('platform.create', t0, 'error', { platform: this.config.platformName, object: sobjectName, error: 'retries exhausted' });
    return null;
  }

  private table(model: TableMapping['targetAgnosticModel']): TableMapping | undefined {
    return findTable(this.config, model);
  }

  /**
   * Multiple tables can map to 'Factor' — inherent rating rows (linked to an
   * assessment) vs. control answer rows (linked to a control). Selection
   * must be by required capability (which relationship the caller needs),
   * not raw confidence, or one high-confidence table shadows the other.
   */
  private factorTableWith(...requiredRels: string[]): TableMapping | undefined {
    return findAllTables(this.config, 'Factor').find(t => requiredRels.every(r => !!t.relationships[r]));
  }

  /** Maps a raw record onto a plain {agnosticField: value} dict using the table's field mappings. */
  private mapRecord(t: TableMapping, row: any): Record<string, string> {
    const out: Record<string, string> = {};
    for (const fm of t.fieldMappings) {
      const v = row[fm.sourceField];
      if (v !== undefined && v !== null) out[fm.agnosticField] = String(v);
    }
    return out;
  }

  private selectFieldList(t: TableMapping, extra: string[] = []): string {
    const fields = new Set<string>(['Id', ...t.fieldMappings.map(f => f.sourceField), ...extra]);
    return [...fields].join(', ');
  }

  // --------------------------------------------------------------------------
  // Read Operations
  // --------------------------------------------------------------------------
  async getEntityIssues(profileSysId: string): Promise<Array<{ desc: string; state: string; number?: string }>> {
    const t = this.table('Issue');
    const profileField = t?.relationships.profile;
    if (!t || !profileField) return [];

    const rows = await this.querySOQL<any>(
      `SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName} WHERE ${profileField} = '${profileSysId}' LIMIT 50`
    );
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      return { desc: rec.desc || 'Unspecified issue', state: rec.state || 'Open', number: rec.number };
    });
  }

  /** Not part of BaseGRCAdapter — used by app.ts's generic platform-listing endpoints, duck-typed the same way ServiceNowAdapter/SalesforceAdapter expose it. */
  async getAllRisks(): Promise<Risk[]> {
    const t = this.table('Risk');
    if (!t) return [];
    const rows = await this.querySOQL<any>(`SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName} ORDER BY CreatedDate DESC LIMIT 50`);
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      return {
        sysId: r.Id,
        name: rec.name || 'Unnamed Risk',
        description: rec.description || '',
        profileSysId: rec.profileSysId || '',
        profileName: rec.profileName || rec.name || 'Unknown entity'
      };
    });
  }

  /**
   * Not part of BaseGRCAdapter — generic assessment-instance listing for the
   * run-agent target picker. Unlike 'Factor', there's only ever one
   * legitimate AssessmentInstance table regardless of agent stage — using
   * findTableForAgent here would let a stray same-concept junk table (that
   * happens to have "Control" in its name) win over the real header table
   * for one of the two agents.
   */
  async getAllAssessmentInstances(agent?: string): Promise<{ sysId: string; riskSysId: string; riskName: string; state: string }[]> {
    // Inherent assessment starts FROM A RISK: picking one triggers creation
    // of a fresh assessment + rating rows (see getAssessmentInstance), the
    // same workflow the hand-written SalesforceAdapter implements. So the
    // target list for that agent is the risk register, not past assessments.
    if (agent === 'inherent-assessment' && this.supportsAssessmentBootstrap()) {
      const risks = await this.getAllRisks();
      return risks.map(r => ({
        sysId: r.sysId,
        riskSysId: r.sysId,
        riskName: r.name,
        state: 'Create New Assessment'
      }));
    }

    const t = this.table('AssessmentInstance');
    if (!t) return [];
    const riskField = t.relationships.risk;
    const riskNameField = this.relNameField(riskField);
    const selectFields = [...new Set(['Id', 'Name', ...(riskField ? [riskField] : []), ...(riskNameField ? [riskNameField] : [])])];
    const rows = await this.querySOQL<any>(
      `SELECT ${selectFields.join(', ')} FROM ${t.sourceTableName} ORDER BY CreatedDate DESC LIMIT 50`
    );
    return rows.map(r => {
      const riskName = riskNameField ? this.readDotted(r, riskNameField) : null;
      return {
        sysId: r.Id,
        riskSysId: riskField ? String(r[riskField] || '') : '',
        // riskName drives the dropdown label; show the risk's actual name
        // when the lookup resolves, else the record's own Name (RA-xxxxx).
        riskName: String(riskName || r.Name || 'Assessment Instance'),
        state: riskName && r.Name ? String(r.Name) : 'Open'
      };
    });
  }

  async getRisk(riskSysId: string): Promise<Risk | null> {
    const t = this.table('Risk');
    if (!t) return null;

    const rows = await this.querySOQL<any>(
      `SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName} WHERE Id = '${riskSysId}' LIMIT 1`
    );
    if (rows.length === 0) return null;
    const rec = this.mapRecord(t, rows[0]);

    return {
      sysId: riskSysId,
      name: rec.name || 'Unnamed Risk',
      description: rec.description || '',
      profileSysId: rec.profileSysId || '',
      profileName: rec.profileName || rec.name || 'Unknown entity'
    };
  }

  async getControlsForEntity(profileSysId: string): Promise<Control[]> {
    const t = this.table('Control');
    if (!t) return [];

    const profileField = t.relationships.profile;
    let query = `SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName}`;
    if (profileField && profileSysId) query += ` WHERE ${profileField} = '${profileSysId}'`;
    query += ' LIMIT 50';

    const rows = await this.querySOQL<any>(query);
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      return {
        sysId: r.Id,
        name: rec.name || 'Unnamed Control',
        description: rec.description || '',
        category: rec.category || 'General',
        profileSysId: rec.profileSysId || profileSysId,
        active: true
      };
    });
  }

  async getAssessmentInstance(instanceSysId: string): Promise<{ sysId: string; riskSysId: string } | null> {
    // More than one table can map to 'AssessmentInstance' (different
    // assessment stages) and a given sysId only exists in one of them —
    // there's no agent context at this call site to disambiguate, so try
    // each candidate until one actually contains the record.
    for (const t of findAllTables(this.config, 'AssessmentInstance')) {
      const riskField = t.relationships.risk;
      const rows = await this.querySOQL<any>(
        `SELECT Id${riskField ? ', ' + riskField : ''} FROM ${t.sourceTableName} WHERE Id = '${instanceSysId}' LIMIT 1`
      );
      if (rows.length > 0) {
        return { sysId: rows[0].Id, riskSysId: riskField ? String(rows[0][riskField] || '') : '' };
      }
    }

    // Not an existing assessment — if the ID is a risk record, trigger the
    // inherent-assessment workflow: create a fresh assessment header plus
    // its rating rows, then hand that new instance back to the agent.
    return this.bootstrapAssessmentForRisk(instanceSysId);
  }

  /**
   * The Salesforce Risk-package inherent workflow: a new assessment is
   * CREATED per run (header + Likelihood/Impact rating rows), not selected
   * from history. This create-on-demand semantic can't be discovered from
   * schema shape alone — it's carried over from the verified hand-written
   * SalesforceAdapter (gold standard), so it only activates when the
   * discovered config maps the exact Risk-package objects.
   */
  private supportsAssessmentBootstrap(): boolean {
    const header = findAllTables(this.config, 'AssessmentInstance').find(t => t.sourceTableName === 'Risk__Risk_Assessment__c');
    const rating = findAllTables(this.config, 'Factor').find(t => t.sourceTableName === 'Risk__Risk_Assessment_Rating__c');
    return !!(header && rating && this.table('Risk'));
  }

  private async bootstrapAssessmentForRisk(candidateRiskId: string): Promise<{ sysId: string; riskSysId: string } | null> {
    if (!this.supportsAssessmentBootstrap()) return null;

    const riskTable = this.table('Risk')!;
    const riskRows = await this.querySOQL<any>(`SELECT Id FROM ${riskTable.sourceTableName} WHERE Id = '${candidateRiskId}' LIMIT 1`);
    if (riskRows.length === 0) return null;

    // Reuse today's existing assessment for this risk if one was created today
    const reusable = await this.querySOQL<any>(
      `SELECT Id FROM Risk__Risk_Assessment__c WHERE Risk__Risk__c = '${candidateRiskId}' AND CreatedDate = TODAY ORDER BY CreatedDate DESC LIMIT 1`
    );
    if (reusable.length > 0) {
      console.log(`[DynamicAdapter:${this.config.platformName}] Reusing today's existing assessment ${reusable[0].Id} for risk ${candidateRiskId}.`);
      return { sysId: reusable[0].Id, riskSysId: candidateRiskId };
    }

    console.log(`[DynamicAdapter:${this.config.platformName}] '${candidateRiskId}' is a risk record — creating a new Risk__Risk_Assessment__c for it...`);
    const schemeId = await this.discoverMatrixScheme(candidateRiskId);
    const assessmentId = await this.restCreate('Risk__Risk_Assessment__c', {
      Risk__Risk__c: candidateRiskId,
      Risk__Risk_Assessment_Date__c: new Date().toISOString().split('T')[0],
      ...(schemeId ? { Risk__Matrix_Scoring_Scheme__c: schemeId } : {})
    });
    if (!assessmentId) return null;

    const categories = await this.discoverInherentCategories(candidateRiskId);
    console.log(`[DynamicAdapter:${this.config.platformName}] Created assessment ${assessmentId}. Creating Inherent rating rows for ${categories.length} business-unit category/categories: ${categories.join(', ')}...`);

    for (const category of categories) {
      // Resolve the package's scoring-category reference from any existing
      // rating record of the same category (same trick as the hand-written
      // adapter — the package requires it for band calculations).
      let scoringCategoryId: string | null = null;
      try {
        const existing = await this.querySOQL<any>(
          `SELECT Risk__Scoring_Category__c FROM Risk__Risk_Assessment_Rating__c WHERE Risk__Category__c = '${category}' AND Risk__Scoring_Category__c != null LIMIT 1`
        );
        scoringCategoryId = existing[0]?.Risk__Scoring_Category__c || null;
      } catch { /* proceed without scoring category */ }

      const ratingId = await this.restCreate('Risk__Risk_Assessment_Rating__c', {
        Risk__Risk_Assessment__c: assessmentId,
        Risk__Category__c: category,
        Risk__Mitigation__c: 'Inherent',
        ...(scoringCategoryId ? { Risk__Scoring_Category__c: scoringCategoryId } : {})
      });
      if (ratingId) {
        console.log(`[DynamicAdapter:${this.config.platformName}] Created ${category} rating row ${ratingId}.`);
      }
    }

    return { sysId: assessmentId, riskSysId: candidateRiskId };
  }

  /**
   * Scoring categories vary by business unit in this org and can change over
   * time, so they're discovered dynamically rather than hardcoded: reuse
   * whichever categories OTHER risks in the SAME business unit already have
   * inherent ratings for, ranked by frequency of use. Falls back to a
   * generic Likelihood/Impact pair only when the business unit has no prior
   * assessments to learn from (e.g. its first-ever assessment).
   */
  private async discoverInherentCategories(riskId: string): Promise<string[]> {
    const fallback = ['Likelihood', 'Impact'];
    const riskTable = this.table('Risk');
    const profileField = riskTable?.relationships.profile;
    if (!riskTable || !profileField) return fallback;

    const riskRows = await this.querySOQL<any>(`SELECT ${profileField} FROM ${riskTable.sourceTableName} WHERE Id = '${riskId}' LIMIT 1`);
    const businessUnitId = riskRows[0]?.[profileField];
    if (!businessUnitId) return fallback;

    const peerRisks = await this.querySOQL<any>(`SELECT Id FROM ${riskTable.sourceTableName} WHERE ${profileField} = '${businessUnitId}' LIMIT 200`);
    if (peerRisks.length === 0) return fallback;
    const riskIds = peerRisks.map(r => `'${r.Id}'`).join(',');

    const peerAssessments = await this.querySOQL<any>(`SELECT Id FROM Risk__Risk_Assessment__c WHERE Risk__Risk__c IN (${riskIds}) LIMIT 200`);
    if (peerAssessments.length === 0) return fallback;
    const assessmentIds = peerAssessments.map(a => `'${a.Id}'`).join(',');

    const categoryCounts = await this.querySOQL<any>(
      `SELECT Risk__Category__c cat, COUNT(Id) cnt FROM Risk__Risk_Assessment_Rating__c ` +
      `WHERE Risk__Mitigation__c = 'Inherent' AND Risk__Risk_Assessment__c IN (${assessmentIds}) AND Risk__Category__c != null ` +
      `GROUP BY Risk__Category__c ORDER BY COUNT(Id) DESC LIMIT 12`
    );
    const categories = categoryCounts.map(c => c.cat).filter(Boolean);
    return categories.length > 0 ? categories : fallback;
  }

  /**
   * Matrix Scoring Scheme (Risk-package specific — `Risk__Matrix_Scoring_Scheme__c`)
   * also varies by business unit in this org (confirmed: different BUs use
   * differently-named schemes). The risk record's own direct reference field
   * is never populated in this org's data, so — same trick as categories —
   * reuse whichever scheme OTHER risks in the SAME business unit use MOST
   * OFTEN. Ranking by frequency (not just first match) matters here: a
   * business unit can have one stray/test assessment using an unrelated
   * scheme alongside many legitimate ones using the real scheme — an
   * unordered "first match" query picked the stray one in a real case we
   * caught (1 assessment on a wrong scheme vs. 15 on the correct one).
   */
  private async discoverMatrixScheme(riskId: string): Promise<string | null> {
    const riskTable = this.table('Risk');
    const profileField = riskTable?.relationships.profile;
    if (!riskTable || !profileField) return null;

    const riskRows = await this.querySOQL<any>(`SELECT ${profileField} FROM ${riskTable.sourceTableName} WHERE Id = '${riskId}' LIMIT 1`);
    const businessUnitId = riskRows[0]?.[profileField];
    if (!businessUnitId) return null;

    const peerRisks = await this.querySOQL<any>(`SELECT Id FROM ${riskTable.sourceTableName} WHERE ${profileField} = '${businessUnitId}' LIMIT 200`);
    if (peerRisks.length === 0) return null;
    const riskIds = peerRisks.map(r => `'${r.Id}'`).join(',');

    const schemeCounts = await this.querySOQL<any>(
      `SELECT Risk__Matrix_Scoring_Scheme__c sch, COUNT(Id) cnt FROM Risk__Risk_Assessment__c ` +
      `WHERE Risk__Risk__c IN (${riskIds}) AND Risk__Matrix_Scoring_Scheme__c != null ` +
      `GROUP BY Risk__Matrix_Scoring_Scheme__c ORDER BY COUNT(Id) DESC LIMIT 1`
    );
    return schemeCounts[0]?.sch || null;
  }

  /**
   * Approximate Band tier from a 0-100 Value, based on the pattern observed
   * in real org data (quartile-like) — NOT the package's own verified
   * threshold formula, which is hidden inside protected managed-package Apex.
   */
  private deriveBand(value: number): number {
    if (value <= 25) return 1;
    if (value <= 50) return 2;
    if (value <= 75) return 3;
    return 4;
  }

  /**
   * Risk-package-specific enrichment (Risk__ namespace fields with no
   * agnostic-model equivalent): writes an approximate Band per rating row,
   * plus a rollup Inherent Score / Likelihood / Impact Band Label onto the
   * parent assessment. Only activates when the assessment table is actually
   * this exact package's object — there's no discoverable concept for these
   * fields on other platforms, so this is a deliberate, scoped exception to
   * the generic adapter design, not a general capability.
   */
  async finalizeInherentAssessment(assessmentId: string): Promise<void> {
    const assessmentTable = this.table('AssessmentInstance');
    if (!assessmentTable || assessmentTable.sourceTableName !== 'Risk__Risk_Assessment__c') return;

    const factorTable = findAllTables(this.config, 'Factor').find(x => x.relationships.assessment && !x.relationships.control);
    if (!factorTable) return;

    const rows = await this.querySOQL<any>(
      `SELECT Id, Risk__Category__c, Risk__Value__c FROM ${factorTable.sourceTableName} ` +
      `WHERE ${factorTable.relationships.assessment} = '${assessmentId}' AND Risk__Mitigation__c = 'Inherent' AND Risk__Value__c != null`
    );
    if (rows.length === 0) return;

    const scoreToLabel = (v: number): string =>
      Object.keys(INHERENT_FACTOR_SCALE).find(k => INHERENT_FACTOR_SCALE[k] === v) || 'Medium';

    const bands: Record<string, number> = {};
    for (const r of rows) {
      const band = this.deriveBand(r.Risk__Value__c);
      bands[r.Risk__Category__c] = band;
      await this.restUpdate(factorTable.sourceTableName, r.Id, { Risk__Band__c: String(band) });
    }

    const likelihoodBand = bands['Likelihood'] ?? Math.max(...Object.values(bands));
    const otherBands = Object.entries(bands).filter(([k]) => k !== 'Likelihood').map(([, v]) => v);
    const impactBand = bands['Impact'] ?? Math.max(...otherBands, likelihoodBand);
    const rollup = likelihoodBand * impactBand;

    const likelihoodRow = rows.find(r => r.Risk__Category__c === 'Likelihood');
    const impactRow = rows.find(r => r.Risk__Category__c === 'Impact');

    const payload: Record<string, any> = { Risk__Inherent_Rating_Score__c: rollup };
    if (likelihoodRow) payload.Risk__Inherent_Likelihood_Band_Label__c = scoreToLabel(likelihoodRow.Risk__Value__c);
    if (impactRow) payload.Risk__Inherent_Impact_Band_Label__c = scoreToLabel(impactRow.Risk__Value__c);

    await this.restUpdate('Risk__Risk_Assessment__c', assessmentId, payload);
    console.log(`[DynamicAdapter:${this.config.platformName}] Finalized ${assessmentId}: rollup=${rollup} (Likelihood ${likelihoodBand} x Impact ${impactBand}), banded ${rows.length} rating row(s). NOTE: Band/rollup values are an approximation — see code comments.`);
  }

  /** Walks a possibly-dotted SOQL relationship path (e.g. "Lookup__r.Field__c") through a nested query result. */
  private readDotted(obj: any, path: string): any {
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
  }

  /**
   * Salesforce convention: a custom lookup field `X__c` exposes the related
   * record's name as `X__r.Name` (works at the end of dotted paths too).
   * Returns null for fields that don't follow the convention.
   */
  private relNameField(lookupField: string | undefined): string | null {
    if (!lookupField || !lookupField.endsWith('__c')) return null;
    return lookupField.replace(/__c$/, '__r.Name');
  }

  async getControlFactorRows(instanceSysId: string): Promise<FactorResponse[]> {
    // Control-effectiveness answer rows: needs a Factor table that links to
    // BOTH a control and (directly or via a dotted junction path) the
    // assessment/risk context.
    const t = this.factorTableWith('control', 'assessment');
    const assessmentField = t?.relationships.assessment;
    const controlField = t?.relationships.control;
    if (!t || !assessmentField || !controlField) return [];

    // A dotted relationship path (e.g. a junction object's lookup field)
    // means this table links to the assessment indirectly through the risk,
    // not by the assessment's own Id — resolve the risk first.
    let filterValue = instanceSysId;
    if (assessmentField.includes('.')) {
      const inst = await this.getAssessmentInstance(instanceSysId);
      if (!inst || !inst.riskSysId) return [];
      filterValue = inst.riskSysId;
      // Having a risk-control junction link is not sufficient — this
      // package needs a SEPARATE "answer row" per junction before it can be
      // scored, and nothing else creates one (confirmed live: a risk with 3
      // real junction links but 0 answer rows returns "no control-linked
      // responses found" otherwise). Create any missing ones now.
      await this.bootstrapControlAssessmentRows(inst.riskSysId, t.sourceTableName);
    }

    const controlNameField = this.relNameField(controlField);
    const selectFields = [...new Set(['Id', ...t.fieldMappings.map(f => f.sourceField), controlField, ...(controlNameField ? [controlNameField] : [])])];
    const rows = await this.querySOQL<any>(
      `SELECT ${selectFields.join(', ')} FROM ${t.sourceTableName} WHERE ${assessmentField} = '${filterValue}' AND ${controlField} != null LIMIT 100`
    );
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      const controlSysId = controlField.includes('.') ? this.readDotted(r, controlField) : r[controlField];
      const controlName = controlNameField ? this.readDotted(r, controlNameField) : null;
      return {
        sysId: r.Id,
        factorSysId: r.Id,
        factorName: rec.factorName || 'Control Effectiveness Factor',
        controlSysId: String(controlSysId || ''),
        controlName: String(controlName || rec.controlName || '')
      };
    });
  }

  async getAnswerableManualRows(instanceSysId: string): Promise<Factor[]> {
    // Inherent rating rows: needs a Factor table linked to the assessment
    // but NOT organized around a control.
    const t = findAllTables(this.config, 'Factor').find(x => x.relationships.assessment && !x.relationships.control)
      || this.factorTableWith('assessment');
    const assessmentField = t?.relationships.assessment;
    if (!t || !assessmentField) return [];
    const controlField = t.relationships.control;

    let query = `SELECT ${this.selectFieldList(t, controlField ? [controlField] : [])} FROM ${t.sourceTableName} WHERE ${assessmentField} = '${instanceSysId}'`;
    if (controlField) query += ` AND ${controlField} = null`;
    query += ' LIMIT 50';

    const rows = await this.querySOQL<any>(query);
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      const name = rec.factorName || 'Inherent Factor';
      return {
        sysId: r.Id,
        factorSysId: r.Id,
        factorName: name,
        factorDesc: rec.factorDesc || `Inherent ${name} rating — assess before controls.`,
        guidance: rec.guidance || 'Rate Low, Medium, or High based on standard rubric guidance for this factor.',
        choiceList: Object.keys(INHERENT_FACTOR_SCALE),
        choiceMap: INHERENT_FACTOR_SCALE
      };
    });
  }

  async getFactorChoices(factorSysId: string): Promise<Factor | null> {
    // factorSysId here is the row sysId produced by getControlFactorRows —
    // generically onboarded platforms use the universal control-effectiveness
    // rubric (see module comment above) rather than a discovered scale.
    return {
      sysId: factorSysId,
      factorSysId,
      factorName: 'Control Effectiveness Factor',
      factorDesc: 'Universal control effectiveness rubric applied to generically onboarded platforms.',
      guidance: 'Select Satisfactory for zero open issues and passing tests, Needs Improvement for minor open issues, Weak for failing tests or missing evidence.',
      choiceList: Object.keys(CONTROL_EFFECTIVENESS_SCALE),
      choiceMap: CONTROL_EFFECTIVENESS_SCALE
    };
  }

  async getControlEvidence(controlSysId: string): Promise<TestEvidence> {
    const empty: TestEvidence = {
      sysId: controlSysId,
      number: controlSysId,
      name: '',
      state: 'Unknown',
      effectiveness: 'Not Tested',
      status: 'Unknown',
      latestResult: 'No test evidence table mapped for this platform.',
      resultDate: '',
      openIssues: [],
      closedIssues: 0
    };

    const t = this.table('TestEvidence');
    const controlField = t?.relationships.control;
    if (!t || !controlField) return empty;

    const rows = await this.querySOQL<any>(
      `SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName} WHERE ${controlField} = '${controlSysId}' ORDER BY CreatedDate DESC LIMIT 1`
    );
    if (rows.length === 0) return empty;
    const rec = this.mapRecord(t, rows[0]);

    return {
      sysId: controlSysId,
      number: rows[0].Id || controlSysId,
      name: rec.name || '',
      state: rec.state || 'Active',
      effectiveness: rec.effectiveness || 'Not Tested',
      status: rec.status || 'Unknown',
      latestResult: rec.latestResult || 'No test result notes on record.',
      resultDate: rec.resultDate || '',
      openIssues: [],
      closedIssues: 0
    };
  }

  // --------------------------------------------------------------------------
  // Prior Assessment Retrieval — not generically discoverable (requires
  // knowing which state value means "closed", which varies per org/schema).
  // --------------------------------------------------------------------------
  async getPriorClosedAssessment(): Promise<{ sysId: string; number: string } | null> {
    return null;
  }

  async getPriorControlAnswer() {
    return null;
  }

  // --------------------------------------------------------------------------
  // Write Operations — use writeHeuristics guessed during discovery. Any
  // missing guess is logged and skipped rather than silently failing.
  // --------------------------------------------------------------------------
  async writeControlEffectiveness(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    evidenceSummary: string,
    _auditTrail: string,
    fingerprint: string
  ): Promise<boolean> {
    // Write back to the same table getControlFactorRows read from.
    const t = this.factorTableWith('control', 'assessment');
    const wh = t?.writeHeuristics;
    if (!t || !wh || (!wh.scoreField && !wh.justificationField)) {
      console.warn(`[DynamicAdapter:${this.config.platformName}] No write-back fields detected for Factor table; skipping write for row ${rowSysId} (would have written rating '${ratingLabel}').`);
      return false;
    }
    const data: Record<string, any> = {};
    if (wh.scoreField) data[wh.scoreField] = score;
    if (wh.justificationField) data[wh.justificationField] = `${justification}\n\nEvidence: ${evidenceSummary}`;
    if (wh.fingerprintField) data[wh.fingerprintField] = fingerprint;

    // Risk-package-specific: verified live that Risk__Control_Effectiveness_Value__c
    // (wh.scoreField above) is a DERIVED field — hidden org automation
    // recalculates it from the Risk__Control_Effectiveness__c ("Design")
    // picklist and silently discards direct writes to Value itself (a
    // direct isolated PATCH to Value alone returned 204 but read back
    // null). The agent's rating vocabulary (Satisfactory/Needs
    // Improvement/Weak) doesn't match this picklist's real values
    // (Inadequate/Adequate/Effective/Strong & Effective), so translate.
    if (t.sourceTableName === 'Risk__Control_Assessment__c') {
      const designMap: Record<string, string> = {
        Satisfactory: 'Effective',
        'Needs Improvement': 'Adequate',
        Weak: 'Inadequate',
        'Needs Work': 'Adequate',
        Ineffective: 'Inadequate'
      };
      const ratingVal = designMap[ratingLabel] || ratingLabel;
      if (ratingVal) {
        data['Risk__Control_Effectiveness__c'] = ratingVal; // Design Rating
        data['Risk__Anticipated_Control_Effectiveness__c'] = ratingVal; // Performance Rating
        data['Risk__Overall_Control_Assessment__c'] = ratingVal; // Overall Rating
      }
    }

    const ok = await this.restUpdate(t.sourceTableName, rowSysId, data);
    if (ok) {
      console.log(`[DynamicAdapter:${this.config.platformName}] Updated ${t.sourceTableName} ${rowSysId} -> ${ratingLabel}`);
    }
    return ok;
  }

  async writeInherentFactor(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    comment: string
  ): Promise<boolean> {
    // Write back to the same table getAnswerableManualRows read from.
    const t = findAllTables(this.config, 'Factor').find(x => x.relationships.assessment && !x.relationships.control)
      || this.factorTableWith('assessment');
    const wh = t?.writeHeuristics;
    if (!t || !wh || (!wh.scoreField && !wh.justificationField)) {
      console.warn(`[DynamicAdapter:${this.config.platformName}] No write-back fields detected for Factor table; skipping write for row ${rowSysId} (would have written rating '${ratingLabel}').`);
      return false;
    }
    // Meaningful justification for field limit (255 chars for Risk__Justification__c)
    let cleanJustification = (justification || comment || '').trim();
    cleanJustification = cleanJustification.replace(/^[🔍\s\S]*CONCLUSION:\s*/i, '').trim();

    const metadata = wh.justificationField
      ? this.config.fieldMetadata?.find(fm => fm.sourceTableName === t.sourceTableName && fm.sourceFieldName === wh.justificationField)
      : null;
    const maxChars = metadata?.maxCharacters || 255;

    if (cleanJustification.length > maxChars) {
      const truncated = cleanJustification.substring(0, maxChars);
      const lastPeriod = Math.max(truncated.lastIndexOf('. '), truncated.lastIndexOf('.'));
      if (lastPeriod > 80) {
        cleanJustification = truncated.substring(0, lastPeriod + 1);
      } else {
        const lastSpace = truncated.lastIndexOf(' ');
        cleanJustification = lastSpace > 0 ? truncated.substring(0, lastSpace) + '.' : truncated;
      }
    }

    const data: Record<string, any> = {};
    if (wh.scoreField) data[wh.scoreField] = score;
    if (wh.justificationField) data[wh.justificationField] = cleanJustification;

    const ok = await this.restUpdate(t.sourceTableName, rowSysId, data);
    if (ok) {
      console.log(`[DynamicAdapter:${this.config.platformName}] Updated ${t.sourceTableName} ${rowSysId} -> ${ratingLabel}`);
    }
    return ok;
  }

  /**
   * A risk-control junction table has no read-side agnostic model in the
   * concept catalog (it's a relationship, not a record type), so its name
   * can't be vector/LLM-discovered the way Risk/Control/Factor tables are.
   * Derive it instead from the dotted relationship path already found on
   * the Factor table's 'control' link (e.g.
   * "Risk__Risk_Control_Lookup__r.Risk__Control__c" -> junction object
   * "Risk__Risk_Control_Lookup__c") rather than hardcoding it separately.
   */
  private deriveRiskControlJunctionTable(): string | null {
    const factorTable = findAllTables(this.config, 'Factor').find(t => t.relationships.control?.includes('.'));
    const controlRel = factorTable?.relationships.control || '';
    const junctionRelName = controlRel.split('.')[0];
    return junctionRelName.endsWith('__r') ? junctionRelName.replace(/__r$/, '__c') : null;
  }

  /**
   * Having a risk-control junction link is not sufficient to score control
   * effectiveness in this package — it needs a SEPARATE per-junction
   * "answer row" (on the Factor table, e.g. Risk__Control_Assessment__c)
   * before anything can be scored, and nothing else in this org creates
   * one. Confirmed live: a risk with 3 real junction links but 0 answer
   * rows returned "no control-linked responses found." Create any missing
   * answer rows now so getControlFactorRows has something to find.
   */
  private async bootstrapControlAssessmentRows(riskSysId: string, factorTableName: string): Promise<void> {
    const junctionTable = this.deriveRiskControlJunctionTable();
    if (!junctionTable) return;

    const junctions = await this.querySOQL<any>(`SELECT Id FROM ${junctionTable} WHERE Risk__Risk__c = '${riskSysId}'`);
    if (junctions.length === 0) return;

    const junctionIds = junctions.map(j => `'${j.Id}'`).join(',');
    const existingAnswers = await this.querySOQL<any>(
      `SELECT Risk__Risk_Control_Lookup__c FROM ${factorTableName} WHERE Risk__Risk_Control_Lookup__c IN (${junctionIds})`
    );
    const alreadyAnswered = new Set(existingAnswers.map(a => a.Risk__Risk_Control_Lookup__c));

    for (const junction of junctions) {
      if (alreadyAnswered.has(junction.Id)) continue;
      const id = await this.restCreate(factorTableName, { Risk__Risk_Control_Lookup__c: junction.Id });
      if (id) {
        console.log(`[DynamicAdapter:${this.config.platformName}] Created missing control-assessment answer row ${id} for junction ${junction.Id}.`);
      }
    }
  }

  async writeRiskControlMapping(
    riskSysId: string,
    matchedControls: Array<{ sysId: string; reason: string }>,
    justification?: string,
    gaps?: string,
    recommendations?: string
  ): Promise<boolean> {
    if (this.supportsLiveQueries() && (justification || gaps || recommendations)) {
      let recsHtml = '';
      if (recommendations) {
        const lines = recommendations.split('\n').filter(l => l.trim().length > 0);
        if (lines.length > 1 || recommendations.match(/^\d+\./m)) {
          recsHtml = '<ul>' + lines.map(l => `<li>${l.replace(/^\d+\.\s*/, '').trim()}</li>`).join('') + '</ul>';
        } else {
          recsHtml = `<p>${recommendations}</p>`;
        }
      } else {
        recsHtml = '<p>None</p>';
      }

      const narrativeContent = [
        '<h3>🔍 RISK-CONTROL MAPPING ANALYSIS</h3>',
        '<p><b>RATIONALE:</b><br/>' + (justification || 'N/A').replace(/\n/g, '<br/>') + '</p>',
        '<p><b>GAPS:</b><br/>' + (gaps || 'N/A').replace(/\n/g, '<br/>') + '</p>',
        '<p><b>RECOMMENDATIONS:</b></p>',
        recsHtml,
        `<p style="color:#666; font-size:12px; margin-top:12px;"><i>Generated by Risk-Control Mapping Agent · ${new Date().toISOString()}</i></p>`
      ].join('');

      await this.restUpdate('grc__Risk__c', riskSysId, {
        ai_recommendation__c: narrativeContent.substring(0, 32768)
      });
      console.log(`[DynamicAdapter:${this.config.platformName}] Updated grc__Risk__c ${riskSysId}.ai_recommendation__c with rich HTML mapping narrative`);
    }

    const junctionTable = this.deriveRiskControlJunctionTable();
    if (!junctionTable) {
      console.warn(`[DynamicAdapter:${this.config.platformName}] Could not derive a risk-control junction object; ${matchedControls.length} match(es) for risk ${riskSysId} were NOT persisted.`);
      return false;
    }

    let allOk = true;
    for (const ctrl of matchedControls) {
      // Avoid duplicate links if this risk/control pair is already mapped.
      const existing = await this.querySOQL<any>(
        `SELECT Id FROM ${junctionTable} WHERE Risk__Risk__c = '${riskSysId}' AND Risk__Control__c = '${ctrl.sysId}' LIMIT 1`
      );
      if (existing.length > 0) {
        console.log(`[DynamicAdapter:${this.config.platformName}] Risk-control link already exists for control ${ctrl.sysId}, skipping.`);
        continue;
      }
      const id = await this.restCreate(junctionTable, {
        Risk__Risk__c: riskSysId,
        Risk__Control__c: ctrl.sysId,
        Risk__Control_Assessment_Justification__c: ctrl.reason
      });
      if (id) {
        console.log(`[DynamicAdapter:${this.config.platformName}] Linked control ${ctrl.sysId} to risk ${riskSysId} (${id}).`);
      } else {
        allOk = false;
      }
    }
    return allOk;
  }

  async writeObservabilityTrace(payload: {
    agentName: string;
    targetId: string;
    outcome: string;
    results?: any;
    html: string;
    riskSysId?: string;
    assessmentNumber?: string;
    summary?: string;
  }): Promise<void> {
    if (this.supportsLiveQueries()) {
      try {
        const token = await this.getAccessToken();
        const riskId = payload.riskSysId || (payload.targetId.startsWith('a6l') ? payload.targetId : null);
        const cleanSummary = (typeof (require('./salesforce').convertHtmlToPlainText) === 'function')
          ? require('./salesforce').convertHtmlToPlainText(payload.html || payload.summary || '')
          : (payload.html || payload.summary || '').replace(/<[^>]+>/g, '');

        const emaPayload: any = {
          Name: `${payload.agentName} - ${(riskId || payload.targetId).substring(0, 15)}`.substring(0, 80),
          Ema_Audit_Summary__c: cleanSummary.substring(0, 32768),
          Risk_Assessment_Number__c: (payload.assessmentNumber || payload.agentName).substring(0, 20)
        };
        if (riskId) {
          emaPayload.Risk__c = riskId;
        }

        const response = await axios.post(
          `${this.instanceUrl}/services/data/v60.0/sobjects/Ema_Audit_Trail__c`,
          emaPayload,
          {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
          }
        );
        console.log(`[DynamicAdapter:${this.config.platformName}] ✅ Created Ema_Audit_Trail__c record ${response.data.id} for ${payload.agentName}`);
      } catch (err: any) {
        console.warn(`[DynamicAdapter:${this.config.platformName}] ⚠️ Failed to write EMA audit trail: ${err.message}`);
      }
    }
  }

  async writeFailure(rowSysId: string, reason: string): Promise<void> {
    const t = this.table('Factor');
    const justificationField = t?.writeHeuristics?.justificationField;
    if (!t || !justificationField) {
      console.warn(`[DynamicAdapter:${this.config.platformName}] Row ${rowSysId} failed: ${reason} (no justification field to record it against)`);
      return;
    }
    await this.restUpdate(t.sourceTableName, rowSysId, { [justificationField]: `❌ Ema assessment failed: ${reason}` });
  }
}
