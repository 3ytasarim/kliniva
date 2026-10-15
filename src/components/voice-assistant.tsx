"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceMockTurn, VoiceSessionStartResponse, VoiceToolOutput, VoiceUiState } from "@/types/voice";

/**
 * Kliniva AI sesli asistan paneli (sağ alt). Mikrofon YALNIZCA kullanıcı "Başlat"a bastığında istenir; açık / kapalı
 * durum her zaman görünür. Tarayıcı ana API anahtarını hiç görmez: sunucudan kısa ömürlü istemci sırrı alır ve
 * OpenAI Realtime'a doğrudan WebRTC ile bağlanır. Modelin her işlev çağrısı Kliniva sunucusuna iletilir (yetki /
 * kapsam / onay sunucuda). Döküm yalnızca ekranda tutulur ve panel kapanınca silinir (sunucuda saklanmaz).
 * Sahte taşıyıcıda (CI / E2E) mikrofon yerine metin kutusu kullanılır.
 */
type Line = { who: "user" | "assistant" | "system"; text: string };
type Card = { id: string; text: string; ok: boolean };
type Pending = { actionId: string; summary: string };

const SETTLED = new Set(["EXECUTED", "ALREADY_EXECUTED", "FAILED", "CONFIRMATION_EXPIRED", "CANCELLED"]);

const STATE_LABEL: Record<VoiceUiState, string> = {
  idle: "Kapalı",
  connecting: "Bağlanıyor…",
  listening: "Dinliyor",
  thinking: "Düşünüyor…",
  speaking: "Konuşuyor",
  tool: "Sistemden kontrol ediliyor…",
  confirm: "Onay bekleniyor",
  error: "Hata",
};

const TOOL_LABEL: Record<string, string> = {
  voice_get_doctor_availability: "Doktor müsaitliği kontrol ediliyor",
  voice_get_today_appointments: "Bugünkü randevular getiriliyor",
  voice_get_branch_summary: "Günlük özet getiriliyor",
  voice_list_doctors: "Doktor aranıyor",
  voice_list_branches: "Şubeler getiriliyor",
  voice_list_services: "Hizmetler getiriliyor",
  voice_find_patient: "Hasta aranıyor",
  voice_get_appointment: "Randevu getiriliyor",
  voice_get_inventory: "Stok kontrol ediliyor",
  voice_get_low_stock: "Kritik stok kontrol ediliyor",
  voice_get_expiring_lots: "SKT kontrol ediliyor",
  voice_resolve_date: "Tarih çözülüyor",
  voice_create_appointment: "Randevu hazırlanıyor",
  voice_reschedule_appointment: "Randevu taşıma hazırlanıyor",
  voice_cancel_appointment: "Randevu iptali hazırlanıyor",
  voice_confirm_appointment: "Randevu onayı hazırlanıyor",
  voice_create_material_usage_draft: "Malzeme taslağı hazırlanıyor",
  voice_confirm_action: "İşlem yürütülüyor",
  voice_cancel_action: "İşlem iptal ediliyor",
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string; message?: string };
  };
  if (!res.ok) throw new Error(json.error?.message ?? "Sesli asistan şu anda kullanılamıyor.");
  return json.data as T;
}

