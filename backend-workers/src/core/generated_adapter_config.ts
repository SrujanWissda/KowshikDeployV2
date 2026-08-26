import { AgnosticModelName } from './concept_catalog';

// KV replaces the old `backend/generated_adapters/*.json` directory. Key
// scheme mirrors the old file-name sanitization exactly (`configPathFor`),
// just as a KV key prefix instead of a directory + filename.
const KEY_PREFIX = 'config:';

export interface FieldMapping {
  sourceField: string;
  agnosticField: string;
  rationale: string;
  confidence: number; // cosine similarity score that produced this shortlist entry, 0-1
}

// Foreign-key style links between tables, keyed by a well-known relation
// name the DynamicAdapter looks for (e.g. 'profile', 'risk', 'assessment',
// 'control', 'factor'). Value is the source field name on THIS table that
// points at the related table.
export type RelationshipMap = Record<string, string>;

// Best-effort guesses (by field name/label pattern) at which raw source
// fields are used to write assessment results back — these are never part
// of the read-side agnostic model, so they can't come from vector/LLM
// concept matching. DynamicAdapter treats these as optional: if a guess is
// missing, it logs a warning and skips the write rather than failing.
export interface WriteHeuristics {
  scoreField?: string;
  justificationField?: string;
  fingerprintField?: string;
}

export interface TableMapping {
  sourceTableName: string;
  targetAgnosticModel: AgnosticModelName;
  fieldMappings: FieldMapping[];
  relationships: RelationshipMap;
  writeHeuristics?: WriteHeuristics;
  confidence: number; // average field-mapping confidence for this table
}

export interface SampleCheck {
  table: string;
  ok: boolean;
  notes: string;
}

export type ConnectionType = 'salesforce-soql' | 'servicenow-table-api' | 'generic-rest';

export interface GeneratedAdapterConfig {
  platformName: string;
  connectionType: ConnectionType;
  entityLabel: string;
  generatedAt: string;
  schemaFingerprint: string;
  origin: 'live-introspection' | 'pasted-metadata' | 'reused-cache';
  tables: TableMapping[];
  validation: {
    validated: boolean;
    sampleChecks: SampleCheck[];
  };
}

export function configKeyFor(platformName: string): string {
  const safeName = platformName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${KEY_PREFIX}${safeName}`;
}

export async function saveAdapterConfig(kv: KVNamespace, config: GeneratedAdapterConfig): Promise<string> {
  const key = configKeyFor(config.platformName);
  await kv.put(key, JSON.stringify(config));
  return key;
}

export async function loadAdapterConfig(kv: KVNamespace, platformName: string): Promise<GeneratedAdapterConfig | null> {
  return loadAdapterConfigFromKey(kv, configKeyFor(platformName));
}

export async function loadAdapterConfigFromKey(kv: KVNamespace, key: string): Promise<GeneratedAdapterConfig | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  return JSON.parse(raw) as GeneratedAdapterConfig;
}

export async function listAllAdapterConfigs(kv: KVNamespace): Promise<GeneratedAdapterConfig[]> {
  const configs: GeneratedAdapterConfig[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: KEY_PREFIX, cursor });
    const values = await Promise.all(page.keys.map(k => kv.get(k.name)));
    for (const raw of values) {
      if (raw) configs.push(JSON.parse(raw) as GeneratedAdapterConfig);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return configs;
}

export function findTable(config: GeneratedAdapterConfig, model: AgnosticModelName): TableMapping | undefined {
  return findAllTables(config, model)[0];
}

/** All candidates for a model, usable ones first, ranked by confidence. */
export function findAllTables(config: GeneratedAdapterConfig, model: AgnosticModelName): TableMapping[] {
  const candidates = config.tables.filter(t => t.targetAgnosticModel === model);
  // A table with zero field mappings is unusable regardless of its confidence
  // score — vector-similarity confidence is a rough pre-filter, not a
  // guarantee of quality (this bit especially when the real embeddings API
  // was unavailable and matching fell back to a weaker local hash vector).
  // Prefer any candidate that actually has mapped fields over one that doesn't.
  const withFields = candidates.filter(t => t.fieldMappings.length > 0);
  const pool = withFields.length > 0 ? withFields : candidates;
  return pool.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Same-concept tables sometimes represent different assessment *stages*
 * (e.g. a "Risk Assessment" header for inherent-stage vs. a "Control
 * Assessment" junction for control-stage) — something the read-only concept
 * catalog has no way to know, since it isn't a schema-shape distinction.
 * When more than one AssessmentInstance candidate exists, prefer the one
 * whose name doesn't/does contain "Control" depending on which stage the
 * caller is working in.
 */
export function findTableForAgent(config: GeneratedAdapterConfig, model: AgnosticModelName, agent?: string): TableMapping | undefined {
  const all = findAllTables(config, model);
  if (all.length <= 1) return all[0];

  const isControlNamed = (t: TableMapping) => /control/i.test(t.sourceTableName);
  const preferNonControl = agent === 'inherent-assessment';

  const preferred = all.filter(t => isControlNamed(t) !== preferNonControl);
  return (preferred[0]) || all[0];
}

export function sourceFieldFor(table: TableMapping, agnosticField: string): string | undefined {
  return table.fieldMappings.find(f => f.agnosticField === agnosticField)?.sourceField;
}
