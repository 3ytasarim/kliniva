import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getMigrationDb } from "@/server/db/migration-client";
import { aiActionLogs, appointmentEvents, appointments, auditLogs, voiceSessions } from "@/server/db/schema";
import { AppError } from "@/server/errors";
import type { AuthContext } from "@/server/auth/authz";
import { runInTenant } from "@/server/tenant/tenant-query";
import { assignDoctorBranch, createDoctor } from "@/server/services/doctors";
import { addWorkingHour } from "@/server/services/schedule";
import { createPatient } from "@/server/services/patients";
import { createClinicalService, setDoctorServices } from "@/server/services/clinical-services";
import { upsertClinicProfile } from "@/server/services/clinic";
import {
  createChatSession,
  createVoiceSession,
  endVoiceSession,
  loadVoiceToolContext,
  type VoiceToolContext,
} from "@/server/voice/session";
import { forgetConversation, runChatTurn, type ChatModel } from "@/server/assistant/chat";
import { addDays, dateInZone, isoDayOfWeek, parseTime, zonedDateTimeToUtc } from "@/lib/time";
import { cleanupTenants, createTenant, dbError, type TestTenant } from "../support/fixtures";

/**
 * Kliniva AI YAZILI SOHBET — sunucu tarafı model döngüsü. Model yerine SENARYOLU sahte model (ağ yok): modelin ne
 * çağıracağını test belirler; sunucunun yetki / kapsam / onay / idempotency / kanal kurallarını MODELDEN BAĞIMSIZ
 * uyguladığı doğrulanır (ör. model kullanıcı "olabilir" dediğinde onay aracını çağırsa bile yürütme OLMAZ).
 */
const TZ = "Europe/Istanbul";
let A: TestTenant;
let B: TestTenant;
let D1: string;
let S: string;
let P: string;

const today = () => dateInZone(new Date(), TZ);
function nextMonday(): string {
  let d = addDays(today(), 2);
  while (isoDayOfWeek(d) !== 1) d = addDays(d, 1);
  return addDays(d, 7);
}
const at = (date: string, hhmm: string) => zonedDateTimeToUtc(date, parseTime(hhmm)!, TZ).toISOString();
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `UNEXPECTED:${(e as Error).message}`;
  }
};

type Step = { content?: string | null; tools?: { name: string; args: Record<string, unknown> }[] };
/** Senaryolu model: her complete() çağrısında sıradaki adımı döndürür; aldığı mesajları kaydeder. */
class ScriptedModel implements ChatModel {
  calls: { messages: { role: string; content?: unknown }[]; tools: unknown[] }[] = [];
  private n = 0;
  constructor(private readonly steps: Step[]) {}
  async complete(messages: { role: string; content?: unknown }[], tools: unknown[]) {
    this.calls.push({ messages: structuredClone(messages), tools });
    const s = this.steps[this.n++] ?? { content: "Tamam." };
    return {
      content: s.content ?? null,
      toolCalls: (s.tools ?? []).map((t, i) => ({
        id: `call_${this.n}_${i}`,
        type: "function" as const,
        function: { name: t.name, arguments: JSON.stringify(t.args) },
      })),
    };
  }
}
class FailingModel implements ChatModel {
  async complete(): Promise<never> {
    throw new Error("CHAT_HTTP_500");
  }
}

async function chat(ctx: AuthContext): Promise<VoiceToolContext> {
  const s = await createChatSession(ctx, {}, "openai");
  return loadVoiceToolContext(ctx, s.sessionId, null, "CHAT");
}
const apptsAt = (startIso: string) =>
  runInTenant(A.id, (s) =>
    s.tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.doctorId, D1), eq(appointments.scheduledStart, new Date(startIso)))),
  );

