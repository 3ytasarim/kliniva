import "server-only";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { voiceSessions } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import { requirePermission, type AuthContext } from "@/server/auth/authz";
import { tenantQuery, tenantWhere } from "@/server/tenant/tenant-query";
import { isRateLimited, recordHit, type RateLimitRule } from "@/server/security/rate-limit";
import { getClinicProfile } from "@/server/services/clinic";
import { uuidSchema } from "@/server/validation";
import { logger } from "@/server/log/logger";
import { buildVoiceInstructions } from "@/server/voice/instructions";
import {
  getRealtimeTransport,
  isMockTransportEnabled,
  type RealtimeTransport,
} from "@/server/voice/transport";
import { realtimeToolDefinitions } from "@/server/voice/tools";
import type { VoiceLanguage } from "@/server/voice/dates";
import type { VoicePrivacyMode } from "@/server/voice/policy";

/**
 * Sesli asistan oturumu — mevcut Kliniva oturumuna bağlı. Kiracı / kullanıcı / rol / şube kapsamı / doktor kaydı
 * YALNIZCA sunucudaki AuthContext'ten gelir; model veya istemci bunları belirleyemez (araç şemalarında tenantId /
 * userId parametresi yoktur). Ham ses ve tam döküm SAKLANMAZ.
 *
 *  - Kullanıcı başına en fazla 2 etkin oturum (VOICE_SESSION_LIMIT); oturum açma hız sınırı.
 *  - İstemciye yalnızca kısa ömürlü istemci sırrı döner; ana anahtar asla. Sır loglanmaz / saklanmaz.
 */
export const VOICE_SESSION_TTL_MS = 30 * 60_000;
export const MAX_ACTIVE_VOICE_SESSIONS = 2;
const VOICE_SESSION_RULE: RateLimitRule = { name: "voice-session", limit: 20, windowSeconds: 10 * 60 };

export type VoiceSessionStart = {
  sessionId: string;
  transport: "openai" | "mock";
  clientSecret: string;
  expiresAt: number;
  model: string;
  language: VoiceLanguage;
  privacyMode: VoicePrivacyMode;
};

export type AssistantChannel = "VOICE" | "CHAT";

export type ChatSessionStart = {
  sessionId: string;
  transport: "openai" | "mock";
  language: VoiceLanguage;
  privacyMode: VoicePrivacyMode;
};

export type VoiceToolContext = {
  /** Sunucu tarafından türetilmiş, kanal işaretli bağlam (audit kaynağı AI_VOICE / AI_CHAT). */
  ctx: AuthContext;
  session: {
    id: string;
    channel: AssistantChannel;
    language: VoiceLanguage;
    privacyMode: VoicePrivacyMode;
    timezone: string;
    clinicName: string;
    cancellationReasonRequired: boolean;
  };
  /** Kullanıcının bu araç çağrısından önceki son sözü (onay ayrıştırma için); yoksa null. */
  utterance: string | null;
};

const pickLanguage = (asked: unknown, preferred: string): VoiceLanguage =>
  asked === "en" || asked === "tr" ? asked : preferred === "en" ? "en" : "tr";

/**
 * Etkin oturum açar (kanal başına kullanıcı sınırı; süresi dolmuşlar önce kapatılır; danışma kilidi → yarışta aşılmaz).
 * Ses ve yazılı sohbet ayrı sınırlanır: sohbet açık diye sesli oturum engellenmez.
 *  - VOICE: sınır aşılırsa VOICE_SESSION_LIMIT (her oturum sağlayıcı maliyeti + istemci sırrı demektir).
 *  - CHAT: sırrı / maliyeti olmayan sohbet oturumunda sınıra gelinince EN ESKİ etkin sohbet kapatılır (sayfa yenileme
 *    kapatılmamış oturum bırakır; kullanıcı 30 dk kilitlenmez). Kapanan oturumun bekleyen eylemi artık onaylanamaz.
 */
