import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { aiActionLogs, pendingAiActions } from "@/server/db/schema";
import { AppError, isAppError } from "@/server/errors";
import { tenantQuery, tenantWhere, type TenantScope } from "@/server/tenant/tenant-query";
import { decryptField, encryptField, sha256Hex } from "@/server/security/crypto";
import { PG_UNIQUE_VIOLATION, pgErrorInfo } from "@/server/db/pg-errors";
import { logger } from "@/server/log/logger";
import { uuidSchema } from "@/server/validation";
import { parseConfirmation, translateVoiceError } from "@/server/voice/policy";
import type { VoiceToolContext } from "@/server/voice/session";

/**
 * ONAYLI YAZMA EYLEMLERİ (PendingAIAction)
 *
 *  1. Hazırla: araç girdisi sunucuda doğrulanır / çözülür → kanonik JSON → ŞİFRELİ saklanır + SHA-256 bütünlük
 *     özeti; idempotency anahtarı = H(oturum | araç | girdi). Aynı oturumda aynı araç + aynı girdi → etkin TEK kayıt
 *     (kısmi benzersiz indeks): yinelenen araç çağrısı / yeniden bağlanma ikinci iş eylemi üretmez.
 *  2. Onayla: YALNIZCA aynı kullanıcı + aynı ses oturumu + süresi dolmamış PENDING eylem (aksi NOT_FOUND / süresi
 *     doldu). Sesli onayda kullanıcının SON sözü açık onay olmalı ("evet / onaylıyorum / tamam"); belirsiz söz
 *     ("olabilir / sanırım") onay değildir. Model "evet" duyduğu için başka / eski eylemi yürütemez: onay eylem
 *     kimliğine bağlıdır ve girdi sonradan değiştirilemez (DB tetikleyicisi + bütünlük özeti).
 *  3. Yürüt: PENDING → CONFIRMED tek UPDATE ile talep edilir (eşzamanlı ikinci onay bulamaz) → iş servisi (mevcut
 *     yetki / RLS / kilit / outbox) → EXECUTED / FAILED. Tekrar onay önceki sonucu güvenle döndürür.
 * AIActionLog: araç adı, eylem tipi, varlık kimliği, güvenli meta (kimlikler / kod) — hasta adı / döküm / ses YOK.
 */
export type ExecResult = {
  entityType: string;
  entityId: string | null;
  code: string;
  meta?: Record<string, string | number | boolean | null>;
};
export type Executor = (tc: VoiceToolContext, input: Record<string, unknown>) => Promise<ExecResult>;

const confirmTtlSeconds = () =>
  Math.min(Math.max(Number(process.env.VOICE_CONFIRM_TTL_SECONDS ?? 120) || 120, 1), 600);
const inputAad = (tenantId: string, id: string) => `ai_action.input:${tenantId}:${id}`;

/** Anahtar sırası sabit JSON (aynı girdi → aynı özet). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}
export const inputHash = (input: unknown) => sha256Hex(canonicalJson(input));
export const idempotencyKeyOf = (sessionId: string, tool: string, input: unknown) =>
  sha256Hex(`${sessionId}|${tool}|${canonicalJson(input)}`);

export type PrepareResult =
  | { status: "CONFIRMATION_REQUIRED"; actionId: string; summary: string; expiresInSeconds: number }
  | { status: "ALREADY_EXECUTED"; actionId: string; message: string; result: Record<string, unknown> };

function logMeta(
  tool: string,
  input: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  // Yalnızca kimlikler (uuid) ve kısa kodlar; serbest metin (gerekçe, not) YAZILMAZ.
  const out: Record<string, string | number | boolean | null> = { tool };
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" && /^[0-9a-f-]{36}$/.test(v)) out[k] = v;
    else if (k === "start" && typeof v === "string") out.start = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

const alreadyExecutedMessage = (tc: VoiceToolContext) =>
  tc.session.language === "en"
    ? "This action was already carried out; it was not repeated."
    : "Bu işlem zaten gerçekleştirildi; tekrar yapılmadı.";

/**
 * Aynı oturumda aynı girdiyle eylem zaten yürütüldüyse (veya yürütülüyorsa) o sonucu döndürür. Hazırlık öncesi
 * müsaitlik kontrolünden ÖNCE çağrılır: tekrarlanan araç çağrısı kendi oluşturduğu randevuyla "çakışma" sanılmaz.
 */
