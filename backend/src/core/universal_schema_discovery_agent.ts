import { BaseLLMClient } from '../llm/llm_client';
import { BaseEmbeddingsClient } from '../llm/embeddings_client';
import { VectorStore, computeSchemaFingerprint, ConceptVectorItem } from './vector_store';
import { AgnosticModelName } from './concept_catalog';
import { SalesforceDescribeConnector, DiscoveredTable, DiscoveredField } from '../adapters/connectors/salesforce_describe';
import {
  GeneratedAdapterConfig,
  TableMapping,
  FieldMapping,
  RelationshipMap,
  WriteHeuristics,
  SampleCheck,
  ConnectionType,
  saveAdapterConfig,
  loadAdapterConfigFromPath
} from './generated_adapter_config';

// Name/label patterns used to guess which raw fields are meant for writing
// assessment results back (score, justification, change-detection fingerprint).
// These are write-only concepts with no read-side analogue in the concept
// catalog, so they can't be vector-matched — a naming heuristic is the only
// generic option short of asking the user to hand-map them.
function computeWriteHeuristics(table: DiscoveredTable): WriteHeuristics {
  const heuristics: WriteHeuristics = {};
  const numericTypes = new Set(['double', 'int', 'currency', 'percent', 'number']);
  const textTypes = new Set(['string', 'textarea', 'picklist', 'richtext', 'html']);

  for (const field of table.fields) {
    const haystack = `${field.name} ${field.label}`.toLowerCase();
    if (!heuristics.scoreField && numericTypes.has(field.type) && /score|value|rating|effectiveness/i.test(haystack)) {
      heuristics.scoreField = field.name;
    }
    if (!heuristics.justificationField && textTypes.has(field.type) && /justif|comment|rationale|reason|note/i.test(haystack)) {
      heuristics.justificationField = field.name;
    }
    if (!heuristics.fingerprintField && /hash|fingerprint|checksum/i.test(haystack)) {
      heuristics.fingerprintField = field.name;
    }
  }
  return heuristics;
}

interface FieldCandidate {
  field: DiscoveredField;
  matches: Array<ConceptVectorItem & { score: number }>;
}

interface TableShortlistEntry {
  table: DiscoveredTable;
  topModel: AgnosticModelName;
  modelScore: number;
  fieldCandidates: FieldCandidate[];
}

// Vector scores from the local hashing fallback are much weaker than real
// semantic embeddings, so we only use this as a coarse pre-filter — the LLM
// confirmation step (stage 3) is what actually decides the mapping. This
// threshold just prunes obviously irrelevant tables before spending an LLM
// call on them.
const TABLE_MATCH_MIN_SCORE = 0.08;

export class UniversalSchemaDiscoveryAgent {
  constructor(
    private llm: BaseLLMClient,
    private embeddings: BaseEmbeddingsClient,
    private vectorStore: VectorStore
  ) {}

