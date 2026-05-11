// THE SINGLE CHOKEPOINT FOR ANTHROPIC CALLS — PROMPT §4.3.
// No other file in this repo may import @anthropic-ai/sdk. Add capability
// here and expose it; do not bypass.
import Anthropic from "@anthropic-ai/sdk";
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
  tools?: Anthropic.Tool[];
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
        ...(params.tools ? { tools: params.tools } : {}),
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
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
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