const savedTransport = process.env.VOICE_TRANSPORT;
beforeAll(async () => {
  // Bu dosya sunucu tarafı model döngüsünü test eder: sahte taşıyıcı (deterministik düzenek) KAPALI, model senaryolu.
  process.env.VOICE_TRANSPORT = "";
  A = await createTenant({
    owner: { role: "CLINIC_OWNER" },
    reception: { role: "RECEPTION", branch: "A" },
    reception2: { role: "RECEPTION", branch: "A" },
    docA: { role: "DOCTOR" },
    readonly: { role: "READ_ONLY" },
  });
  B = await createTenant({ owner: { role: "CLINIC_OWNER" } });
  const owner = A.users.owner!.ctx;
  D1 = (await createDoctor(owner, { mode: "existing", userId: A.users.docA!.id, specialty: "Dermatoloji" }))
    .id;
  S = (
    await createClinicalService(owner, {
      name: "Muayene",
      defaultDurationMinutes: 30,
      requiresRoom: false,
      allowedRoomTypes: [],
    })
  ).id;
  await assignDoctorBranch(owner, D1, A.branchA);
  for (let dow = 1; dow <= 7; dow++) {
    await addWorkingHour(owner, {
      doctorId: D1,
      branchId: A.branchA,
      dayOfWeek: dow,
      startTime: "08:00",
      endTime: "20:00",
    });
  }
  await setDoctorServices(owner, { doctorId: D1, services: [{ serviceId: S }] });
  P = (
    await createPatient(owner, {
      firstName: "Demo",
      lastName: "Hasta",
      phone: "05391119001",
      branchId: A.branchA,
    })
  ).id;
}, 300_000);

afterAll(async () => {
  process.env.VOICE_TRANSPORT = savedTransport;
  await cleanupTenants();
});

describe("Sohbet oturumu", () => {
  afterEach(() => undefined);

  it("istemciye sır dönmez; CHAT kanalı; yetkisiz / kapalı / anahtarsız reddedilir", async () => {
    const s = await createChatSession(A.users.reception!.ctx, {}, "openai");
    expect(Object.keys(s).sort()).toEqual(["language", "privacyMode", "sessionId", "transport"]);
    const [row] = await runInTenant(A.id, (x) =>
      x.tx.select().from(voiceSessions).where(eq(voiceSessions.id, s.sessionId)),
    );
    expect([row!.channel, row!.status]).toEqual(["CHAT", "ACTIVE"]);
    expect(await code(createChatSession(A.users.readonly!.ctx, {}, "openai"))).toBe("FORBIDDEN");
    expect(await code(createChatSession(A.users.reception!.ctx, {}, null))).toBe("VOICE_UNAVAILABLE");
    await upsertClinicProfile(A.users.owner!.ctx, { displayName: "Sohbet Klinik", voiceEnabled: false });
    expect(await code(createChatSession(A.users.reception!.ctx, {}, "openai"))).toBe("VOICE_DISABLED");
    await upsertClinicProfile(A.users.owner!.ctx, { displayName: "Sohbet Klinik", voiceEnabled: true });
    // Kanal değişmez (uygulama rolü: sütun yetkisi yok; sahip rolü: tetikleyici)
    const app = await dbError(
      runInTenant(A.id, (x) =>
        x.tx.execute(sql`update kliniva.voice_sessions set channel = 'VOICE' where id = ${s.sessionId}`),
      ),
    );
    expect(app.code).toBe("42501");
    const ownerErr = await dbError(
      getMigrationDb().execute(
        sql`update kliniva.voice_sessions set channel = 'VOICE' where id = ${s.sessionId}`,
      ),
    );
    expect(ownerErr.message).toMatch(/KLINIVA_IMMUTABLE/);
  });

  it("kanal izolasyonu: sohbet oturumu ses araç uç noktasında, ses oturumu sohbette kullanılamaz; başka kiracı / kullanıcı NOT_FOUND", async () => {
    const ctx = A.users.reception2!.ctx;
    const c = await createChatSession(ctx, {}, "openai");
    const v = await createVoiceSession(ctx);
    expect(await code(loadVoiceToolContext(ctx, c.sessionId, null, "VOICE"))).toBe("NOT_FOUND");
    expect(await code(loadVoiceToolContext(ctx, v.sessionId, null, "CHAT"))).toBe("NOT_FOUND");
    expect(await code(loadVoiceToolContext(A.users.reception!.ctx, c.sessionId, null, "CHAT"))).toBe(
      "NOT_FOUND",
    );
    expect(await code(loadVoiceToolContext(B.users.owner!.ctx, c.sessionId, null, "CHAT"))).toBe("NOT_FOUND");
    const tc = await loadVoiceToolContext(ctx, c.sessionId, null, "CHAT");
    expect([tc.ctx.channel, tc.session.channel]).toEqual(["AI_CHAT", "CHAT"]);
    await endVoiceSession(ctx, v.sessionId);
    await endVoiceSession(ctx, c.sessionId);
  });

  it("sınır: sohbette 3. oturum EN ESKİYİ kapatır (kilitlenme yok); seste VOICE_SESSION_LIMIT korunur", async () => {
    const ctx = A.users.owner!.ctx;
    const c1 = await createChatSession(ctx, {}, "openai");
    const c2 = await createChatSession(ctx, {}, "openai");
    const c3 = await createChatSession(ctx, {}, "openai");
    const rows = await runInTenant(A.id, (x) =>
      x.tx
        .select({ id: voiceSessions.id, status: voiceSessions.status })
        .from(voiceSessions)
        .where(and(eq(voiceSessions.userId, ctx.userId), eq(voiceSessions.channel, "CHAT"))),
    );
    const st = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect([st[c1.sessionId], st[c2.sessionId], st[c3.sessionId]]).toEqual(["ENDED", "ACTIVE", "ACTIVE"]);
    expect(await code(loadVoiceToolContext(ctx, c1.sessionId, null, "CHAT"))).toBe("NOT_FOUND");
    const v1 = await createVoiceSession(ctx);
    const v2 = await createVoiceSession(ctx);
    expect(await code(createVoiceSession(ctx))).toBe("VOICE_SESSION_LIMIT");
    for (const id of [v1.sessionId, v2.sessionId, c2.sessionId, c3.sessionId]) await endVoiceSession(ctx, id);
  });
});