  /**
   * Full 4-stage pipeline against a live-connected platform:
   * introspect -> vector-shortlist -> LLM-confirm -> sample-validate.
   */
  /**
   * Purpose-based candidate ranking. Instead of keyword-matching object
   * names, every queryable object in the org is embedded (label + API name)
   * and scored by cosine similarity against (a) the purpose descriptions of
   * gold-standard tables learned from the hand-written ServiceNow/Salesforce
   * adapters and (b) the agnostic concept catalog. An object is selected
   * because its meaning matches a known table's USE — e.g. "assessment
   * header linking a risk to its lifecycle" — not because its name contains
   * "risk". Requires a live embedding backend; falls back to the keyword
   * shortlist otherwise.
   */
  async rankCandidateObjects(
    connector: SalesforceDescribeConnector,
    topK: number = 15
  ): Promise<Array<{ name: string; label: string; custom: boolean; score: number; matchedPurpose: string; matchedModel: AgnosticModelName }>> {
    const objects = await connector.listAllObjects();
    console.log(`[UniversalSchemaDiscovery] Semantic ranking over ${objects.length} org object(s)...`);

    const goldVectors = await this.vectorStore.ensureGoldStandardVectors(this.embeddings);
    const conceptVectors = await this.vectorStore.ensureConceptVectors(this.embeddings);
    const tableConcepts = conceptVectors.filter(c => c.field === null);

    const texts = objects.map(o => `${o.label} (${o.name})`);
    const vectors = await this.embeddings.embedBatch(texts);

    const ranked = objects.map((o, i) => {
      const gold = this.vectorStore.nearestGoldStandards(vectors[i], 1)[0];
      const concept = this.vectorStore.nearestConcepts(vectors[i], 1, tableConcepts)[0];
      const useGold = (gold?.score ?? 0) >= (concept?.score ?? 0);
      return {
        name: o.name,
        label: o.label,
        custom: o.custom,
        score: useGold ? (gold?.score ?? 0) : (concept?.score ?? 0),
        matchedPurpose: useGold
          ? `${gold.sourceTableName} (${gold.platform} reference): ${gold.text.split(': ')[1] || gold.text}`
          : concept.text,
        matchedModel: (useGold ? gold?.model : concept?.model) as AgnosticModelName
      };
    }).sort((a, b) => b.score - a.score);

    return topK > 0 ? ranked.slice(0, topK) : ranked;
  }

  /**
   * Coverage-aware candidate selection: the pipeline needs at least one
   * table for EACH agnostic concept, so take the top-N objects per matched
   * model rather than a flat global top-K. A flat cutoff lets whichever
   * concept has the most lookalike objects (usually Risk/Control) crowd out
   * rarer but essential ones like the assessment header.
   */
  private selectCoverageCandidates(
    ranked: Array<{ name: string; label: string; custom: boolean; score: number; matchedPurpose: string; matchedModel: AgnosticModelName }>,
    perModel: number = 3
  ): typeof ranked {
    const counts: Partial<Record<AgnosticModelName, number>> = {};
    const chosen: typeof ranked = [];
    for (const c of ranked) {
      const n = counts[c.matchedModel] || 0;
      if (n < perModel) {
        chosen.push(c);
        counts[c.matchedModel] = n + 1;
      }
    }
    return chosen;
  }

