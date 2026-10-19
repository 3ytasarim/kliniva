import "server-only";
import {
  MEDICAL_REFUSAL,
  groundingViolations,
  intentBoundary,
  parseConfirmation,
  translateVoiceError,
} from "@/server/voice/policy";
import { resolveDateExpression, resolveTime, type VoiceLanguage } from "@/server/voice/dates";
import { runVoiceTool, type VoiceToolResult } from "@/server/voice/tools";
import { setVoiceSessionLanguage, type VoiceToolContext } from "@/server/voice/session";

/**
 * Metin tabanlı sesli asistan test düzeneği + MockRealtimeTransport "modeli" (CI / E2E — gerçek mikrofon ve OpenAI
 * olmadan). DETERMİNİSTİK: Türkçe (ve basit İngilizce) komutları üretim araçlarına (runVoiceTool) çevirir ve yanıtı
 * YALNIZCA araç sonuçlarından kurar. Gerçek model yerine geçmez; amacı orkestrasyonu, araçları, onay / idempotency /
 * yetki sınırlarını ve "veri uydurmama" kuralını uçtan uca test etmektir.
 *
 * Her turdan sonra yanıt grounding kontrolünden geçer: araç sonucunda olmayan saat / sayı içeren yanıt reddedilir ve
 * "Şu anda bunu sistemden doğrulayamıyorum." ile değiştirilir.
 */
export type ToolCallTrace = { name: string; ok: boolean; output: VoiceToolResult };
export type VoiceTurnResult = {
  reply: string;
  toolCalls: ToolCallTrace[];
  /** Onay bekleyen işlem (UI onay kartı için). */
  pending: { actionId: string; summary: string } | null;
  grounded: boolean;
  language: VoiceLanguage;
};
type State = { pendingActionId: string | null; pendingSummary: string | null; language: VoiceLanguage };

const g = globalThis as unknown as { __klinivaVoiceMockState?: Map<string, State> };
const states: Map<string, State> = (g.__klinivaVoiceMockState ??= new Map());

export function resetVoiceMockState(sessionId?: string) {
  if (sessionId) states.delete(sessionId);
  else states.clear();
}

/** Model yanıtı: araç sonucuna dayanmayan operasyonel gerçek varsa güvenli geri dönüş. */
export function finalizeReply(reply: string, outputs: unknown[], lang: VoiceLanguage) {
  const violations = groundingViolations(reply, outputs);
  return violations.length
    ? { reply: translateVoiceError("TOOL_FAILED", lang), grounded: false }
    : { reply, grounded: true };
}

const lower = (s: string) => s.toLocaleLowerCase("tr-TR");

