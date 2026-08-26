import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { BaseEmbeddingsClient, cosineSimilarity } from '../llm/embeddings_client';
import { CONCEPT_CATALOG, conceptTableEmbeddingText, conceptFieldEmbeddingText, AgnosticModelName } from './concept_catalog';
import { GOLD_STANDARD_TABLES, goldStandardEmbeddingText } from './gold_standard_catalog';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'vector_cache.json');

export interface ConceptVectorItem {
  model: AgnosticModelName;
  field: string | null; // null = table-level concept vector
  text: string;
  vector: number[];
}

export interface LearnedSchemaEntry {
  platformName: string;
  schemaFingerprint: string;
  schemaVector: number[];
  configPath: string;
  createdAt: string;
}

export interface GoldStandardVectorItem {
  platform: string;
  sourceTableName: string;
  model: AgnosticModelName;
  text: string;
  vector: number[];
}

interface VectorStoreShape {
  embeddingBackend?: string | null;
  catalogHash: string | null;
  conceptVectors: ConceptVectorItem[];
  goldStandardHash?: string | null;
  goldStandardVectors?: GoldStandardVectorItem[];
  learnedSchemas: LearnedSchemaEntry[];
}

function emptyStore(): VectorStoreShape {
  return { embeddingBackend: null, catalogHash: null, conceptVectors: [], goldStandardHash: null, goldStandardVectors: [], learnedSchemas: [] };
}

function loadStore(): VectorStoreShape {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const raw = fs.readFileSync(STORE_PATH, 'utf-8');
      return JSON.parse(raw) as VectorStoreShape;
    }
  } catch (e: any) {
    console.warn(`[VectorStore] Failed to load cache, starting fresh: ${e.message}`);
  }
  return emptyStore();
}

function saveStore(store: VectorStoreShape): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

function computeCatalogHash(): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(CONCEPT_CATALOG));
  return hash.digest('hex');
}

/** Stable fingerprint for a discovered schema's shape (table + field names, not values). */
export function computeSchemaFingerprint(tables: Array<{ name: string; fields: string[] }>): string {
  const parts = tables
    .map(t => `${t.name}:${[...t.fields].sort().join(',')}`)
    .sort();
  const hash = crypto.createHash('sha256');
  hash.update(parts.join('||'));
  return hash.digest('hex');
}

export class VectorStore {
  private store: VectorStoreShape;

  constructor() {
    this.store = loadStore();
  }

  /**
   * Vectors from different embedding backends live in different vector
   * spaces (the local hash fallback is 256-dim; gemini-embedding-001 is
   * 3072-dim) — comparing across them yields garbage similarities. When the
   * active backend differs from the one that produced the cache, wipe every
   * cached vector so it gets rebuilt in the current space.
   */
  ensureBackendConsistency(embeddings: BaseEmbeddingsClient): void {
    const backend = embeddings.backendId();
    if (this.store.embeddingBackend === backend) return;
    if (this.store.embeddingBackend) {
      console.warn(`[VectorStore] Embedding backend changed ('${this.store.embeddingBackend}' -> '${backend}') — invalidating all cached vectors.`);
    }
    this.store.conceptVectors = [];
    this.store.catalogHash = null;
    this.store.goldStandardVectors = [];
    this.store.goldStandardHash = null;
    this.store.learnedSchemas = [];
    this.store.embeddingBackend = backend;
    saveStore(this.store);
  }

