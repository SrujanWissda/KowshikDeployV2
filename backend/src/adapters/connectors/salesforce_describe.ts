import axios from 'axios';

// ============================================================================
// Salesforce Live Schema Introspection Connector
//
// Reuses the same OAuth 2.0 client-credentials flow as SalesforceAdapter to
// call Salesforce's own describe APIs, so the Universal Schema Discovery
// agent can learn a brand-new org's object model automatically instead of
// requiring a human to paste schema text.
// ============================================================================

export interface DiscoveredField {
  name: string;
  label: string;
  type: string;
}

export interface DiscoveredTable {
  name: string;
  label: string;
  custom: boolean;
  fields: DiscoveredField[];
}

// Heuristic keywords used to shortlist candidate objects out of a large org
// before paying the cost of a full per-object describe call on everything.
const GRC_KEYWORDS = ['risk', 'control', 'issue', 'assess', 'grc', 'compliance', 'audit', 'test', 'factor', 'finding'];

export class SalesforceDescribeConnector {
  private cachedToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(
    private instanceUrl: string,
    private clientId: string,
    private clientSecret: string
  ) {
    this.instanceUrl = instanceUrl.replace(/\/$/, '');
  }

  isConfigured(): boolean {
    return !!(this.instanceUrl && this.clientId && this.clientSecret);
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

  /**
   * Global describe — every queryable real data object in the org, with no
   * relevance filtering. Feeds purpose-based semantic ranking in the
   * discovery agent, which replaced keyword matching as the primary
   * candidate-selection mechanism.
   */
  async listAllObjects(): Promise<Array<{ name: string; label: string; custom: boolean }>> {
    const token = await this.getAccessToken();
    const response = await axios.get(`${this.instanceUrl}/services/data/v60.0/sobjects`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000
    });

    // Salesforce auto-generates companion objects for every custom object
    // (activity feed, field-history tracking, sharing rules, change events).
    // These aren't real data tables, so they'd otherwise pollute candidate
    // ranking with objects the LLM correctly declines to map.
    const SYSTEM_COMPANION_SUFFIX = /__(Feed|History|Share|ChangeEvent|Tag)$/i;

    return (response.data.sobjects || [])
      .filter((o: any) => o.queryable && !SYSTEM_COMPANION_SUFFIX.test(o.name))
      .map((o: any) => ({ name: o.name, label: o.label, custom: !!o.custom }));
  }

  /** Keyword-scored shortlist — retained only as the fallback when no semantic embedding backend is available. */
  async listCandidateObjects(maxObjects: number = 20): Promise<Array<{ name: string; label: string; custom: boolean }>> {
    const all = await this.listAllObjects();

    const scored = all
      .map(o => {
        const haystack = `${o.name} ${o.label}`.toLowerCase();
        const hits = GRC_KEYWORDS.filter(k => haystack.includes(k)).length;
        return { obj: o, hits };
      })
      .filter(s => s.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map(s => s.obj);

    return scored.slice(0, maxObjects);
  }

  /** Per-object describe — full field list with types and labels. */
  async describeObject(objectName: string): Promise<DiscoveredTable> {
    const token = await this.getAccessToken();
    const response = await axios.get(`${this.instanceUrl}/services/data/v60.0/sobjects/${objectName}/describe`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000
    });

    const fields: DiscoveredField[] = (response.data.fields || []).map((f: any) => ({
      name: f.name,
      label: f.label,
      type: f.type
    }));

    return {
      name: response.data.name,
      label: response.data.label,
      custom: !!response.data.custom,
      fields
    };
  }

  /** Full discovery pass: shortlist candidate objects, then describe each. */
  async discoverSchema(maxObjects: number = 15): Promise<DiscoveredTable[]> {
    const candidates = await this.listCandidateObjects(maxObjects);
    const tables: DiscoveredTable[] = [];
    for (const candidate of candidates) {
      try {
        tables.push(await this.describeObject(candidate.name));
      } catch (e: any) {
        console.warn(`[SalesforceDescribeConnector] Failed to describe ${candidate.name}: ${e.message}`);
      }
    }
    return tables;
  }

  /** Pulls a handful of real sample records for validating a candidate field mapping. */
  async sampleRecords(tableName: string, fieldNames: string[], limit: number = 3): Promise<any[]> {
    const token = await this.getAccessToken();
    // Dedupe — callers commonly pass 'Id' both explicitly and as part of a
    // field-mapping list that already includes it, and Salesforce rejects a
    // SOQL SELECT with a repeated field as a malformed query (400).
    const safeFields = [...new Set(fieldNames.filter(f => /^[A-Za-z0-9_]+$/.test(f)))];
    if (safeFields.length === 0) return [];
    const soql = `SELECT ${safeFields.join(', ')} FROM ${tableName} LIMIT ${limit}`;
    const response = await axios.get(`${this.instanceUrl}/services/data/v60.0/query`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: soql },
      timeout: 20000
    });
    return response.data.records || [];
  }
}