  async executeLive(
    platformName: string,
    connector: SalesforceDescribeConnector,
    connectionType: ConnectionType,
    entityLabelHint?: string
  ): Promise<GeneratedAdapterConfig> {
    // ---- Stage 1: Live introspection with purpose-based candidate selection ----
    console.log(`[UniversalSchemaDiscovery] Introspecting live schema for platform '${platformName}'...`);
    let rawTables: DiscoveredTable[];
    // Purpose-match verdicts from coverage selection — carried into stage 2
    // so the LLM confirmation step starts from the gold-standard-informed
    // classification instead of re-deriving a weaker concept-only one.
    const modelHints = new Map<string, { model: AgnosticModelName; score: number }>();
    if (this.embeddings.isLive()) {
      const ranked = await this.rankCandidateObjects(connector, 0);
      const candidates = this.selectCoverageCandidates(ranked);
      console.log(`[UniversalSchemaDiscovery] Coverage-aware selection: ${candidates.map(c => `${c.name}→${c.matchedModel}`).join(', ')}`);
      rawTables = [];
      for (const c of candidates) {
        try {
          rawTables.push(await connector.describeObject(c.name));
          modelHints.set(c.name, { model: c.matchedModel, score: c.score });
        } catch (e: any) {
          console.warn(`[UniversalSchemaDiscovery] Failed to describe ${c.name}: ${e.message}`);
        }
      }
    } else {
      console.warn('[UniversalSchemaDiscovery] No live embedding backend — falling back to keyword-based candidate shortlist.');
      rawTables = await connector.discoverSchema();
    }
    if (rawTables.length === 0) {
      throw new Error('No candidate GRC-related objects found via live introspection.');
    }
    console.log(`[UniversalSchemaDiscovery] Discovered ${rawTables.length} candidate object(s): ${rawTables.map(t => t.name).join(', ')}`);

    const fingerprint = computeSchemaFingerprint(
      rawTables.map(t => ({ name: t.name, fields: t.fields.map(f => f.name) }))
    );

    const schemaSummaryText = rawTables
      .map(t => `${t.name} (${t.label}): ${t.fields.map(f => f.name).join(', ')}`)
      .join('\n');
    const schemaVector = await this.embeddings.embed(schemaSummaryText);

    // ---- Cache check: reuse a mapping from a near-identical previously onboarded schema ----
    const cached = this.vectorStore.findSimilarLearnedSchema(schemaVector);
    if (cached) {
      console.log(`[UniversalSchemaDiscovery] Found similar previously-learned schema '${cached.platformName}' (similarity ${cached.score.toFixed(3)}) — reusing its mapping with zero LLM calls.`);
      const reused = loadAdapterConfigFromPath(cached.configPath);
      if (reused) {
        const clone: GeneratedAdapterConfig = {
          ...reused,
          platformName,
          generatedAt: new Date().toISOString(),
          schemaFingerprint: fingerprint,
          origin: 'reused-cache'
        };
        saveAdapterConfig(clone);
        return clone;
      }
    }

    // ---- Stage 2: Vector-based concept matching ----
    const conceptVectors = await this.vectorStore.ensureConceptVectors(this.embeddings);
    const tableConceptVectors = conceptVectors.filter(c => c.field === null);
    const shortlist: TableShortlistEntry[] = [];

    for (const table of rawTables) {
      const tableText = `${table.name} (${table.label}): fields ${table.fields.map(f => `${f.name} (${f.label})`).join(', ')}`;
      const tableVec = await this.embeddings.embed(tableText);

      // Prefer the purpose-match verdict (gold-standard informed) when we
      // have one for this table; concept-only matching is the fallback.
      let best: { model: AgnosticModelName; score: number };
      const hint = modelHints.get(table.name);
      if (hint) {
        best = hint;
      } else {
        const tableMatches = this.vectorStore.nearestConcepts(tableVec, 3, tableConceptVectors);
        if (tableMatches.length === 0 || tableMatches[0].score < TABLE_MATCH_MIN_SCORE) {
          console.log(`[UniversalSchemaDiscovery] Skipping '${table.name}' — no plausible agnostic model match.`);
          continue;
        }
        best = tableMatches[0];
      }

      const fieldConceptVectors = conceptVectors.filter(c => c.field !== null && c.model === best.model);
      const fieldCandidates: FieldCandidate[] = [];
      for (const field of table.fields) {
        const fieldText = `${field.name} (${field.label}), type ${field.type}`;
        const fieldVec = await this.embeddings.embed(fieldText);
        const matches = this.vectorStore.nearestConcepts(fieldVec, 3, fieldConceptVectors);
        fieldCandidates.push({ field, matches });
      }

      shortlist.push({ table, topModel: best.model, modelScore: best.score, fieldCandidates });
    }

    if (shortlist.length === 0) {
      throw new Error('Vector matching found no plausible agnostic-model candidates in the discovered schema.');
    }
    console.log(`[UniversalSchemaDiscovery] Vector-shortlisted ${shortlist.length} table(s) for LLM confirmation.`);

    // ---- Stage 3: LLM confirmation (one focused call per shortlisted table, not the whole schema) ----
    const tables: TableMapping[] = [];
    for (const entry of shortlist) {
      const mapping = await this.confirmTableMappingWithLLM(entry);
      // Zero mapped fields means the LLM call failed (timeout fallback
      // returns a mismatched mock shape) or the table genuinely has nothing
      // usable — either way an empty mapping is worse than absence, since
      // downstream table selection would still consider it.
      if (mapping.fieldMappings.length === 0) {
        console.warn(`[UniversalSchemaDiscovery] Dropping '${entry.table.name}' — LLM confirmation produced no field mappings.`);
        continue;
      }
      tables.push(mapping);
    }

    // ---- Stage 4: Sample validation against real live records ----
    const sampleChecks: SampleCheck[] = [];
    for (const t of tables) {
      const queryFields = t.fieldMappings.map(f => f.sourceField).filter(f => /^[A-Za-z0-9_]+$/.test(f));
      if (queryFields.length === 0) {
        sampleChecks.push({ table: t.sourceTableName, ok: false, notes: 'No queryable fields resolved from mapping.' });
        continue;
      }
      try {
        const samples = await connector.sampleRecords(t.sourceTableName, ['Id', ...queryFields], 3);
        sampleChecks.push({ table: t.sourceTableName, ok: true, notes: `Fetched ${samples.length} live sample record(s) successfully.` });
      } catch (e: any) {
        sampleChecks.push({ table: t.sourceTableName, ok: false, notes: `Sample fetch failed: ${e.message}` });
      }
    }

    const config: GeneratedAdapterConfig = {
      platformName,
      connectionType,
      entityLabel: entityLabelHint || 'Entity',
      generatedAt: new Date().toISOString(),
      schemaFingerprint: fingerprint,
      origin: 'live-introspection',
      tables,
      validation: { validated: sampleChecks.every(s => s.ok), sampleChecks }
    };

    const savedPath = saveAdapterConfig(config);
    this.vectorStore.recordLearnedSchema({
      platformName,
      schemaFingerprint: fingerprint,
      schemaVector,
      configPath: savedPath,
      createdAt: config.generatedAt
    });

    console.log(`[UniversalSchemaDiscovery] Saved generated adapter config to ${savedPath} (validated: ${config.validation.validated}).`);
    return config;
  }

