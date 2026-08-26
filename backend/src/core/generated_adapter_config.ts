import fs from 'fs';
import path from 'path';
import { AgnosticModelName } from './concept_catalog';

// On Vercel (and other serverless runtimes) the filesystem is read-only
// except for /tmp. Dynamically onboarded adapter configs go there when
// running serverless; note they will NOT survive a cold start in that case.
const IS_SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const CONFIG_DIR = IS_SERVERLESS
  ? '/tmp/grc-generated-adapters'
  : path.join(__dirname, '..', '..', 'generated_adapters');

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

// Field-level metadata discovered during schema introspection
export interface FieldMetadata {
  sourceTableName: string;
  sourceFieldName: string;
  dataType: string; // 'text', 'textarea', 'richtext', 'picklist', 'number', etc.
  maxCharacters?: number;
  truncationStrategy?: 'word-boundary' | 'char-limit' | 'none'; // how to truncate if too long
  description?: string;
}

// Platform-specific terminology mapping (entity → business unit, etc.)
export interface PlatformTerminology {
  [genericTerm: string]: string; // 'entity' → 'business unit'
}

// Related fields that represent the same concept (e.g., Design + Performance effectiveness)
export interface FieldRelationship {
  concept: string; // 'control-effectiveness', 'inherent-assessment', etc.
  fields: Array<{
    sourceTableName: string;
    sourceFieldName: string;
    roleName: string; // 'design', 'performance', 'overall', etc.
  }>;
}

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
  // NEW: Field metadata for smart writing (character limits, types, truncation)
  fieldMetadata?: FieldMetadata[];
  // NEW: Platform terminology mapping (entity → business unit, etc.)
  terminology?: PlatformTerminology;
  // NEW: Related fields for concepts (Design + Performance = control effectiveness)
  fieldRelationships?: FieldRelationship[];
}

export function configPathFor(platformName: string): string {
  const safeName = platformName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CONFIG_DIR, `${safeName}.json`);
}

export function saveAdapterConfig(config: GeneratedAdapterConfig): string {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const filePath = configPathFor(config.platformName);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  return filePath;
}

const BUNDLED_DIR = path.join(__dirname, '..', '..', 'generated_adapters');

export function loadAdapterConfig(platformName: string): GeneratedAdapterConfig | null {
  const safeName = platformName.replace(/[^a-zA-Z0-9_-]/g, '_');
  
  // Try CONFIG_DIR (/tmp) first
  const fileInConfig = path.join(CONFIG_DIR, `${safeName}.json`);
  if (fs.existsSync(fileInConfig)) {
    try {
      return JSON.parse(fs.readFileSync(fileInConfig, 'utf-8')) as GeneratedAdapterConfig;
    } catch (e) {}
  }
  
  // Try BUNDLED_DIR (pre-bundled)
  const fileInBundled = path.join(BUNDLED_DIR, `${safeName}.json`);
  if (fs.existsSync(fileInBundled)) {
    try {
      return JSON.parse(fs.readFileSync(fileInBundled, 'utf-8')) as GeneratedAdapterConfig;
    } catch (e) {}
  }
  
  return null;
}

export function loadAdapterConfigFromPath(filePath: string): GeneratedAdapterConfig | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as GeneratedAdapterConfig;
}

export function listAllAdapterConfigs(): GeneratedAdapterConfig[] {
  const configsMap = new Map<string, GeneratedAdapterConfig>();

  const loadFromDir = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const config = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as GeneratedAdapterConfig;
            if (config && config.platformName) {
              configsMap.set(config.platformName, config);
            }
          } catch (e) {
            console.error(`[generated_adapter_config] Failed to parse config file ${file} in ${dir}:`, e);
          }
        }
      }
    } catch (e) {
      console.error(`[generated_adapter_config] Failed to read dir ${dir}:`, e);
    }
  };

  loadFromDir(BUNDLED_DIR);
  if (CONFIG_DIR !== BUNDLED_DIR) {
    loadFromDir(CONFIG_DIR);
  }

  return Array.from(configsMap.values());
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