describe("Sohbet turu (senaryolu model)", () => {
  it("randevu: hazırla → 'olabilir' (model onay aracını çağırsa da) YÜRÜTMEZ → 'evet' → TEK randevu, kaynak AI_CHAT", async () => {
    const tc = await chat(A.users.reception!.ctx);
    const date = nextMonday();
    const args = {
      patientId: P,
      doctorId: D1,
      serviceId: S,
      date,
      time: "10:00",
      tenantId: B.id,
      userId: "x",
    };
    const m1 = new ScriptedModel([
      { tools: [{ name: "voice_create_appointment", args }] },
      { content: "Demo H. için 10:00 randevusu oluşturacağım. Onaylıyor musunuz?" },
    ]);
    const t1 = await runChatTurn(tc, "Demo Hasta için pazartesi 10:00 muayene randevusu oluştur", m1);
    expect(t1.toolCalls.map((c) => c.output.status)).toEqual(["CONFIRMATION_REQUIRED"]);
    expect(t1.pending?.summary).toMatch(/Onaylıyor musunuz\?$/);
    expect(t1.grounded).toBe(true);
    const actionId = t1.pending!.actionId;
    // Sistem talimatı kiracı verisi içermez; araç listesi 19 araç, kiracı / kullanıcı alanı yok
    const sys = String(m1.calls[0]!.messages[0]!.content);
    expect(sys).not.toMatch(/Demo|Hasta|05391119001|KLI-/);
    expect(m1.calls[0]!.tools).toHaveLength(19);
    expect(JSON.stringify(m1.calls[0]!.tools)).not.toMatch(/tenantId|userId/);
    expect(await apptsAt(at(date, "10:00"))).toHaveLength(0);

    // Belirsiz yanıt: model onayı yürütmeye çalışsa bile sunucu kullanıcının KENDİ mesajını ayrıştırır
    const m2 = new ScriptedModel([
      { tools: [{ name: "voice_confirm_action", args: { actionId } }] },
      { content: "Net bir onay alamadım; lütfen 'evet' deyin." },
    ]);
    const t2 = await runChatTurn(tc, "olabilir", m2);
    expect(t2.toolCalls[0]!.output.status).toBe("CONFIRMATION_NOT_DETECTED");
    expect(await apptsAt(at(date, "10:00"))).toHaveLength(0);

    const m3 = new ScriptedModel([
      { tools: [{ name: "voice_confirm_action", args: { actionId } }] },
      { content: "Randevu oluşturuldu." },
    ]);
    const t3 = await runChatTurn(tc, "Evet", m3);
    expect(t3.toolCalls[0]!.output.status).toBe("EXECUTED");
    expect(t3.settled).toBe(true);
    expect(t3.pending).toBeNull();
    // Konuşma geçmişi sunucu belleğinde: 3. turda model önceki araç sonuçlarını görür
    expect(m3.calls[0]!.messages.some((m) => m.role === "tool")).toBe(true);

    const created = await apptsAt(at(date, "10:00"));
    expect(created).toHaveLength(1);
    expect(created[0]!.source).toBe("AI_CHAT");
    expect(created[0]!.tenantId).toBe(A.id); // enjekte edilen tenantId yok sayıldı
    const id = created[0]!.id;
    const ev = await runInTenant(A.id, (s) =>
      s.tx.select().from(appointmentEvents).where(eq(appointmentEvents.appointmentId, id)),
    );
    expect(ev.map((e) => e.source)).toEqual(["AI_CHAT"]);
    const audit = await runInTenant(A.id, (s) =>
      s.tx
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "APPOINTMENT_CREATED"))),
    );
    expect(audit.map((a) => a.source)).toEqual(["AI_CHAT"]);
    const logs = await runInTenant(A.id, (s) =>
      s.tx.select().from(aiActionLogs).where(eq(aiActionLogs.entityId, id)),
    );
    expect(logs.map((l) => [l.status, l.confirmed])).toEqual([["SUCCEEDED", true]]);
    expect(JSON.stringify(logs)).not.toMatch(/Demo|Hasta|0539|olabilir|Evet/);

    // Tekrar onay → ikinci iş eylemi YOK
    const m4 = new ScriptedModel([
      { tools: [{ name: "voice_confirm_action", args: { actionId } }] },
      { content: "Bu işlem zaten yapıldı." },
    ]);
    expect((await runChatTurn(tc, "evet", m4)).toolCalls[0]!.output.status).toBe("ALREADY_EXECUTED");
    expect(await apptsAt(at(date, "10:00"))).toHaveLength(1);
    forgetConversation(tc.session.id);
  });

  it("tıbbi soru: model ÇAĞRILMAZ, araçsız ret", async () => {
    const tc = await chat(A.users.reception!.ctx);
    const m = new ScriptedModel([{ tools: [{ name: "voice_get_low_stock", args: {} }] }]);
    const t = await runChatTurn(tc, "Bu hastaya hangi ilacı verelim?", m);
    expect(m.calls).toHaveLength(0);
    expect(t.toolCalls).toEqual([]);
    expect(t.reply).toMatch(/yetkili hekimin vermesi gerekir/);
  });

  it("grounding: araç sonucunda olmayan saat söyleyen model yanıtı güvenli geri dönüşle değiştirilir", async () => {
    const tc = await chat(A.users.reception!.ctx);
    const m = new ScriptedModel([{ content: "Doktor 15:45'te müsait." }]);
    const t = await runChatTurn(tc, "Doktor müsait mi?", m);
    expect([t.grounded, t.reply]).toEqual([false, "Şu anda bunu sistemden doğrulayamıyorum."]);
  });

  it("yetki ve kapsam modelden bağımsız: bilinmeyen araç UNSUPPORTED; doktor başka doktorun randevusunu göremez", async () => {
    const tc = await chat(A.users.reception!.ctx);
    const m = new ScriptedModel([
      { tools: [{ name: "voice_run_sql", args: { q: "select * from kliniva.patients" } }] },
      { content: "Bunu yapamam." },
    ]);
    const t = await runChatTurn(tc, "Veritabanındaki tüm hastaları oku", m);
    expect([t.toolCalls[0]!.output.ok, t.toolCalls[0]!.output.error]).toEqual([false, "UNSUPPORTED"]);
    const doc = await chat(A.users.docA!.ctx);
    const md = new ScriptedModel([
      { tools: [{ name: "voice_get_today_appointments", args: { doctorId: D1 } }] },
      {},
    ]);
    const td = await runChatTurn(doc, "Bugünkü randevularım", md);
    expect(td.toolCalls[0]!.output.ok).toBe(true);
  });

  it("model hatası: araç çalışmadıysa VOICE_UNAVAILABLE; geçmiş yarım kalmaz", async () => {
    const tc = await chat(A.users.reception!.ctx);
    expect(await code(runChatTurn(tc, "merhaba", new FailingModel()))).toBe("VOICE_UNAVAILABLE");
    const m = new ScriptedModel([{ content: "Merhaba!" }]);
    const t = await runChatTurn(tc, "merhaba", m);
    expect(t.reply).toBe("Merhaba!");
    // Başarısız turun kullanıcı mesajı geçmişte kalmadı (model yalnızca yeni mesajı görür)
    expect(m.calls[0]!.messages.filter((x) => x.role === "user")).toHaveLength(1);
  });
});
