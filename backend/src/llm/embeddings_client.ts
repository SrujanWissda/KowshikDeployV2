import axios from 'axios';
import * as dotenv from 'dotenv';
import { recordSpan } from '../core/observability';

dotenv.config();

// ============================================================================
// Cosine Similarity Utility
// ============================================================================
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export abstract class BaseEmbeddingsClient {
  abstract embed(text: string): Promise<number[]>;
  abstract embedBatch(texts: string[]): Promise<number[][]>;
  /** Identifies the vector space vectors come from. Vectors from different backends are not comparable. */
  backendId(): string {
    return 'local-hash-256';
  }
  /** True when a real semantic embedding backend is configured (vs. the local hash fallback). */
  isLive(): boolean {
    return false;
  }
}

// ============================================================================
// Gemini Embeddings Client — uses text-embedding-004 (768-dim vectors)
// Falls back to a deterministic local hashing-based vector when no API key
// is configured, so the pipeline never hard-fails without credentials.
// ============================================================================
export class GeminiEmbeddingsClient extends BaseEmbeddingsClient {
  private apiKey: string | undefined;
  private model: string;
  private baseUrl: string;

  constructor() {
    super();
    this.apiKey = process.env.GEMINI_API_KEY || process.env.gemini_api_key;
    this.model = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
    this.baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}`;
  }

  /** True when a real semantic embedding backend is configured (vs. the local hash fallback). */
  isLive(): boolean {
    return !!this.apiKey;
  }

  backendId(): string {
    return this.apiKey ? `gemini:${this.model}` : 'local-hash-256';
  }

  async embed(text: string): Promise<number[]> {
    const t0 = Date.now();
    if (!this.apiKey) {
      recordSpan('embeddings.single', t0, 'fallback', { reason: 'no-api-key' });
      return this.localFallbackVector(text);
    }
    try {
      const url = `${this.baseUrl}:embedContent?key=${this.apiKey}`;
      const response = await axios.post(url, {
        model: `models/${this.model}`,
        content: { parts: [{ text }] }
      }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000
      });
      const values = response.data?.embedding?.values;
      if (!Array.isArray(values)) throw new Error('Malformed embedding response');
      recordSpan('embeddings.single', t0, 'ok', { model: this.model, textChars: text.length });
      return values as number[];
    } catch (e: any) {
      console.warn(`[GeminiEmbeddingsClient] Embedding call failed, using local fallback vector. Error: ${e.message}`);
      recordSpan('embeddings.single', t0, 'fallback', { model: this.model, reason: e.message });
      return this.localFallbackVector(text);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const t0 = Date.now();
    if (!this.apiKey) {
      recordSpan('embeddings.batch', t0, 'fallback', { reason: 'no-api-key', count: texts.length });
      return texts.map(t => this.localFallbackVector(t));
    }
    // batchEmbedContents accepts up to 100 requests per call — critical for
    // ranking every object in a large org without hundreds of round-trips.
    const results: number[][] = [];
    let fallbackChunks = 0;
    const BATCH = 100;
    for (let i = 0; i < texts.length; i += BATCH) {
      const chunk = texts.slice(i, i + BATCH);
      try {
        const url = `${this.baseUrl}:batchEmbedContents?key=${this.apiKey}`;
        const response = await axios.post(url, {
          requests: chunk.map(text => ({
            model: `models/${this.model}`,
            content: { parts: [{ text }] }
          }))
        }, {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000
        });
        const embeddings = response.data?.embeddings;
        if (!Array.isArray(embeddings) || embeddings.length !== chunk.length) {
          throw new Error('Malformed batch embedding response');
        }
        for (const e of embeddings) results.push(e.values as number[]);
      } catch (e: any) {
        console.warn(`[GeminiEmbeddingsClient] Batch embedding failed for chunk ${i}-${i + chunk.length}, using local fallback. Error: ${e.message}`);
        fallbackChunks++;
        for (const t of chunk) results.push(this.localFallbackVector(t));
      }
    }
    recordSpan('embeddings.batch', t0, fallbackChunks > 0 ? 'fallback' : 'ok', {
      model: this.model,
      count: texts.length,
      fallbackChunks
    });
    return results;
  }

  /**
   * Deterministic bag-of-words hashing vector (256-dim). Not a real semantic
   * embedding, but gives consistent, comparable vectors so cosine similarity
   * still produces a sane keyword-overlap ranking when no API key is present.
   */
  private localFallbackVector(text: string): number[] {
    const dims = 256;
    const vec = new Array(dims).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s_]/g, ' ')
      .split(/[\s_]+/)
      .filter(Boolean);

    for (const token of tokens) {
      let hash = 0;
      for (let i = 0; i < token.length; i++) {
        hash = (hash * 31 + token.charCodeAt(i)) >>> 0;
      }
      vec[hash % dims] += 1;
    }

    // L2 normalize so cosine similarity behaves consistently with real embeddings
    const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (mag === 0) return vec;
    return vec.map(v => v / mag);
  }
}