  /** Ensures concept table/field vectors are computed and cached; recomputes if the catalog changed. */
  async ensureConceptVectors(embeddings: BaseEmbeddingsClient): Promise<ConceptVectorItem[]> {
    this.ensureBackendConsistency(embeddings);
    const currentHash = computeCatalogHash();
    if (this.store.catalogHash === currentHash && this.store.conceptVectors.length > 0) {
      return this.store.conceptVectors;
    }

    console.log('[VectorStore] Concept catalog changed or uncached — computing concept embeddings...');
    const items: ConceptVectorItem[] = [];

    for (const concept of CONCEPT_CATALOG) {
      const tableText = conceptTableEmbeddingText(concept);
      items.push({
        model: concept.model,
        field: null,
        text: tableText,
        vector: await embeddings.embed(tableText)
      });

      for (const field of concept.fields) {
        const fieldText = conceptFieldEmbeddingText(concept, field);
        items.push({
          model: concept.model,
          field: field.field,
          text: fieldText,
          vector: await embeddings.embed(fieldText)
        });
      }
    }

    this.store.catalogHash = currentHash;
    this.store.conceptVectors = items;
    saveStore(this.store);
    console.log(`[VectorStore] Cached ${items.length} concept vectors.`);
    return items;
  }

  /**
   * Ensures purpose vectors for the gold-standard tables (knowledge lifted
   * from the hand-written ServiceNow/Salesforce adapters) are embedded and
   * cached. These are the primary semantic targets for purpose-based object
   * discovery on new platforms.
   */
  async ensureGoldStandardVectors(embeddings: BaseEmbeddingsClient): Promise<GoldStandardVectorItem[]> {
    this.ensureBackendConsistency(embeddings);
    const hash = crypto.createHash('sha256').update(JSON.stringify(GOLD_STANDARD_TABLES)).digest('hex');
    if (this.store.goldStandardHash === hash && (this.store.goldStandardVectors || []).length > 0) {
      return this.store.goldStandardVectors!;
    }

    console.log('[VectorStore] Gold-standard catalog changed or uncached — embedding purpose descriptions...');
    const texts = GOLD_STANDARD_TABLES.map(goldStandardEmbeddingText);
    const vectors = await embeddings.embedBatch(texts);
    const items: GoldStandardVectorItem[] = GOLD_STANDARD_TABLES.map((t, i) => ({
      platform: t.platform,
      sourceTableName: t.sourceTableName,
      model: t.targetAgnosticModel,
      text: texts[i],
      vector: vectors[i]
    }));

    this.store.goldStandardHash = hash;
    this.store.goldStandardVectors = items;
    saveStore(this.store);
    console.log(`[VectorStore] Cached ${items.length} gold-standard purpose vectors (ServiceNow + Salesforce reference adapters).`);
    return items;
  }

  /** Top-K gold-standard tables ranked by cosine similarity to the given vector. */
  nearestGoldStandards(vector: number[], topK: number = 3): Array<GoldStandardVectorItem & { score: number }> {
    return (this.store.goldStandardVectors || [])
      .map(item => ({ ...item, score: cosineSimilarity(vector, item.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Returns the top-K concept vector items ranked by cosine similarity to the given vector. */
  nearestConcepts(vector: number[], topK: number = 5, conceptVectors?: ConceptVectorItem[]): Array<ConceptVectorItem & { score: number }> {
    const pool = conceptVectors || this.store.conceptVectors;
    return pool
      .map(item => ({ ...item, score: cosineSimilarity(vector, item.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /**
   * Looks for a previously learned platform schema whose overall shape is
   * similar enough to reuse its generated adapter config without re-running
   * the LLM confirmation step at all.
   */
  findSimilarLearnedSchema(schemaVector: number[], threshold: number = 0.92): (LearnedSchemaEntry & { score: number }) | null {
    let best: (LearnedSchemaEntry & { score: number }) | null = null;
    for (const entry of this.store.learnedSchemas) {
      const score = cosineSimilarity(schemaVector, entry.schemaVector);
      if (score >= threshold && (!best || score > best.score)) {
        best = { ...entry, score };
      }
    }
    return best;
  }

  recordLearnedSchema(entry: LearnedSchemaEntry): void {
    this.store.learnedSchemas = this.store.learnedSchemas.filter(e => e.platformName !== entry.platformName);
    this.store.learnedSchemas.push(entry);
    saveStore(this.store);
  }

  listLearnedSchemas(): LearnedSchemaEntry[] {
    return [...this.store.learnedSchemas];
  }
}
