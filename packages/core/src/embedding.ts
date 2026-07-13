/**
 * Embedding provider abstraction layer.
 *
 * Design rationale (see design doc §3.2):
 * We separate the embedding concern behind an interface so that:
 * 1. The default Qwen/DashScope cloud provider can be swapped for a local
 *    model (e.g. @xenova/transformers) without changing indexer or retriever.
 * 2. Tests can use a deterministic MockEmbeddingProvider.
 *
 * DashScope API details (verified 2026-07):
 * - Model: text-embedding-v4 (Qwen3-Embedding), 100+ languages
 * - Endpoint: OpenAI-compatible at dashscope.aliyuncs.com/compatible-mode/v1
 * - Dimensions: 1024 default (best value), range 64–2048
 * - Batch: max 10 texts/request, 8192 tokens/text
 * - Pricing: ¥0.0005 / 1K tokens
 */

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  /** Human-readable model identifier (e.g. "text-embedding-v4"). */
  readonly model: string;

  /** Output vector dimensionality. */
  readonly dimensions: number;

  /**
   * Compute embedding vectors for one or more texts.
   * Implementations should batch internally if the remote API has limits.
   */
  embed(texts: string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Qwen / DashScope provider (OpenAI-compatible)
// ---------------------------------------------------------------------------

export interface QwenEmbeddingOptions {
  apiKey: string;
  /** Model name. Default: "text-embedding-v4". */
  model?: string;
  /** Output vector dimensions. Default: 1024. */
  dimensions?: number;
  /**
   * Base URL for the DashScope OpenAI-compatible endpoint.
   * Default: "https://dashscope.aliyuncs.com/compatible-mode/v1".
   */
  baseUrl?: string;
  /**
   * Maximum texts per API call. DashScope limit is 10.
   * Only override for testing.
   */
  batchSize?: number;
}

export class QwenEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly batchSize: number;

  constructor(options: QwenEmbeddingOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? "text-embedding-v4";
    this.dimensions = options.dimensions ?? 1024;
    this.baseUrl =
      options.baseUrl ??
      "https://dashscope.aliyuncs.com/compatible-mode/v1";
    this.batchSize = options.batchSize ?? 10;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const allVectors: number[][] = [];

    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);

      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.dimensions,
          encoding_format: "float",
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "(unable to read body)");
        throw new Error(
          `DashScope embedding API returned ${response.status}:\n${body.slice(0, 500)}`,
        );
      }

      // Response format (OpenAI-compatible):
      // { object: "list", data: [{ object: "embedding", index: N, embedding: number[] }], ... }
      const json = (await response.json()) as {
        data?: Array<{ index: number; embedding?: number[] }>;
      };

      if (!json.data || !Array.isArray(json.data)) {
        throw new Error(
          `Unexpected embedding response structure: ${JSON.stringify(json).slice(0, 200)}`,
        );
      }

      // Sort by index to preserve input order (API should return in order, but be defensive)
      const sorted = [...json.data].sort((a, b) => a.index - b.index);

      for (const item of sorted) {
        if (!Array.isArray(item.embedding)) {
          throw new Error(
            `Embedding entry missing vector array at index ${item.index}`,
          );
        }
        allVectors.push(item.embedding);
      }
    }

    return allVectors;
  }
}

// ---------------------------------------------------------------------------
// Mock provider — for unit tests and offline development
// ---------------------------------------------------------------------------

/**
 * Deterministic mock that returns a fixed-size zero vector for any input.
 * Useful for testing indexer/retriever logic without API calls.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly model = "mock";
  readonly dimensions: number;

  constructor(dimensions: number = 1024) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Return a simple hash-based vector so different texts get different
    // (but deterministic) vectors — better than all-zeros for testing.
    return texts.map((t) => this._hashVector(t));
  }

  private _hashVector(text: string): number[] {
    const vec = new Array<number>(this.dimensions);
    // Deterministic pseudo-random vector derived from the input text.
    // Uses a simple hash chain per dimension so different texts produce
    // distinguishable vectors with cosine similarity typically < 0.5.
    for (let i = 0; i < this.dimensions; i++) {
      // Mix the dimension index with a rolling hash of the text
      let val = i * 0x9e3779b9;
      for (let j = 0; j < text.length; j++) {
        val = ((val << 5) - val + text.charCodeAt(j)) | 0;
      }
      // Convert to a float in [-1, 1] range, scaled for unit-length-ish vectors
      vec[i] = Math.sin(val * 0.001) * (1 / Math.sqrt(this.dimensions));
    }
    return vec;
  }
}