async function openSession(
  ctx: AuthContext,
  channel: AssistantChannel,
  transportKind: "openai" | "mock",
  language: VoiceLanguage,
): Promise<string> {
  return tenantQuery(ctx, async (scope) => {
    // Süresi dolmuş etkin oturumlar kapatılır; sonra sınır kontrolü (kullanıcı satırları kilitlenir → yarışta aşılmaz).
    await scope.tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${scope.tenantId}:voice:${ctx.userId}:${channel}`}, 0))`,
    );
    await scope.tx
      .update(voiceSessions)
      .set({ status: "EXPIRED", endedAt: sql`now()` })
      .where(
        tenantWhere(
          voiceSessions,
          scope,
          eq(voiceSessions.userId, ctx.userId),
          eq(voiceSessions.status, "ACTIVE"),
          lte(voiceSessions.expiresAt, sql`now()`),
        ),
      );
    const [{ n }] = (await scope.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(voiceSessions)
      .where(
        tenantWhere(
          voiceSessions,
          scope,
          eq(voiceSessions.userId, ctx.userId),
          eq(voiceSessions.channel, channel),
          eq(voiceSessions.status, "ACTIVE"),
        ),
      )) as [{ n: number }];
    if (n >= MAX_ACTIVE_VOICE_SESSIONS) {
      if (channel !== "CHAT") throw new AppError("VOICE_SESSION_LIMIT");
      const oldest = await scope.tx
        .select({ id: voiceSessions.id })
        .from(voiceSessions)
        .where(
          tenantWhere(
            voiceSessions,
            scope,
            eq(voiceSessions.userId, ctx.userId),
            eq(voiceSessions.channel, "CHAT"),
            eq(voiceSessions.status, "ACTIVE"),
          ),
        )
        .orderBy(asc(voiceSessions.startedAt))
        .limit(n - MAX_ACTIVE_VOICE_SESSIONS + 1);
      await scope.tx
        .update(voiceSessions)
        .set({ status: "ENDED", endedAt: sql`now()` })
        .where(
          tenantWhere(
            voiceSessions,
            scope,
            inArray(
              voiceSessions.id,
              oldest.map((o) => o.id),
            ),
          ),
        );
    }
    const [row] = await scope.tx
      .insert(voiceSessions)
      .values({
        tenantId: scope.tenantId,
        userId: ctx.userId,
        language,
        transport: transportKind,
        channel,
        expiresAt: sql`now() + make_interval(secs => ${VOICE_SESSION_TTL_MS / 1000})`,
      })
      .returning({ id: voiceSessions.id });
    return row!.id;
  });
}

export async function createVoiceSession(
  ctx: AuthContext,
  input: { language?: unknown } = {},
  transport: RealtimeTransport | null = getRealtimeTransport(),
): Promise<VoiceSessionStart> {
  requirePermission(ctx, "voice.use");
  const profile = await getClinicProfile(ctx);
  if (!profile.voiceEnabled) throw new AppError("VOICE_DISABLED");
  if (!transport) throw new AppError("VOICE_UNAVAILABLE");
  const subject = `${ctx.tenantId}:${ctx.userId}`;
  if (await isRateLimited(VOICE_SESSION_RULE, subject)) throw new AppError("RATE_LIMITED");
  await recordHit(VOICE_SESSION_RULE, subject);
  const language = pickLanguage(input.language, profile.preferredVoiceLanguage);

  const sessionId = await openSession(ctx, "VOICE", transport.kind, language);

  const privacyMode = profile.voicePrivacyMode;
  try {
    const secret = await transport.createClientSecret({
      instructions: buildVoiceInstructions({ language, privacyMode, clinicName: profile.displayName }),
      tools: realtimeToolDefinitions(),
      language,
    });
    logger.info("voice.session_started", { transport: transport.kind, language });
    return {
      sessionId,
      transport: transport.kind,
      clientSecret: secret.value,
      expiresAt: secret.expiresAt,
      model: secret.model,
      language,
      privacyMode,
    };
  } catch (e) {
    // Hata kodu yalnızca (yanıt gövdesi / anahtar loglanmaz).
    logger.warn("voice.session_secret_failed", {
      code: e instanceof Error && /^REALTIME_[A-Z0-9_]+$/.test(e.message) ? e.message : "REALTIME_ERROR",
    });
    await tenantQuery(ctx, (scope) =>
      scope.tx
        .update(voiceSessions)
        .set({ status: "FAILED", endedAt: sql`now()` })
        .where(tenantWhere(voiceSessions, scope, eq(voiceSessions.id, sessionId))),
    );
    throw new AppError("VOICE_UNAVAILABLE");
  }
}

/**
 * Yazılı sohbet oturumu: istemciye sır DÖNMEZ (model çağrısı tamamen sunucuda). Anahtar yoksa kullanılamaz.
 * Aynı yetki / klinik ayarı / hız sınırı / kullanıcı başına etkin oturum sınırı uygulanır.
 */
export async function createChatSession(
  ctx: AuthContext,
  input: { language?: unknown } = {},
  transportKind: "openai" | "mock" | null = chatTransportKind(),
): Promise<ChatSessionStart> {
  requirePermission(ctx, "voice.use");
  const profile = await getClinicProfile(ctx);
  if (!profile.voiceEnabled) throw new AppError("VOICE_DISABLED");
  if (!transportKind) throw new AppError("VOICE_UNAVAILABLE");
  const subject = `${ctx.tenantId}:${ctx.userId}`;
  if (await isRateLimited(VOICE_SESSION_RULE, subject)) throw new AppError("RATE_LIMITED");
  await recordHit(VOICE_SESSION_RULE, subject);
  const language = pickLanguage(input.language, profile.preferredVoiceLanguage);
  const sessionId = await openSession(ctx, "CHAT", transportKind, language);
  logger.info("assistant.chat_session_started", { transport: transportKind, language });
  return { sessionId, transport: transportKind, language, privacyMode: profile.voicePrivacyMode };
}