export async function priorExecution(
  tc: VoiceToolContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<PrepareResult | null> {
  const key = idempotencyKeyOf(tc.session.id, toolName, JSON.parse(canonicalJson(input)));
  const [row] = await tenantQuery(tc.ctx, (scope) =>
    scope.tx
      .select({
        id: pendingAiActions.id,
        entityId: pendingAiActions.resultEntityId,
        code: pendingAiActions.resultCode,
      })
      .from(pendingAiActions)
      .where(
        tenantWhere(
          pendingAiActions,
          scope,
          eq(pendingAiActions.idempotencyKey, key),
          sql`${pendingAiActions.status} in ('CONFIRMED', 'EXECUTED')`,
        ),
      ),
  );
  return row
    ? {
        status: "ALREADY_EXECUTED",
        actionId: row.id,
        message: alreadyExecutedMessage(tc),
        result: { entityId: row.entityId, code: row.code },
      }
    : null;
}

export async function preparePendingAction(
  tc: VoiceToolContext,
  toolName: string,
  input: Record<string, unknown>,
  summary: string,
  entity: { entityType: string; entityId: string | null } = { entityType: "appointment", entityId: null },
): Promise<PrepareResult> {
  const canonical = JSON.parse(canonicalJson(input)) as Record<string, unknown>;
  const hash = inputHash(canonical);
  const key = idempotencyKeyOf(tc.session.id, toolName, canonical);
  const ttl = confirmTtlSeconds();
  const attempt = () =>
    tenantQuery(tc.ctx, async (scope): Promise<PrepareResult> => {
      const [existing] = await scope.tx
        .select()
        .from(pendingAiActions)
        .where(
          tenantWhere(
            pendingAiActions,
            scope,
            eq(pendingAiActions.idempotencyKey, key),
            sql`${pendingAiActions.status} in ('PENDING', 'CONFIRMED', 'EXECUTED')`,
          ),
        )
        .for("update");
      if (existing) {
        if (existing.status === "EXECUTED" || existing.status === "CONFIRMED") {
          return {
            status: "ALREADY_EXECUTED",
            actionId: existing.id,
            message: alreadyExecutedMessage(tc),
            result: { entityId: existing.resultEntityId, code: existing.resultCode },
          };
        }
        const live = await scope.tx.execute<{ live: boolean }>(
          sql`select ${existing.expiresAt.toISOString()}::timestamptz > now() as live`,
        );
        if (live.rows[0]?.live) {
          return { status: "CONFIRMATION_REQUIRED", actionId: existing.id, summary, expiresInSeconds: ttl };
        }
        await expire(scope, existing.id, existing.aiActionLogId);
      }
      const id = randomUUID();
      const [log] = await scope.tx
        .insert(aiActionLogs)
        .values({
          tenantId: scope.tenantId,
          userId: tc.ctx.userId,
          voiceSessionId: tc.session.id,
          toolName,
          actionType: "WRITE",
          entityType: entity.entityType,
          entityId: entity.entityId,
          status: "REQUESTED",
          confirmationRequired: true,
          confirmed: false,
          safeMetadata: logMeta(toolName, canonical),
        })
        .returning({ id: aiActionLogs.id });
      await scope.tx.insert(pendingAiActions).values({
        id,
        tenantId: scope.tenantId,
        userId: tc.ctx.userId,
        voiceSessionId: tc.session.id,
        toolName,
        safeInputHash: hash,
        inputEncrypted: encryptField(canonicalJson(canonical), inputAad(scope.tenantId, id)),
        idempotencyKey: key,
        aiActionLogId: log!.id,
        expiresAt: sql`now() + make_interval(secs => ${ttl})`,
      });
      return { status: "CONFIRMATION_REQUIRED", actionId: id, summary, expiresInSeconds: ttl };
    });
  try {
    return await attempt();
  } catch (e) {
    // Eşzamanlı aynı hazırlık: benzersiz indeks → mevcut kayıt döndürülür.
    if (pgErrorInfo(e).code === PG_UNIQUE_VIOLATION) return attempt();
    throw e;
  }
}

async function expire(scope: TenantScope, id: string, logId: string | null) {
  await scope.tx
    .update(pendingAiActions)
    .set({ status: "EXPIRED", resultCode: "CONFIRMATION_EXPIRED", updatedAt: new Date() })
    .where(
      tenantWhere(
        pendingAiActions,
        scope,
        eq(pendingAiActions.id, id),
        eq(pendingAiActions.status, "PENDING"),
      ),
    );
  if (logId) {
    await scope.tx
      .update(aiActionLogs)
      .set({
        status: "CANCELLED",
        safeMetadata: sql`coalesce(${aiActionLogs.safeMetadata}, '{}'::jsonb) || '{"code":"CONFIRMATION_EXPIRED"}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        tenantWhere(aiActionLogs, scope, eq(aiActionLogs.id, logId), eq(aiActionLogs.status, "REQUESTED")),
      );
  }
}

export type ConfirmResult =
  | { status: "EXECUTED"; actionId: string; message: string; result: Record<string, unknown> }
  | { status: "ALREADY_EXECUTED"; actionId: string; message: string; result: Record<string, unknown> }
  | { status: "IN_PROGRESS"; actionId: string; message: string }
  | { status: "FAILED"; actionId: string; error: string; message: string }
  | { status: "CONFIRMATION_EXPIRED"; actionId: string; message: string }
  | { status: "CONFIRMATION_NOT_DETECTED"; actionId: string; message: string }
  | { status: "CANCELLED"; actionId: string; message: string };

/**
 * Onay + yürütme. via=VOICE ise kullanıcının son sözü açık onay olmalı; via=UI açık düğme tıklamasıdır.
 */
export async function confirmPendingAction(
  tc: VoiceToolContext,
  rawActionId: unknown,
  via: "VOICE" | "UI",
  executors: Record<string, Executor>,
  describe: (tool: string, r: ExecResult) => string,
): Promise<ConfirmResult> {
  const parsed = uuidSchema.safeParse(rawActionId);
  if (!parsed.success) throw new AppError("NOT_FOUND");
  const actionId = parsed.data;
  const lang = tc.session.language;
  if (via === "VOICE") {
    const verdict = parseConfirmation(tc.utterance);
    if (verdict !== "CONFIRM") {
      return {
        status: "CONFIRMATION_NOT_DETECTED",
        actionId,
        message:
          lang === "en"
            ? "I did not hear a clear confirmation. Shall I proceed? Please say yes or no."
            : "Açık bir onay duymadım. İşleme devam edeyim mi? Lütfen 'evet' veya 'hayır' deyin.",
      };
    }
  }
  // 1) Talep: PENDING → CONFIRMED (aynı kullanıcı + aynı oturum; tek UPDATE — eşzamanlı ikinci onay bulamaz)
  const claim = await tenantQuery(tc.ctx, async (scope) => {
    const [row] = await scope.tx
      .select()
      .from(pendingAiActions)
      .where(
        tenantWhere(
          pendingAiActions,
          scope,
          eq(pendingAiActions.id, actionId),
          eq(pendingAiActions.userId, tc.ctx.userId),
          eq(pendingAiActions.voiceSessionId, tc.session.id),
        ),
      )
      .for("update");
    if (!row) throw new AppError("NOT_FOUND");
    if (row.status === "EXECUTED") return { kind: "done" as const, row };
    if (row.status === "CONFIRMED") return { kind: "progress" as const, row };
    if (row.status === "FAILED") return { kind: "failed" as const, row };
    if (row.status === "CANCELLED") return { kind: "cancelled" as const, row };
    const live = await scope.tx.execute<{ live: boolean }>(
      sql`select ${row.expiresAt.toISOString()}::timestamptz > now() as live`,
    );
    if (row.status === "EXPIRED" || !live.rows[0]?.live) {
      await expire(scope, row.id, row.aiActionLogId);
      return { kind: "expired" as const, row };
    }
    const input = JSON.parse(decryptField(row.inputEncrypted, inputAad(scope.tenantId, row.id))) as Record<
      string,
      unknown
    >;
    if (inputHash(input) !== row.safeInputHash) throw new AppError("FORBIDDEN"); // bütünlük ihlali — yürütülmez
    await scope.tx
      .update(pendingAiActions)
      .set({ status: "CONFIRMED", confirmedAt: sql`now()`, updatedAt: new Date() })
      .where(
        tenantWhere(
          pendingAiActions,
          scope,
          eq(pendingAiActions.id, row.id),
          eq(pendingAiActions.status, "PENDING"),
        ),
      );
    if (row.aiActionLogId) {
      await scope.tx
        .update(aiActionLogs)
        .set({ status: "CONFIRMED", confirmed: true, updatedAt: new Date() })
        .where(tenantWhere(aiActionLogs, scope, eq(aiActionLogs.id, row.aiActionLogId)));
    }
    return { kind: "claimed" as const, row, input };
  });

  const { row } = claim;
  if (claim.kind === "done") {
    return {
      status: "ALREADY_EXECUTED",
      actionId,
      message:
        lang === "en"
          ? "This was already done; it was not repeated."
          : "Bu işlem zaten yapıldı; tekrar edilmedi.",
      result: { entityId: row.resultEntityId, code: row.resultCode },
    };
  }
  if (claim.kind === "progress") {
    return {
      status: "IN_PROGRESS",
      actionId,
      message: lang === "en" ? "This action is already being processed." : "Bu işlem zaten işleniyor.",
    };
  }
  if (claim.kind === "failed") {
    const code = row.resultCode ?? "TOOL_FAILED";
    return { status: "FAILED", actionId, error: code, message: translateVoiceError(code, lang) };
  }
  if (claim.kind === "cancelled") {
    return {
      status: "CANCELLED",
      actionId,
      message: lang === "en" ? "This action was cancelled." : "Bu işlem iptal edilmişti.",
    };
  }
  if (claim.kind === "expired") {
    return {
      status: "CONFIRMATION_EXPIRED",
      actionId,
      message: translateVoiceError("CONFIRMATION_EXPIRED", lang),
    };
  }

  // 2) Yürüt (iş servisi kendi transaction'ında atomik; konuşma kesilse de yarım kalmaz)
  const exec = executors[row.toolName];
  let result: ExecResult | null = null;
  let errorCode: string | null = null;
  const started = Date.now();
  try {
    if (!exec) throw new AppError("FORBIDDEN");
    result = await exec(tc, claim.input);
  } catch (e) {
    errorCode = isAppError(e) ? e.code : "TOOL_FAILED";
    if (!isAppError(e)) logger.error("voice.action_failed", { tool: row.toolName, error: e });
  }
  // 3) Sonuç
  await tenantQuery(tc.ctx, async (scope) => {
    await scope.tx
      .update(pendingAiActions)
      .set(
        result
          ? {
              status: "EXECUTED",
              executedAt: sql`now()`,
              resultEntityId: result.entityId,
              resultCode: result.code,
              updatedAt: new Date(),
            }
          : { status: "FAILED", resultCode: errorCode, updatedAt: new Date() },
      )
      .where(
        tenantWhere(
          pendingAiActions,
          scope,
          eq(pendingAiActions.id, row.id),
          eq(pendingAiActions.status, "CONFIRMED"),
        ),
      );
    if (row.aiActionLogId) {
      await scope.tx
        .update(aiActionLogs)
        .set({
          status: result ? "SUCCEEDED" : "FAILED",
          entityType: result?.entityType ?? undefined,
          entityId: result?.entityId ?? undefined,
          safeMetadata: sql`coalesce(${aiActionLogs.safeMetadata}, '{}'::jsonb) || ${JSON.stringify({
            code: result?.code ?? errorCode,
            latencyMs: Date.now() - started,
            ...(result?.meta ?? {}),
          })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(tenantWhere(aiActionLogs, scope, and(eq(aiActionLogs.id, row.aiActionLogId))));
    }
  });
  logger.info("voice.action", {
    tool: row.toolName,
    ok: Boolean(result),
    code: result?.code ?? errorCode,
    latencyMs: Date.now() - started,
  });
  if (!result) {
    return { status: "FAILED", actionId, error: errorCode!, message: translateVoiceError(errorCode!, lang) };
  }
  return {
    status: "EXECUTED",
    actionId,
    message: describe(row.toolName, result),
    result: { entityType: result.entityType, entityId: result.entityId, code: result.code },
  };
}

/** Kullanıcı vazgeçti: yalnızca kendi + aynı oturumdaki PENDING eylem. */
export async function cancelPendingAction(
  tc: VoiceToolContext,
  rawActionId: unknown,
): Promise<{ status: "CANCELLED" }> {
  const parsed = uuidSchema.safeParse(rawActionId);
  if (!parsed.success) throw new AppError("NOT_FOUND");
  await tenantQuery(tc.ctx, async (scope) => {
    const [row] = await scope.tx
      .select({
        id: pendingAiActions.id,
        status: pendingAiActions.status,
        logId: pendingAiActions.aiActionLogId,
      })
      .from(pendingAiActions)
      .where(
        tenantWhere(
          pendingAiActions,
          scope,
          eq(pendingAiActions.id, parsed.data),
          eq(pendingAiActions.userId, tc.ctx.userId),
          eq(pendingAiActions.voiceSessionId, tc.session.id),
        ),
      )
      .for("update");
    if (!row) throw new AppError("NOT_FOUND");
    if (row.status !== "PENDING") return;
    await scope.tx
      .update(pendingAiActions)
      .set({ status: "CANCELLED", updatedAt: new Date() })
      .where(tenantWhere(pendingAiActions, scope, eq(pendingAiActions.id, row.id)));
    if (row.logId) {
      await scope.tx
        .update(aiActionLogs)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(
          tenantWhere(
            aiActionLogs,
            scope,
            eq(aiActionLogs.id, row.logId),
            eq(aiActionLogs.status, "REQUESTED"),
          ),
        );
    }
  });
  return { status: "CANCELLED" };
}
