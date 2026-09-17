// THE SINGLE CHOKEPOINT FOR CLAUDE CALLS — PROMPT §4.3.
// No other file in this repo may import @anthropic-ai/sdk or
// @anthropic-ai/vertex-sdk. Add capability here and expose it.
//
// Runtime path (parked): Vertex AI Claude via @anthropic-ai/vertex-sdk.
// Reverted 2026-09-17 while Google approves the base_model quota
// requests on `anthropic-claude-opus` and `anthropic-claude-sonnet`.
// The vertex-sdk dep stays installed so re-enabling is a one-line
// swap of getClient() below.
import Anthropic, { APIError } from "@anthropic-ai/sdk";
import { env } from "@cred/config";
import { db, schema } from "@cred/db";
import { logger } from "@cred/observability/logger";
import type { z } from "zod";

export const MODELS = {
  sonnet: () => env().ANTHROPIC_MODEL_SONNET,
  opus: () => env().ANTHROPIC_MODEL_OPUS,
} as const;

export type ModelChoice = keyof typeof MODELS | (string & {});

export interface AnthropicCallParams<T> {
  task: string;
  model: ModelChoice;
  systemPrompt: string;
  userContent: Anthropic.MessageParam["content"];
  // Deliberately widened. The Anthropic SDK's `Tool["input_schema"]`
  // requires `required` to be a mutable `string[]`, but our JSON-Schema
  // constants use `as const` for compile-time enum narrowing which
  // yields a `readonly` tuple. Anthropic accepts the same JSON shape at
  // runtime — the mutability mismatch is a TS-only concern.
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: unknown;
  }>;
  toolChoice?: Anthropic.MessageCreateParams["tool_choice"];
  expectedSchema?: z.ZodType<T>;
  maxTokens?: number;
  maxRetries?: number;
  cacheSystem?: boolean;
  workspaceId?: string | null;
  relatedEntity?: { type: string; id: string };
  confidence?: number;
}

export interface AnthropicCallResult<T> {
  output: T;
  modelVersion: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  stopReason: Anthropic.Message["stop_reason"];
  rawResponse: Anthropic.Message;
}

let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = env().ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
    client = new Anthropic({ apiKey });
  }
  return client;
}

function resolveModel(choice: ModelChoice): string {
  if (choice in MODELS) return MODELS[choice as keyof typeof MODELS]();
  return choice;
}

async function backoff(attempt: number): Promise<void> {
  const base = 250 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 100);
  await new Promise((r) => setTimeout(r, base + jitter));
}

async function logAiCall(row: typeof schema.aiCalls.$inferInsert): Promise<void> {
  try {
    // rls: bypass — ai_calls is a ledger written by the AI chokepoint.
    await db().insert(schema.aiCalls).values(row);
  } catch (err) {
    logger.error({ err }, "ai_call_log_failed");
  }
}

/**
 * Call Claude. Handles retry, prompt caching, structured-output parsing,
 * full call logging to `ai_calls`, and observability. Callers receive a
 * typed output plus token + model provenance.
 */
export async function anthropicCall<S extends z.ZodTypeAny>(
  params: AnthropicCallParams<z.infer<S>> & { expectedSchema: S },
): Promise<AnthropicCallResult<z.infer<S>>>;
export async function anthropicCall<T = string>(
  params: AnthropicCallParams<T>,
): Promise<AnthropicCallResult<T>>;
export async function anthropicCall<T>(
  params: AnthropicCallParams<T>,
): Promise<AnthropicCallResult<T>> {
  const model = resolveModel(params.model);
  const maxRetries = params.maxRetries ?? 3;
  const maxTokens = params.maxTokens ?? 4096;

  const system: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: params.systemPrompt,
      ...(params.cacheSystem !== false ? { cache_control: { type: "ephemeral" } } : {}),
    },
  ];

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      const resp = await getClient().messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: params.userContent }],
        // Cast: tools deliberately widened at the API boundary (see the
        // comment on AnthropicCallParams.tools). SDK's InputSchema is
        // stricter than the runtime shape it actually accepts.
        ...(params.tools ? { tools: params.tools as Anthropic.Tool[] } : {}),
        ...(params.toolChoice ? { tool_choice: params.toolChoice } : {}),
      });

      const output = extractOutput<T>(resp, params.expectedSchema);
      const latencyMs = Date.now() - start;
      const cachedInputTokens =
        (resp.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0;

      logger.info(
        {
          task: params.task,
          model,
          stopReason: resp.stop_reason,
          inputTokens: resp.usage.input_tokens,
          outputTokens: resp.usage.output_tokens,
          cachedInputTokens,
          latencyMs,
          // Raw content blocks — needed to debug when the parsed
          // output looks empty despite non-zero output_tokens. Safe
          // to log because Claude's tool_use inputs are our schema
          // shape, not PHI.
          content: resp.content,
        },
        "ai_call",
      );

      await logAiCall({
        workspaceId: params.workspaceId ?? null,
        task: params.task,
        model,
        modelVersion: resp.model,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cachedInputTokens,
        latencyMs,
        stopReason: resp.stop_reason ?? null,
        confidence: params.confidence !== undefined ? Math.round(params.confidence * 10_000) : null,
        relatedEntityType: params.relatedEntity?.type ?? null,
        relatedEntityId: params.relatedEntity?.id ?? null,
        // Persist prompt + response so we can debug "empty extraction
        // despite non-zero tokens" without redeploying.
        promptSnapshot: {
          system: params.systemPrompt,
          userContent: params.userContent,
          ...(params.tools ? { tools: params.tools } : {}),
        },
        responseSnapshot: resp,
        error: null,
      });

      return {
        output,
        modelVersion: resp.model,
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cachedInputTokens,
        stopReason: resp.stop_reason,
        rawResponse: resp,
      };
    } catch (err) {
      lastErr = err;
      const status = err instanceof APIError ? err.status : undefined;
      const retriable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retriable || attempt === maxRetries) {
        await logAiCall({
          workspaceId: params.workspaceId ?? null,
          task: params.task,
          model,
          modelVersion: model,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          latencyMs: Date.now() - start,
          stopReason: null,
          confidence: null,
          relatedEntityType: params.relatedEntity?.type ?? null,
          relatedEntityId: params.relatedEntity?.id ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      logger.warn({ task: params.task, attempt, status }, "ai_call_retry");
      await backoff(attempt);
    }
  }
  throw lastErr;
}

function extractOutput<T>(resp: Anthropic.Message, schema?: z.ZodType<T>): T {
  for (const block of resp.content) {
    if (block.type === "tool_use") {
      const value = block.input as unknown;
      return schema ? schema.parse(value) : (value as T);
    }
  }
  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return schema ? schema.parse(text) : (text as unknown as T);
}
