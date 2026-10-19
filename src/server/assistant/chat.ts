import "server-only";
import { createHash } from "node:crypto";
import { AppError } from "@/server/errors";
import { logger } from "@/server/log/logger";
import { isRateLimited, recordHit, type RateLimitRule } from "@/server/security/rate-limit";
import { buildVoiceInstructions } from "@/server/voice/instructions";
import {
  groundingViolations,
  intentBoundary,
  MEDICAL_REFUSAL,
  translateVoiceError,
} from "@/server/voice/policy";
import { realtimeToolDefinitions, runVoiceTool, type VoiceToolResult } from "@/server/voice/tools";
import { simulateVoiceTurn } from "@/server/voice/mock-model";
import { isMockTransportEnabled } from "@/server/voice/transport";
import type { VoiceToolContext } from "@/server/voice/session";

/**
 * KLINIVA AI YAZILI SOHBET — sunucu tarafı model döngüsü.
 *
 *  - Model çağrısı YALNIZCA sunucuda (OPENAI_API_KEY tarayıcıya hiç gitmez; istemciye sır da dönmez).
 *  - Araçlar sesli asistanla AYNI katman (runVoiceTool): mevcut servisler, RBAC / RLS / şube / doktor kapsamı, yazma
 *    işlemlerinde PendingAIAction + açık onay ("evet / onaylıyorum / tamam"; kullanıcının KENDİ son mesajı).
 *  - Kiracı / kullanıcı bağlamı oturumdan; model bunları belirleyemez (şemalarda yok).
 *  - Konuşma geçmişi YALNIZCA süreç belleğinde (30 dk, oturum sonunda silinir); veritabanına / log'a yazılmaz.
 *  - Tıbbi karar istekleri model çağrılmadan reddedilir. Yanıttaki saat / sayılar araç sonuçlarında yoksa güvenli
 *    geri dönüş (grounding).
 *  - VOICE_TRANSPORT=mock (test / E2E): deterministik düzenek (simulateVoiceTurn), ağ çağrısı yok.
 */
export type ChatToolTrace = { name: string; output: VoiceToolResult };
export type ChatTurnResult = {
  reply: string;
  toolCalls: ChatToolTrace[];
  pending: { actionId: string; summary: string } | null;
  /** Bu turda bir eylem sonuçlandı (yürütüldü / iptal / süresi doldu) → arayüz onay kartını kapatır. */
  settled: boolean;
  grounded: boolean;
};

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatModel {
  complete(
    messages: ChatMessage[],
    tools: unknown[],
  ): Promise<{ content: string | null; toolCalls: ToolCall[] }>;
}

export const chatModelName = () => process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini";

