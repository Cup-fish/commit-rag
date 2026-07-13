/**
 * LLM generation module for commit-rag.
 *
 * Calls the DeepSeek API (OpenAI-compatible) to generate a commit message
 * from the prompt constructed by `prompt.ts`.
 *
 * Error handling (§3.6 bullet 2, design doc): every failure mode —
 * invalid API key (401), rate limiting (429), network failure, unexpected
 * API errors — produces a clear, actionable error message. The plugin
 * must never silently fail.
 *
 * Design doc reference: §3.6
 */

import type { ChatMessage } from "./prompt";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LlmOptions {
  /** DeepSeek API key. Required. */
  apiKey: string;
  /**
   * Model name. Default: "deepseek-chat".
   * Also available: "deepseek-reasoner" (for complex reasoning tasks).
   */
  model?: string;
  /** Sampling temperature. Default: 0.3 (per design doc — stable output). */
  temperature?: number;
  /** Maximum output tokens. Default: 500 (commit messages are short). */
  maxTokens?: number;
  /**
   * Base URL for the OpenAI-compatible API.
   * Default: "https://api.deepseek.com/v1".
   */
  baseUrl?: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GenerationResult {
  /** The generated commit message text. */
  message: string;
  /** Token usage (if returned by the API). */
  usage?: LlmUsage;
  /** The model that produced this result. */
  model: string;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP error response into a user-friendly message.
 * DeepSeek uses standard HTTP status codes with OpenAI-compatible error bodies:
 *   { error: { message: string, type: string, code: string } }
 */
async function classifyError(
  status: number,
  body: string,
): Promise<never> {
  // Try to extract the API's own error message
  let apiMessage = "";
  try {
    const parsed = JSON.parse(body);
    if (parsed.error?.message) {
      apiMessage = `: ${parsed.error.message}`;
    }
  } catch {
    // Body isn't JSON — use raw text (truncated)
    apiMessage = body.trim() ? `: ${body.trim().slice(0, 200)}` : "";
  }

  switch (status) {
    case 401:
      throw new Error(
        `DeepSeek API authentication failed (401)${apiMessage}\n\n` +
          "Your API key is invalid or expired. Please:\n" +
          "1. Check that COMMIT_RAG_DEEPSEEK_API_KEY is set correctly.\n" +
          "2. Visit https://platform.deepseek.com/api_keys to create or verify your key.\n" +
          "3. Ensure your account has available credits.",
      );

    case 403:
      throw new Error(
        `DeepSeek API access denied (403)${apiMessage}\n\n` +
          "Your API key does not have permission to access this resource. " +
          "Check your account's access level at https://platform.deepseek.com.",
      );

    case 429:
      throw new Error(
        `DeepSeek API rate limit exceeded (429)${apiMessage}\n\n` +
          "You have sent too many requests in a short period. Please:\n" +
          "1. Wait a moment and try again.\n" +
          "2. Check your rate limit tier at https://platform.deepseek.com.\n" +
          "3. Consider topping up your account if you are on a low-tier plan.",
      );

    case 500:
    case 502:
    case 503:
    case 504:
      throw new Error(
        `DeepSeek server error (${status})${apiMessage}\n\n` +
          "The DeepSeek API is experiencing issues. This is not a problem with " +
          "your configuration. Please:\n" +
          "1. Check https://status.deepseek.com for service status.\n" +
          "2. Retry in a few minutes.",
      );

    default:
      throw new Error(
        `DeepSeek API returned unexpected status ${status}${apiMessage}\n\n` +
          "Please check your configuration and try again. " +
          "If the problem persists, visit https://platform.deepseek.com for support.",
      );
  }
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

/**
 * Call the DeepSeek chat completion API and return the generated message.
 *
 * Uses the OpenAI-compatible `/v1/chat/completions` endpoint.
 * Temperature is set low (0.3) per design doc §3.6 to ensure stable,
 * consistent output rather than creative variation.
 */
export async function generateCommitMessage(
  messages: ChatMessage[],
  options: LlmOptions,
): Promise<GenerationResult> {
  const {
    apiKey,
    model = "deepseek-chat",
    temperature = 0.3,
    maxTokens = 500,
    baseUrl = "https://api.deepseek.com/v1",
  } = options;

  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "DeepSeek API key is not configured.\n\n" +
        "Please set the COMMIT_RAG_DEEPSEEK_API_KEY environment variable, " +
        "or configure it in your VS Code settings (coming in Day 5-6).\n" +
        "Get a key at: https://platform.deepseek.com/api_keys",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        // Don't use stream — we want a single complete response
        stream: false,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Network-level errors
    if (
      message.includes("fetch") ||
      message.includes("ECONNREFUSED") ||
      message.includes("ENOTFOUND") ||
      message.includes("ETIMEDOUT") ||
      message.includes("network")
    ) {
      throw new Error(
        `Failed to connect to DeepSeek API: ${message}\n\n` +
          "Possible causes:\n" +
          "1. No internet connection — check your network.\n" +
          "2. Firewall or proxy blocking api.deepseek.com.\n" +
          "3. DNS resolution failure.\n\n" +
          "Verify connectivity: curl https://api.deepseek.com/v1/models",
      );
    }

    throw new Error(`Unexpected network error: ${message}`);
  }

  // ---- Handle HTTP errors ----
  if (!response.ok) {
    const body = await response.text().catch(() => "(unable to read response body)");
    return classifyError(response.status, body);
  }

  // ---- Parse response ----
  let data: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    model?: string;
  };

  try {
    data = (await response.json()) as typeof data;
  } catch {
    throw new Error(
      "Failed to parse DeepSeek API response. " +
        "The API returned an unexpected (non-JSON) body. " +
        "This may indicate a proxy or middleware issue.",
    );
  }

  // ---- Validate response structure ----
  if (!data.choices || data.choices.length === 0) {
    throw new Error(
      "DeepSeek API returned an empty response (no choices).\n\n" +
        "This is unexpected — please try again. " +
        `Full response: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  const content = data.choices[0]?.message?.content;
  if (content === undefined || content === null) {
    throw new Error(
      "DeepSeek API response is missing message content.\n\n" +
        "The model may have refused to generate (content filter). " +
        `Finish reason: ${JSON.stringify(data.choices[0]).slice(0, 200)}`,
    );
  }

  // ---- Return result ----
  return {
    message: content.trim(),
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        }
      : undefined,
    model: data.model ?? model,
  };
}
