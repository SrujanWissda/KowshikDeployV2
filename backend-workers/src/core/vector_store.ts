import { BaseEmbeddingsClient, cosineSimilarity } from '../llm/embeddings_client';
import { CONCEPT_CATALOG, conceptTableEmbeddingText, conceptFieldEmbeddingText, AgnosticModelName } from './concept_catalog';
import { GOLD_STANDARD_TABLES, goldStandardEmbeddingText } from './gold_standard_catalog';

// KV replaces the old `backend/data/vector_cache.json` (~4MB single-file
// read/rewrite). This cache is only touched during schema-discovery
// onboarding, never on the agent-run hot path, so one KV blob under a single
// key is fine — no need to restructure into per-row KV entries at this scale.
const STORE_KEY = 'vector-store';

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

async function loadStore(kv: KVNamespace): Promise<VectorStoreShape> {
  try {
    const raw = await kv.get(STORE_KEY);
    if (raw) return JSON.parse(raw) as VectorStoreShape;
  } catch (e: any) {
    console.warn(`[VectorStore] Failed to load cache, starting fresh: ${e.message}`);
  }
  return emptyStore();
}

async function saveStore(kv: KVNamespace, store: VectorStoreShape): Promise<void> {
  await kv.put(STORE_KEY, JSON.stringify(store));
}

// Web Crypto's subtle.digest is the Workers-native equivalent of node:crypto's
// createHash — inherently async (no synchronous SHA-256 exists in Web
// Crypto), which is why this and computeSchemaFingerprint below are async
// where the original Node version was sync.
async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function computeCatalogHash(): Promise<string> {
  return sha256Hex(JSON.stringify(CONCEPT_CATALOG));
}

/** Stable fingerprint for a discovered schema's shape (table + field names, not values). */
export async function computeSchemaFingerprint(tables: Array<{ name: string; fields: string[] }>): Promise<string> {
  const parts = tables
    .map(t => `${t.name}:${[...t.fields].sort().join(',')}`)
    .sort();
  return sha256Hex(parts.join('||'));
}

export class VectorStore {
  private kv: KVNamespace;
  private store: VectorStoreShape;

  private constructor(kv: KVNamespace, store: VectorStoreShape) {
    this.kv = kv;
    this.store = store;
  }

  // Constructors can't be async — KV reads are — so a static factory replaces
  // the original's synchronous `new VectorStore()` at every call site.
  static async create(kv: KVNamespace): Promise<VectorStore> {
    return new VectorStore(kv, await loadStore(kv));
  }

  /**
   * Vectors from different embedding backends live in different vector
   * spaces (the local hash fallback is 256-dim; gemini-embedding-001 is
   * 3072-dim) — comparing across them yields garbage similarities. When the
   * active backend differs from the one that produced the cache, wipe every
   * cached vector so it gets rebuilt in the current space.
   */
  async ensureBackendConsistency(embeddings: BaseEmbeddingsClient): Promise<void> {
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
    await saveStore(this.kv, this.store);
  }

  /** Ensures concept table/field vectors are computed and cached; recomputes if the catalog changed. */
  async ensureConceptVectors(embeddings: BaseEmbeddingsClient): Promise<ConceptVectorItem[]> {
    await this.ensureBackendConsistency(embeddings);
    const currentHash = await computeCatalogHash();
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
    await saveStore(this.kv, this.store);
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
    await this.ensureBackendConsistency(embeddings);
    const hash = await sha256Hex(JSON.stringify(GOLD_STANDARD_TABLES));
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
    await saveStore(this.kv, this.store);
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

  async recordLearnedSchema(entry: LearnedSchemaEntry): Promise<void> {
    this.store.learnedSchemas = this.store.learnedSchemas.filter(e => e.platformName !== entry.platformName);
    this.store.learnedSchemas.push(entry);
    await saveStore(this.kv, this.store);
  }

  listLearnedSchemas(): LearnedSchemaEntry[] {
    return [...this.store.learnedSchemas];
  }
}