function doctorQuery(text: string): string | null {
  const m = /(?:\bdr\.?|\bdoktor|\bdoctor)\s+(.+)/i.exec(text);
  if (!m) return null;
  const stop =
    /^(bugün|bugun|yarın|yarin|cuma|cumartesi|pazar|pazartesi|salı|sali|çarşamba|carsamba|perşembe|persembe|gelecek|haftaya|saat|için|icin|ile|boş|bos|müsait|musait|\d)/i;
  const words: string[] = [];
  for (const w of m[1]!.replace(/[’'][a-zçğıöşü]+/gi, "").split(/\s+/)) {
    if (!w || stop.test(w) || words.length >= 2) break;
    words.push(w.replace(/[,.?!]/g, ""));
  }
  return words.length ? words.join(" ") : null;
}

/** Gerçek model araca kısa bir tarih ifadesi geçirir; düzenek de tümceden tarihi çözüp yalnızca onu geçirir. */
function dateArg(text: string, tc: VoiceToolContext): string {
  return resolveDateExpression(text, tc.session.timezone)?.date ?? text.slice(0, 60);
}

function patientQuery(text: string): string | null {
  const m = /([A-ZÇĞİÖŞÜa-zçğıöşü-]+(?:\s+[A-ZÇĞİÖŞÜa-zçğıöşü-]+){0,2})\s+(?:için|icin)\b/.exec(text);
  if (!m) return null;
  const words = m[1]!
    .split(/\s+/)
    .filter((w) => !/^(\d[\d:.-]*|saat|randevu|muayene|bugün|yarın|cuma|dr\.?)$/i.test(w))
    .filter((w) => /^[A-ZÇĞİÖŞÜ0-9]/.test(w) || /^KLI-/i.test(w));
  return words.length ? words.slice(-3).join(" ") : null;
}

export async function simulateVoiceTurn(tc: VoiceToolContext, utterance: string): Promise<VoiceTurnResult> {
  const state: State = states.get(tc.session.id) ?? {
    pendingActionId: null,
    pendingSummary: null,
    language: tc.session.language,
  };
  states.set(tc.session.id, state);
  const calls: ToolCallTrace[] = [];
  const turnCtx: VoiceToolContext = {
    ...tc,
    utterance,
    session: { ...tc.session, language: state.language },
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const output = await runVoiceTool(turnCtx, name, args);
    calls.push({ name, ok: output.ok !== false, output });
    return output;
  };
  const text = utterance.trim();
  const t = lower(text);
  const en = () => state.language === "en";
  let reply = "";

  const done = (r: string): VoiceTurnResult => {
    const f = finalizeReply(
      r,
      calls.map((c) => c.output),
      state.language,
    );
    return {
      reply: f.reply,
      toolCalls: calls,
      pending: state.pendingActionId
        ? { actionId: state.pendingActionId, summary: state.pendingSummary ?? "" }
        : null,
      grounded: f.grounded,
      language: state.language,
    };
  };

  // Dil
  if (/do you speak english|in english|speak english/.test(t)) {
    state.language = "en";
    await setVoiceSessionLanguage(tc.ctx, tc.session.id, "en");
    return done("Yes, I can continue in English.");
  }
  if (/türkçe (konuş|devam)|turkce (konus|devam)/.test(t)) {
    state.language = "tr";
    await setVoiceSessionLanguage(tc.ctx, tc.session.id, "tr");
    return done("Türkçe devam ediyorum.");
  }

  // Sınırlar: tıbbi karar / desteklenmeyen / talimat enjeksiyonu → araç çağrısı YOK
  const boundary = intentBoundary(text);
  if (boundary === "MEDICAL") return done(MEDICAL_REFUSAL[state.language]);
  if (boundary === "UNSUPPORTED") return done(translateVoiceError("UNSUPPORTED", state.language));

  // Onay / vazgeçme (yalnızca bekleyen işlem varsa)
  if (state.pendingActionId) {
    const verdict = parseConfirmation(text);
    if (verdict === "CONFIRM" || verdict === "REJECT") {
      const actionId = state.pendingActionId;
      if (verdict === "REJECT") {
        await call("voice_cancel_action", { actionId });
        state.pendingActionId = null;
        state.pendingSummary = null;
        return done(en() ? "Okay, I cancelled it." : "Tamam, işlemi iptal ettim.");
      }
      const out = await call("voice_confirm_action", { actionId });
      const status = String(out.status ?? "");
      if (status !== "CONFIRMATION_NOT_DETECTED") {
        // Tamamlandı / başarısız / süresi doldu: aynı eylem bir daha yürütülmez.
        if (status !== "EXECUTED" && status !== "ALREADY_EXECUTED") state.pendingSummary = null;
      }
      if (
        status === "EXECUTED" ||
        status === "FAILED" ||
        status === "CONFIRMATION_EXPIRED" ||
        status === "CANCELLED"
      ) {
        state.pendingActionId = status === "EXECUTED" ? actionId : null;
        state.pendingSummary = null;
      }
      return done(String(out.message ?? translateVoiceError("TOOL_FAILED", state.language)));
    }
    if (
      parseConfirmation(text) === "AMBIGUOUS" &&
      /^(olabilir|bakalım|bakalim|sanırım|sanirim|belki|maybe)/.test(t)
    ) {
      return done(
        en()
          ? "I need a clear yes or no to continue."
          : "Devam etmek için açık bir 'evet' veya 'hayır' duymam gerekiyor.",
      );
    }
  }

  // Bugünkü randevular
  if (/(bugün|bugun|today).*(randevu|hasta|appointment)/.test(t) && !/kaç|kac|how many/.test(t)) {
    const out = await call("voice_get_today_appointments", {});
    if (!out.ok) return done(String(out.message));
    const list = (out.appointments as { time: string; patient: string; doctor: string }[]) ?? [];
    if (!list.length) return done(en() ? "There are no appointments today." : "Bugün randevu bulunmuyor.");
    const head = en() ? `There are ${out.total} appointments today:` : `Bugün ${out.total} randevu var:`;
    return done(`${head} ${list.map((a) => `${a.time} ${a.patient}`).join(", ")}.`);
  }
  if (/(kaç|kac|how many).*(hasta|randevu|appointment|patient)/.test(t)) {
    const out = await call("voice_get_branch_summary", {});
    if (!out.ok) return done(String(out.message));
    return done(
      en()
        ? `Today there are ${out.total} appointments; ${out.waiting} checked in, ${out.inProgress} in progress, ${out.completed} completed.`
        : `Bugün ${out.total} randevu var; ${out.waiting} hasta giriş yaptı, ${out.inProgress} muayenede, ${out.completed} tamamlandı.`,
    );
  }

  // Stok / SKT
  if (/(düşük stok|dusuk stok|kritik stok|low stock)/.test(t)) {
    const out = await call("voice_get_low_stock", {});
    if (!out.ok) return done(String(out.message));
    const low = out.low as { item: string; location: string; usable: number }[];
    if (!low.length) return done(en() ? "No items are low on stock." : "Kritik seviyede ürün yok.");
    return done(
      `${en() ? "Low stock" : "Düşük stok"}: ${low.map((l) => `${l.item} · ${l.location}: ${l.usable} adet`).join("; ")}.`,
    );
  }
  if (/(son kullanma|skt|expir)/.test(t)) {
    const days = Number(/(\d{1,3})\s*(gün|gun|day)/.exec(t)?.[1] ?? 0) || undefined;
    const out = await call("voice_get_expiring_lots", { days });
    if (!out.ok) return done(String(out.message));
    const lots = out.lots as { item: string; lot: string; expiryLabel: string; location: string }[];
    if (!lots.length)
      return done(en() ? "No lots expire in that period." : "Bu sürede SKT'si dolacak lot yok.");
    return done(
      lots.map((l) => `${l.item}, lot ${l.lot}, SKT ${l.expiryLabel}, ${l.location}`).join("; ") + ".",
    );
  }
  const stockQ =
    /([a-zçğıöşü0-9 ]+?)\s+(stoğu|stogu|stok)\s+(ne kadar|kaç|kac)/.exec(t) ??
    /(kaç|kac)\s+([a-zçğıöşü0-9 ]+?)\s+kaldı/.exec(t);
  if (stockQ) {
    const query = (stockQ[1]!.match(/[a-zçğıöşü]/) ? stockQ[1]! : stockQ[2]!)
      .trim()
      .split(" ")
      .slice(-2)
      .join(" ");
    const out = await call("voice_get_inventory", { query });
    if (!out.ok) return done(String(out.message));
    const rows = out.stock as { item: string; location: string; usable: number; unit: string }[];
    if (!rows.length) return done(en() ? "I couldn't find that item." : "Bu ürünü bulamadım.");
    return done(rows.map((r) => `${r.location}: ${r.usable} adet ${r.item}`).join("; ") + ".");
  }

  // Randevu oluşturma
  if (/randevu(su)?\s+(oluştur|olustur|ayarla|ver|aç|ac)|book an appointment/.test(t)) {
    const pq = patientQuery(text);
    const dq = doctorQuery(text);
    const time = resolveTime(/\b(\d{1,2}[:.]\d{2})\b/.exec(text)?.[1] ?? "");
    if (!pq) return done(en() ? "Which patient is this for?" : "Hangi hasta için?");
    if (!dq) return done(en() ? "Which doctor?" : "Hangi doktor?");
    if (!time) return done(en() ? "What time?" : "Saat kaçta?");
    const pts = await call("voice_find_patient", { query: pq });
    if (!pts.ok) return done(String(pts.message));
    const patients = pts.patients as { patientId: string; patientNumber: string; displayName: string }[];
    if (!patients.length) return done(en() ? "I couldn't find that patient." : "Bu isimde hasta bulamadım.");
    if (patients.length > 1) {
      return done(
        en()
          ? `I found ${patients.length} patients: ${patients.map((p) => p.patientNumber).join(", ")}. Which one should I use?`
          : `${pq} adına ${patients.length} hasta kaydı buldum: ${patients.map((p) => p.patientNumber).join(", ")}. Hangisini kullanmalıyım?`,
      );
    }
    const docs = await call("voice_list_doctors", { name: dq });
    if (!docs.ok) return done(String(docs.message));
    const doctors = docs.doctors as { doctorId: string; name: string }[];
    if (!doctors.length) return done(en() ? "I couldn't find that doctor." : "Bu doktoru bulamadım.");
    if (doctors.length > 1)
      return done(
        en()
          ? "Which doctor exactly?"
          : `Birden fazla doktor buldum: ${doctors.map((d) => d.name).join(", ")}. Hangisi?`,
      );
    const svcs = await call("voice_list_services", {});
    const services = (svcs.services as { serviceId: string; name: string }[]) ?? [];
    const svc = services.find((s) => t.includes(lower(s.name)));
    if (!svc)
      return done(
        en()
          ? "Which service should I book?"
          : `Hangi hizmet için? ${services.map((s) => s.name).join(", ")}.`,
      );
    const out = await call("voice_create_appointment", {
      patientId: patients[0]!.patientId,
      doctorId: doctors[0]!.doctorId,
      serviceId: svc.serviceId,
      date: dateArg(text, tc),
      time,
    });
    if (!out.ok) {
      const alt = (out.alternatives as string[] | undefined)?.length
        ? en()
          ? ` Available times: ${(out.alternatives as string[]).join(", ")}.`
          : ` Müsait saatler: ${(out.alternatives as string[]).join(", ")}.`
        : "";
      return done(`${String(out.message ?? "")}${alt}`.trim());
    }
    if (out.status === "CONFIRMATION_REQUIRED") {
      state.pendingActionId = String(out.actionId);
      state.pendingSummary = String(out.summary);
      return done(String(out.summary));
    }
    return done(String(out.message ?? ""));
  }

  // Müsaitlik
  if (/(boş|bos|müsait|musait|available|free)/.test(t)) {
    const dq = doctorQuery(text);
    if (!dq) return done(en() ? "Which doctor?" : "Hangi doktor?");
    const docs = await call("voice_list_doctors", { name: dq });
    const doctors = (docs.doctors as { doctorId: string; name: string }[]) ?? [];
    if (!docs.ok) return done(String(docs.message));
    if (!doctors.length) return done(en() ? "I couldn't find that doctor." : "Bu doktoru bulamadım.");
    const part = /(öğleden sonra|ogleden sonra|afternoon|sabah|morning|akşam|aksam|evening)/.exec(t)?.[1];
    const out = await call("voice_get_doctor_availability", {
      doctorId: doctors[0]!.doctorId,
      date: dateArg(text, tc),
      partOfDay: part,
    });
    if (!out.ok) return done(String(out.message));
    const times = (out.availableTimes as string[]) ?? [];
    if (!times.length) {
      return done(
        en()
          ? `${out.doctor} has no free time on ${out.dateLabel}.`
          : `${out.doctor} ${out.dateLabel} günü müsait değil.`,
      );
    }
    return done(
      en()
        ? `${out.doctor} is available on ${out.dateLabel} at ${times.join(", ")}.`
        : `${out.doctor} ${out.dateLabel} günü ${out.branch} şubesinde ${times.join(", ")} saatlerinde müsait.`,
    );
  }

  reply = en()
    ? "I didn't understand. You can ask about appointments, availability or stock."
    : "Bunu anlayamadım. Randevu, müsaitlik veya stok hakkında sorabilirsiniz.";
  return done(reply);
}