/** OpenAI Chat Completions (işlev çağrısı). Hata durumunda yalnızca durum kodu döner (gövde / anahtar loglanmaz). */
export class OpenAIChatModel implements ChatModel {
  constructor(private readonly apiKey: string) {}
  async complete(messages: ChatMessage[], tools: unknown[]) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: chatModelName(),
        messages,
        tools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        max_completion_tokens: 800,
      }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`CHAT_HTTP_${res.status}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    };
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error("CHAT_NO_CHOICE");
    return { content: msg.content ?? null, toolCalls: msg.tool_calls ?? [] };
  }
}

export function getChatModel(): ChatModel | null {
  const key = process.env.OPENAI_API_KEY;
  return key ? new OpenAIChatModel(key) : null;
}

// ---------------------------------------------------------------- bellek içi konuşma (kalıcı DEĞİL)

const TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 500;
const MAX_HISTORY = 40;
const MAX_ROUNDS = 6;
type Conversation = { owner: string; messages: ChatMessage[]; touched: number };
const g = globalThis as unknown as { __klinivaChat?: Map<string, Conversation> };
const store = (g.__klinivaChat ??= new Map());

const ownerKey = (tc: VoiceToolContext) =>
  createHash("sha256").update(`${tc.ctx.tenantId}:${tc.ctx.userId}`).digest("hex");

function conversation(tc: VoiceToolContext): Conversation {
  const now = Date.now();
  for (const [k, c] of store) if (now - c.touched > TTL_MS) store.delete(k);
  let c = store.get(tc.session.id);
  // Oturum kimliği zaten kullanıcıya bağlı doğrulandı; yine de bellek kaydı başka sahibe aitse kullanılmaz.
  if (!c || c.owner !== ownerKey(tc)) {
    c = { owner: ownerKey(tc), messages: [], touched: now };
    store.set(tc.session.id, c);
    while (store.size > MAX_SESSIONS) store.delete(store.keys().next().value!);
  }
  c.touched = now;
  return c;
}

/** Oturum bitince (veya "Yeni sohbet") geçmiş bellekten silinir. */
export function forgetConversation(sessionId: string) {
  store.delete(sessionId);
}

/** Geçmişi kullanıcı mesajı sınırından keser (araç çağrısı ↔ araç sonucu çifti bölünmez). */
function trim(messages: ChatMessage[]) {
  if (messages.length <= MAX_HISTORY) return;
  let cut = messages.length - MAX_HISTORY;
  while (cut < messages.length && messages[cut]!.role !== "user") cut++;
  messages.splice(0, cut);
}

const CHAT_MESSAGE_RULE: RateLimitRule = { name: "assistant-chat", limit: 40, windowSeconds: 5 * 60 };
const SETTLED = new Set(["EXECUTED", "ALREADY_EXECUTED", "FAILED", "CONFIRMATION_EXPIRED", "CANCELLED"]);

function pendingFrom(trace: ChatToolTrace[]) {
  let pending: ChatTurnResult["pending"] = null;
  let settled = false;
  for (const t of trace) {
    const st = String(t.output.status ?? "");
    if (st === "CONFIRMATION_REQUIRED" && t.output.actionId) {
      pending = { actionId: String(t.output.actionId), summary: String(t.output.summary ?? "") };
    } else if (SETTLED.has(st)) {
      settled = true;
      if (pending && (!t.output.actionId || t.output.actionId === pending.actionId)) pending = null;
    }
  }
  return { pending, settled };
}

/**
 * Tek sohbet turu. tc: loadVoiceToolContext ile doğrulanmış (aynı kullanıcı, ETKİN, CHAT kanalı) bağlam;
 * tc.utterance = kullanıcının bu mesajı (onay ayrıştırma bu metinle yapılır).
 */
export async function runChatTurn(
  tc: VoiceToolContext,
  rawMessage: unknown,
  model: ChatModel | null = getChatModel(),
): Promise<ChatTurnResult> {
  const message = typeof rawMessage === "string" ? rawMessage.trim().slice(0, 1000) : "";
  if (!message) throw new AppError("VALIDATION");
  const subject = `${tc.ctx.tenantId}:${tc.ctx.userId}`;
  if (await isRateLimited(CHAT_MESSAGE_RULE, subject)) throw new AppError("RATE_LIMITED");
  await recordHit(CHAT_MESSAGE_RULE, subject);
  const started = Date.now();
  const turnCtx: VoiceToolContext = { ...tc, utterance: message };

  // Test / E2E: deterministik düzenek (aynı araçlar, aynı onay akışı; ağ yok).
  if (isMockTransportEnabled()) {
    const t = await simulateVoiceTurn(turnCtx, message);
    const trace = t.toolCalls.map((c) => ({ name: c.name, output: c.output }));
    const ps = pendingFrom(trace);
    return {
      reply: t.reply,
      toolCalls: trace,
      // Düzenek önceki (yürütülmüş) eylemi durumda tutar: yalnızca bu tur üretilen veya araçsız turdaki bekleyen döner.
      pending: ps.pending ?? (ps.settled || trace.length ? null : (t.pending ?? null)),
      settled: ps.settled,
      grounded: t.grounded,
    };
  }
  if (!model) throw new AppError("VOICE_UNAVAILABLE");

  const conv = conversation(tc);
  const lang = tc.session.language;
  // Tıbbi karar: model çağrılmadan, araçsız ret.
  if (intentBoundary(message) === "MEDICAL") {
    conv.messages.push(
      { role: "user", content: message },
      { role: "assistant", content: MEDICAL_REFUSAL[lang] },
    );
    trim(conv.messages);
    logger.info("assistant.chat_turn", {
      rounds: 0,
      tools: 0,
      boundary: "MEDICAL",
      latencyMs: Date.now() - started,
    });
    return { reply: MEDICAL_REFUSAL[lang], toolCalls: [], pending: null, settled: false, grounded: true };
  }

  conv.messages.push({ role: "user", content: message });
  const system: ChatMessage = {
    role: "system",
    content: buildVoiceInstructions({
      language: lang,
      privacyMode: tc.session.privacyMode,
      clinicName: tc.session.clinicName,
      mode: "chat",
    }),
  };
  const tools = realtimeToolDefinitions().map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const trace: ChatToolTrace[] = [];
  let reply: string | null = null;
  let rounds = 0;
  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;
      const out = await model.complete([system, ...conv.messages], tools);
      if (!out.toolCalls.length) {
        reply = (out.content ?? "").trim();
        conv.messages.push({ role: "assistant", content: reply });
        break;
      }
      conv.messages.push({ role: "assistant", content: out.content, tool_calls: out.toolCalls });
      for (const call of out.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.function.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            args = parsed as Record<string, unknown>;
        } catch {
          // Geçersiz JSON → boş argüman; araç doğrulaması anlaşılır hata döner.
        }
        const result = await runVoiceTool(turnCtx, call.function.name, args);
        trace.push({ name: call.function.name, output: result });
        conv.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 8000),
        });
      }
    }
  } catch (e) {
    // Model hatası: yalnızca kod loglanır (yanıt gövdesi / anahtar YOK). Yarım kalan araç çifti geçmişten temizlenir.
    const code = e instanceof Error && /^CHAT_[A-Z0-9_]+$/.test(e.message) ? e.message : "CHAT_ERROR";
    logger.warn("assistant.chat_failed", { code, rounds, tools: trace.length });
    while (conv.messages.length && conv.messages[conv.messages.length - 1]!.role !== "user")
      conv.messages.pop();
    if (!trace.length) {
      conv.messages.pop();
      throw new AppError("VOICE_UNAVAILABLE");
    }
    reply = translateVoiceError("TOOL_FAILED", lang);
  }
  if (reply === null || !reply) {
    reply = lang === "en" ? "I couldn't complete that right now." : "Bunu şu anda tamamlayamadım.";
  }

  // Grounding: yanıttaki saat / sayı, konuşmadaki araç sonuçlarında veya kullanıcının kendi yazdığında olmalı.
  const evidence = conv.messages
    .filter((m) => m.role === "tool" || m.role === "user")
    .map((m) => (m as { content: string }).content);
  const grounded = groundingViolations(reply, evidence).length === 0;
  if (!grounded) {
    reply = translateVoiceError("TOOL_FAILED", lang);
    const last = conv.messages[conv.messages.length - 1];
    if (last?.role === "assistant") last.content = reply;
  }
  trim(conv.messages);
  const ps = pendingFrom(trace);
  logger.info("assistant.chat_turn", {
    rounds,
    tools: trace.length,
    grounded,
    pending: Boolean(ps.pending),
    latencyMs: Date.now() - started,
  });
  return { reply, toolCalls: trace, pending: ps.pending, settled: ps.settled, grounded };
}