export function VoiceAssistant() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<VoiceUiState>("idle");
  const [lines, setLines] = useState<Line[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [mock, setMock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const session = useRef<VoiceSessionStartResponse | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const lastUtterance = useRef<string>("");
  const pendingTools = useRef(0);

  const say = useCallback((who: Line["who"], text: string) => {
    if (!text.trim()) return;
    setLines((l) => [...l.slice(-30), { who, text }]);
  }, []);
  const card = useCallback((name: string, out: VoiceToolOutput) => {
    const label =
      out.status === "CONFIRMATION_REQUIRED"
        ? "İşlem onaya hazır"
        : out.status === "EXECUTED"
          ? "İşlem tamamlandı"
          : `${TOOL_LABEL[name] ?? "Sistem sorgusu"}${out.ok === false ? " — yapılamadı" : ""}`;
    setCards((c) => [
      ...c.slice(-6),
      { id: `${Date.now()}-${Math.random()}`, text: label, ok: out.ok !== false },
    ]);
    if (out.status === "CONFIRMATION_REQUIRED" && out.actionId) {
      setPending({ actionId: out.actionId, summary: String(out.summary ?? "") });
      setState("confirm");
    }
    if (
      ["EXECUTED", "ALREADY_EXECUTED", "FAILED", "CANCELLED", "CONFIRMATION_EXPIRED"].includes(
        String(out.status),
      )
    ) {
      setPending(null);
    }
  }, []);

  const teardown = useCallback(() => {
    try {
      dc.current?.close();
    } catch {
      /* yok say */
    }
    pc.current?.getSenders().forEach((s) => s.track?.stop());
    pc.current?.close();
    mic.current?.getTracks().forEach((t) => t.stop());
    if (audio.current) audio.current.srcObject = null;
    pc.current = null;
    dc.current = null;
    mic.current = null;
  }, []);

  const stop = useCallback(async () => {
    const s = session.current;
    session.current = null;
    teardown();
    setState("idle");
    setPending(null);
    setMock(false);
    // Ekrandaki döküm kapanışta temizlenir (kalıcı kayıt yok).
    setLines([]);
    setCards([]);
    if (s) await post(`/api/v1/voice/session/${s.sessionId}/end`, {}).catch(() => undefined);
  }, [teardown]);

  useEffect(() => () => void stop(), [stop]);

  const sendEvent = (event: Record<string, unknown>) => {
    if (dc.current?.readyState === "open") dc.current.send(JSON.stringify(event));
  };

  const runTool = useCallback(
    async (name: string, args: string, callId: string) => {
      const s = session.current;
      if (!s) return;
      pendingTools.current += 1;
      setState("tool");
      let out: VoiceToolOutput;
      try {
        out = await post<VoiceToolOutput>("/api/v1/voice/tools", {
          sessionId: s.sessionId,
          name,
          arguments: args,
          utterance: lastUtterance.current,
        });
      } catch {
        out = { ok: false, error: "TOOL_FAILED", message: "Şu anda bunu sistemden doğrulayamıyorum." };
      }
      card(name, out);
      sendEvent({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: JSON.stringify(out).slice(0, 8000) },
      });
      pendingTools.current -= 1;
      if (!pendingTools.current) sendEvent({ type: "response.create" });
    },
    [card],
  );

  const onRealtimeEvent = useCallback(
    (e: Record<string, unknown>) => {
      switch (e.type) {
        case "input_audio_buffer.speech_started":
          setState("listening");
          break;
        case "input_audio_buffer.speech_stopped":
          setState("thinking");
          break;
        case "conversation.item.input_audio_transcription.completed": {
          const t = String(e.transcript ?? "").trim();
          if (t) {
            lastUtterance.current = t;
            say("user", t);
          }
          break;
        }
        case "output_audio_buffer.started":
          setState("speaking");
          break;
        case "output_audio_buffer.stopped":
        case "output_audio_buffer.cleared":
          if (!pendingTools.current) setState(pending ? "confirm" : "listening");
          break;
        case "response.output_audio_transcript.done":
          say("assistant", String(e.transcript ?? ""));
          break;
        case "response.function_call_arguments.done":
          void runTool(String(e.name ?? ""), String(e.arguments ?? "{}"), String(e.call_id ?? ""));
          break;
        case "error": {
          const err = e.error as { code?: string } | undefined;
          if (err?.code === "response_cancel_not_active") break;
          setError("Sesli bağlantıda bir sorun oluştu.");
          break;
        }
      }
    },
    [pending, runTool, say],
  );

  const start = useCallback(async () => {
    setError(null);
    setState("connecting");
    try {
      const s = await post<VoiceSessionStartResponse>("/api/v1/voice/session", {});
      session.current = s;
      if (s.transport === "mock") {
        setMock(true);
        setState("listening");
        say("system", "Test modu: komutu yazarak deneyin.");
        return;
      }
      // Mikrofon izni yalnızca bu açık kullanıcı eyleminde istenir.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      mic.current = stream;
      const peer = new RTCPeerConnection();
      pc.current = peer;
      audio.current ??= new Audio();
      audio.current.autoplay = true;
      peer.ontrack = (ev) => {
        if (audio.current) audio.current.srcObject = ev.streams[0] ?? null;
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
          setState("error");
          setError("Bağlantı koptu. Yeniden bağlanabilirsiniz; bekleyen işlemler yeniden onay ister.");
        }
      };
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
      const channel = peer.createDataChannel("oai-events");
      dc.current = channel;
      channel.onmessage = (m) => {
        try {
          onRealtimeEvent(JSON.parse(String(m.data)) as Record<string, unknown>);
        } catch {
          /* bozuk olay yok sayılır */
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const res = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${s.clientSecret}`, "Content-Type": "application/sdp" },
      });
      if (!res.ok) throw new Error("Sesli bağlantı kurulamadı.");
      await peer.setRemoteDescription({ type: "answer", sdp: await res.text() });
      setState("listening");
    } catch (e) {
      teardown();
      session.current = null;
      setState("error");
      setError(e instanceof Error ? e.message : "Sesli asistan başlatılamadı.");
    }
  }, [onRealtimeEvent, say, teardown]);

  const sendMock = useCallback(
    async (text: string) => {
      const s = session.current;
      if (!s || !text.trim()) return;
      say("user", text);
      setDraft("");
      setState("thinking");
      try {
        const turn = await post<VoiceMockTurn>("/api/v1/voice/mock-turn", { sessionId: s.sessionId, text });
        for (const c of turn.toolCalls) card(c.name, c.output);
        say("assistant", turn.reply);
        // Eylem sonuçlandıysa (yürütüldü / zaten yürütülmüş / başarısız / süresi doldu / iptal) onay kartı kapanır.
        const settled = turn.toolCalls.some((c) => SETTLED.has(String(c.output.status)));
        const open = turn.pending && !settled ? turn.pending : null;
        setPending(open);
        setState(open ? "confirm" : "listening");
      } catch (e) {
        setState("error");
        setError(e instanceof Error ? e.message : "Şu anda bunu sistemden doğrulayamıyorum.");
      }
    },
    [card, say],
  );

  const decide = useCallback(
    async (kind: "confirm" | "cancel") => {
      const s = session.current;
      if (!s || !pending) return;
      setState("tool");
      try {
        const out = await post<VoiceToolOutput>(`/api/v1/voice/actions/${pending.actionId}/${kind}`, {
          sessionId: s.sessionId,
        });
        card(kind === "confirm" ? "voice_confirm_action" : "voice_cancel_action", out);
        const msg = kind === "cancel" ? "İşlem iptal edildi." : String(out.message ?? "");
        say("assistant", msg);
        setPending(null);
        // Modele ekrandan verilen kararı bildir (gerçek oturumda).
        sendEvent({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `[Ekrandan ${kind === "confirm" ? "onaylandı" : "iptal edildi"}: ${msg}]`,
              },
            ],
          },
        });
        setState("listening");
      } catch (e) {
        setState("error");
        setError(e instanceof Error ? e.message : "İşlem yapılamadı.");
      }
    },
    [card, pending, say],
  );

  const active = state !== "idle" && state !== "error";
  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      {open ? (
        <section
          aria-label="Kliniva AI sesli asistan"
          className="w-[22rem] max-w-[calc(100vw-2rem)] rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-700">
            <div>
              <p className="text-sm font-semibold">Kliniva AI</p>
              <p className="text-xs text-slate-500">Klinik operasyon asistanı</p>
            </div>
            <span
              role="status"
              data-testid="voice-status"
              className={`badge ${active ? "badge-green" : state === "error" ? "badge-red" : "badge-gray"}`}
            >
              {active ? "● " : ""}
              {STATE_LABEL[state]}
            </span>
          </header>
          <div
            className="grid max-h-80 gap-2 overflow-y-auto px-4 py-3 text-sm"
            aria-live="polite"
            data-testid="voice-transcript"
          >
            {lines.length === 0 ? (
              <p className="text-slate-500">
                Randevu, doktor müsaitliği veya stok hakkında sorun. Tanı / tedavi önerisi verilmez.
              </p>
            ) : null}
            {lines.map((l, i) => (
              <p
                key={i}
                data-testid="voice-line"
                data-who={l.who}
                className={
                  l.who === "user"
                    ? "ml-8 rounded-xl bg-brand-50 px-3 py-2 dark:bg-brand-900"
                    : l.who === "system"
                      ? "text-xs text-slate-500"
                      : "mr-8 rounded-xl bg-slate-100 px-3 py-2 dark:bg-slate-800"
                }
              >
                {l.text}
              </p>
            ))}
            {cards.length ? (
              <ul className="grid gap-1" aria-label="Sistem işlemleri">
                {cards.map((c) => (
                  <li
                    key={c.id}
                    data-testid="voice-tool-card"
                    className={`text-xs ${c.ok ? "text-slate-600 dark:text-slate-300" : "text-red-700 dark:text-red-400"}`}
                  >
                    {c.ok ? "✓" : "!"} {c.text}
                  </li>
                ))}
              </ul>
            ) : null}
            {pending ? (
              <div
                role="alertdialog"
                aria-label="Onay gerekli"
                data-testid="voice-confirm-card"
                className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950"
              >
                <p className="text-sm">{pending.summary}</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="btn btn-sm" onClick={() => void decide("confirm")}>
                    Onayla
                  </button>
                  <button type="button" className="btn-ghost btn-sm" onClick={() => void decide("cancel")}>
                    İptal
                  </button>
                </div>
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-xs text-red-700 dark:text-red-400">
                {error}
              </p>
            ) : null}
          </div>
          {mock && active ? (
            <form
              className="flex gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-700"
              onSubmit={(e) => {
                e.preventDefault();
                void sendMock(draft);
              }}
            >
              <label htmlFor="voice-text" className="sr-only">
                Komut
              </label>
              <input
                id="voice-text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="input"
                placeholder="Komut yazın"
                maxLength={500}
              />
              <button type="submit" className="btn btn-sm">
                Gönder
              </button>
            </form>
          ) : null}
          <footer className="flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-3 dark:border-slate-700">
            {active ? (
              <button type="button" className="btn-danger" onClick={() => void stop()}>
                Mikrofonu kapat
              </button>
            ) : (
              <button type="button" className="btn btn-sm" onClick={() => void start()}>
                {state === "error" ? "Yeniden bağlan" : "Başlat"}
              </button>
            )}
            <p className="text-right text-xs text-slate-500">Ses ve döküm kaydedilmez.</p>
          </footer>
        </section>
      ) : null}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Kliniva AI panelini gizle" : "Kliniva AI sesli asistanı aç"}
        className={`grid size-14 place-items-center rounded-full text-white shadow-lg ${active ? "bg-red-600" : "bg-brand-600 hover:bg-brand-700"}`}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-7">
          <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />
        </svg>
      </button>
    </div>
  );
}