  /** Fallback path for platforms with no live connector: paste raw schema text (legacy SchemaDiscoveryAgent behavior). */
  async executeFromPastedMetadata(platformName: string, rawMetadata: string, entityLabelHint?: string): Promise<GeneratedAdapterConfig> {
    const prompt = [
      'Below is a raw database schema extract, API endpoint description, or unstructured table metadata from a target GRC tool.',
      'Analyze the metadata, recognize key tables, and map them to our core platform-agnostic models:',
      '- Risk\n- Control\n- TestEvidence\n- Issue\n- AssessmentInstance\n- Factor',
      '',
      'RAW TARGET METADATA:',
      rawMetadata,
      '',
      'Generate field mappings explaining the target fields, matching data types, and logical rationales.',
      'Also identify any foreign-key style relationship fields (profile/business-unit link, risk link, assessment link, control link).'
    ].join('\n');

    const systemInstruction = 'You are a Senior GRC Schema Onboarding Architect. Auto-detect table purposes and map fields to a core GRC model schema, including relationship fields.';

    const schema = {
      type: 'OBJECT',
      properties: {
        platformName: { type: 'STRING' },
        tables: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              sourceTableName: { type: 'STRING' },
              targetAgnosticModel: { type: 'STRING' },
              fieldMappings: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    sourceField: { type: 'STRING' },
                    targetField: { type: 'STRING' },
                    rationale: { type: 'STRING' }
                  },
                  required: ['sourceField', 'targetField', 'rationale']
                }
              },
              relationships: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    relationName: { type: 'STRING' },
                    sourceField: { type: 'STRING' }
                  },
                  required: ['relationName', 'sourceField']
                }
              }
            },
            required: ['sourceTableName', 'targetAgnosticModel', 'fieldMappings']
          }
        }
      },
      required: ['platformName', 'tables']
    };

    const response = await this.llm.generateStructuredOutput<any>(prompt, systemInstruction, schema);

    const tables: TableMapping[] = (response.tables || []).map((t: any) => {
      const fieldMappings: FieldMapping[] = (t.fieldMappings || []).map((f: any) => ({
        sourceField: f.sourceField,
        agnosticField: f.targetField,
        rationale: f.rationale,
        confidence: 0.5 // unvalidated — no vector shortlist available for freeform pasted text
      }));
      const relationships: RelationshipMap = {};
      (t.relationships || []).forEach((r: any) => { relationships[r.relationName] = r.sourceField; });

      return {
        sourceTableName: t.sourceTableName,
        targetAgnosticModel: t.targetAgnosticModel as AgnosticModelName,
        fieldMappings,
        relationships,
        confidence: 0.5
      };
    });

    const config: GeneratedAdapterConfig = {
      platformName,
      connectionType: 'generic-rest',
      entityLabel: entityLabelHint || 'Entity',
      generatedAt: new Date().toISOString(),
      schemaFingerprint: computeSchemaFingerprint(tables.map(t => ({ name: t.sourceTableName, fields: t.fieldMappings.map(f => f.sourceField) }))),
      origin: 'pasted-metadata',
      tables,
      validation: { validated: false, sampleChecks: [{ table: 'ALL', ok: false, notes: 'Pasted-metadata mode has no live connection to sample-validate against.' }] }
    };

    saveAdapterConfig(config);
    return config;
  }

  private async confirmTableMappingWithLLM(entry: TableShortlistEntry): Promise<TableMapping> {
    const fieldBlock = entry.fieldCandidates.map(fc => {
      const opts = fc.matches.map(m => `${m.field} (score ${m.score.toFixed(2)})`).join(' | ') || 'none';
      return `- ${fc.field.name} (${fc.field.label}, type ${fc.field.type}) -> candidates: ${opts}`;
    }).join('\n');

    const prompt = [
      'We are onboarding a new GRC platform table into a common cross-platform schema.',
      `Source table: ${entry.table.name} (${entry.table.label})`,
      `Vector similarity suggests this table represents the agnostic model: ${entry.topModel} (similarity ${entry.modelScore.toFixed(2)})`,
      '',
      'Candidate field mappings (top vector matches per source field — you may only choose from these candidates, or "none"):',
      fieldBlock,
      '',
      'TASK:',
      '1. Confirm or correct the target agnostic model for this table (one of Risk, Control, TestEvidence, Issue, AssessmentInstance, Factor).',
      '2. For each source field, pick the correct agnostic field name from ITS candidates list (or "none" if it does not map to any of them).',
      '3. Identify relationship fields: which source field (if any) is a foreign key to a related record. Use relation names from: profile, risk, assessment, control, factor.'
    ].join('\n');

    const systemInstruction = 'You are a Senior GRC Schema Onboarding Architect confirming vector-shortlisted schema mappings. Only choose agnostic fields from the given per-field candidate list; never invent a field name that was not offered.';

    const schema = {
      type: 'OBJECT',
      properties: {
        targetAgnosticModel: { type: 'STRING' },
        fieldMappings: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              sourceField: { type: 'STRING' },
              agnosticField: { type: 'STRING' },
              rationale: { type: 'STRING' }
            },
            required: ['sourceField', 'agnosticField', 'rationale']
          }
        },
        relationships: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              relationName: { type: 'STRING' },
              sourceField: { type: 'STRING' }
            },
            required: ['relationName', 'sourceField']
          }
        }
      },
      required: ['targetAgnosticModel', 'fieldMappings', 'relationships']
    };

    const response = await this.llm.generateStructuredOutput<any>(prompt, systemInstruction, schema);

    const fieldMappings: FieldMapping[] = (response.fieldMappings || [])
      .filter((f: any) => f.agnosticField && f.agnosticField !== 'none')
      .map((f: any) => {
        const candidate = entry.fieldCandidates.find(fc => fc.field.name === f.sourceField);
        const match = candidate?.matches.find(m => m.field === f.agnosticField);
        return {
          sourceField: f.sourceField,
          agnosticField: f.agnosticField,
          rationale: f.rationale,
          confidence: match?.score ?? entry.modelScore
        };
      });

    const relationships: RelationshipMap = {};
    (response.relationships || []).forEach((r: any) => { relationships[r.relationName] = r.sourceField; });

    const avgConfidence = fieldMappings.length > 0
      ? fieldMappings.reduce((sum, f) => sum + f.confidence, 0) / fieldMappings.length
      : entry.modelScore;

    return {
      sourceTableName: entry.table.name,
      targetAgnosticModel: (response.targetAgnosticModel as AgnosticModelName) || entry.topModel,
      fieldMappings,
      relationships,
      writeHeuristics: computeWriteHeuristics(entry.table),
      confidence: avgConfidence
    };
  }
}