/** Sohbet taşıyıcısı: VOICE_TRANSPORT=mock → sahte (test); anahtar varsa OpenAI; yoksa kullanılamaz. */
export function chatTransportKind(): "openai" | "mock" | null {
  if (isMockTransportEnabled()) return "mock";
  return process.env.OPENAI_API_KEY ? "openai" : null;
}

export async function endVoiceSession(ctx: AuthContext, rawId: unknown): Promise<void> {
  requirePermission(ctx, "voice.use");
  const id = uuidSchema.safeParse(rawId);
  if (!id.success) throw new AppError("NOT_FOUND");
  await tenantQuery(ctx, async (scope) => {
    const r = await scope.tx
      .update(voiceSessions)
      .set({ status: "ENDED", endedAt: sql`now()` })
      .where(
        tenantWhere(
          voiceSessions,
          scope,
          eq(voiceSessions.id, id.data),
          eq(voiceSessions.userId, ctx.userId),
          eq(voiceSessions.status, "ACTIVE"),
        ),
      )
      .returning({ id: voiceSessions.id });
    if (!r.length) {
      const [exists] = await scope.tx
        .select({ id: voiceSessions.id })
        .from(voiceSessions)
        .where(
          tenantWhere(
            voiceSessions,
            scope,
            eq(voiceSessions.id, id.data),
            eq(voiceSessions.userId, ctx.userId),
          ),
        );
      if (!exists) throw new AppError("NOT_FOUND");
    }
  });
}

/**
 * Araç çağrısı bağlamı: oturum AYNI kullanıcıya + kiracıya ait, ETKİN ve süresi dolmamış olmalı (aksi NOT_FOUND).
 * Bağlam kanal işaretli kopyadır; yetkiler aynen kalır (sesli asistan ek yetki VERMEZ).
 */
export async function loadVoiceToolContext(
  ctx: AuthContext,
  rawSessionId: unknown,
  utterance: unknown,
  /** Uç nokta beklediği kanalı belirtir (ses aracı uç noktası CHAT oturumunu, sohbet uç noktası VOICE oturumunu kabul etmez). */
  expect?: AssistantChannel,
): Promise<VoiceToolContext> {
  requirePermission(ctx, "voice.use");
  const id = uuidSchema.safeParse(rawSessionId);
  if (!id.success) throw new AppError("NOT_FOUND");
  const row = await tenantQuery(ctx, async (scope) => {
    const [s] = await scope.tx
      .select({ id: voiceSessions.id, language: voiceSessions.language, channel: voiceSessions.channel })
      .from(voiceSessions)
      .where(
        tenantWhere(
          voiceSessions,
          scope,
          eq(voiceSessions.id, id.data),
          eq(voiceSessions.userId, ctx.userId),
          eq(voiceSessions.status, "ACTIVE"),
          sql`${voiceSessions.expiresAt} > now()`,
        ),
      );
    return s ?? null;
  });
  if (!row) throw new AppError("NOT_FOUND");
  if (expect && (row.channel === "CHAT" ? "CHAT" : "VOICE") !== expect) throw new AppError("NOT_FOUND");
  const profile = await getClinicProfile(ctx);
  if (!profile.voiceEnabled) throw new AppError("VOICE_DISABLED");
  const cancelReq = (profile as unknown as { cancellationReasonRequired?: boolean })
    .cancellationReasonRequired;
  const text = typeof utterance === "string" ? utterance.slice(0, 1000) : null;
  return {
    ctx: { ...ctx, channel: row.channel === "CHAT" ? "AI_CHAT" : "AI_VOICE" },
    session: {
      id: row.id,
      channel: row.channel === "CHAT" ? "CHAT" : "VOICE",
      language: row.language === "en" ? "en" : "tr",
      privacyMode: profile.voicePrivacyMode,
      timezone: profile.timezone,
      clinicName: profile.displayName,
      cancellationReasonRequired: cancelReq ?? true,
    },
    utterance: text,
  };
}

/** Kullanıcı oturum içinde dil değiştirirse (ör. "Do you speak English?") tercih korunur. */
export async function setVoiceSessionLanguage(ctx: AuthContext, sessionId: string, language: VoiceLanguage) {
  await tenantQuery(ctx, (scope) =>
    scope.tx
      .update(voiceSessions)
      .set({ language })
      .where(
        tenantWhere(
          voiceSessions,
          scope,
          and(eq(voiceSessions.id, sessionId), eq(voiceSessions.userId, ctx.userId)),
        ),
      ),
  );
}
