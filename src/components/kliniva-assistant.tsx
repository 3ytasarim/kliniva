"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  MessageSquareText,
  Mic,
  MicOff,
  RotateCcw,
  SendHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type {
  ChatSessionStartResponse,
  ChatTurnResponse,
  VoiceMockTurn,
  VoiceSessionStartResponse,
  VoiceToolOutput,
  VoiceUiState,
} from "@/types/voice";

/**
 * KLINIVA AI ASİSTAN PANELİ (sağ alt) — iki kanal, tek araç / onay katmanı:
 *  - Yazışma: mesaj sunucuya gider (/api/v1/assistant/chat); model + araçlar SUNUCUDA çalışır. Tarayıcı hiçbir sır görmez.
 *  - Sesli: OpenAI Realtime (WebRTC) — sunucudan kısa ömürlü istemci sırrı; mikrofon YALNIZCA "Başlat" ile istenir.
 * Her iki kanalda yazma işlemleri önce ÖZET + açık onay ister (yazarak "evet" veya "Onayla" düğmesi). Döküm yalnızca
 * ekranda tutulur; panel / sohbet kapanınca silinir (sunucuda saklanmaz). İki sekme de bağlı kalır (sekme değişince
 * sesli oturum kopmaz).
 */
type Pending = { actionId: string; summary: string };
const SETTLED = new Set(["EXECUTED", "ALREADY_EXECUTED", "FAILED", "CONFIRMATION_EXPIRED", "CANCELLED"]);

const TOOL_LABEL: Record<string, string> = {
  voice_get_doctor_availability: "Doktor müsaitliği kontrol edildi",
  voice_get_today_appointments: "Bugünkü randevular getirildi",
  voice_get_branch_summary: "Günlük özet getirildi",
  voice_list_doctors: "Doktor arandı",
  voice_list_branches: "Şubeler getirildi",
  voice_list_services: "Hizmetler getirildi",
  voice_find_patient: "Hasta arandı",
  voice_get_appointment: "Randevu getirildi",
  voice_get_inventory: "Stok kontrol edildi",
  voice_get_low_stock: "Kritik stok kontrol edildi",
  voice_get_expiring_lots: "SKT kontrol edildi",
  voice_resolve_date: "Tarih çözüldü",
  voice_create_appointment: "Randevu hazırlandı",
  voice_reschedule_appointment: "Taşıma hazırlandı",
  voice_cancel_appointment: "İptal hazırlandı",
  voice_confirm_appointment: "Onay hazırlandı",
  voice_create_material_usage_draft: "Malzeme taslağı hazırlandı",
  voice_confirm_action: "İşlem yürütüldü",
  voice_cancel_action: "İşlem iptal edildi",
};

function toolChip(name: string, out: VoiceToolOutput) {
  const text =
    out.status === "CONFIRMATION_REQUIRED"
      ? "İşlem onaya hazır"
      : out.status === "EXECUTED"
        ? "İşlem tamamlandı"
        : `${TOOL_LABEL[name] ?? "Sistem sorgusu"}${out.ok === false ? " — yapılamadı" : ""}`;
  return { text, ok: out.ok !== false };
}

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
  if (!res.ok) {
    const err = new Error(json.error?.message ?? "Asistan şu anda kullanılamıyor.");
    (err as Error & { code?: string }).code = json.error?.code;
    throw err;
  }
  return json.data as T;
}

function ConfirmCard({
  pending,
  onDecide,
  busy,
  testId,
}: {
  pending: Pending;
  onDecide: (kind: "confirm" | "cancel") => void;
  busy: boolean;
  testId: string;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Onay gerekli"
      data-testid={testId}
      className="animate-enter rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10"
    >
      <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        <CircleAlert className="size-3.5" />
        Onayınız gerekiyor
      </p>
      <p className="text-sm leading-relaxed text-amber-950 dark:text-amber-50">{pending.summary}</p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => onDecide("confirm")} disabled={busy}>
          <Check />
          Onayla
        </Button>
        <Button size="sm" variant="outline" onClick={() => onDecide("cancel")} disabled={busy}>
          İptal
        </Button>
      </div>
    </div>
  );
}

// ================================================================ yazılı sohbet

type ChatLine = {
  id: number;
  who: "user" | "assistant" | "system";
  text: string;
  tools?: { text: string; ok: boolean }[];
};

const SUGGESTIONS = ["Bugün hangi hastalarım var?", "Kritik stokta ne var?", "SKT'si yaklaşan ürün var mı?"];

function ChatPanel({ active }: { active: boolean }) {
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const session = useRef<string | null>(null);
  const seq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const push = useCallback((l: Omit<ChatLine, "id">) => {
    seq.current += 1;
    const id = seq.current;
    setLines((xs) => [...xs.slice(-60), { ...l, id }]);
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [lines, busy, pending]);
  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);

  const endSession = useCallback(async () => {
    const sid = session.current;
    session.current = null;
    if (sid) await post(`/api/v1/voice/session/${sid}/end`, {}).catch(() => undefined);
  }, []);
  useEffect(() => () => void endSession(), [endSession]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      setError(null);
      setDraft("");
      push({ who: "user", text });
      setBusy(true);
      try {
        if (!session.current) {
          session.current = (await post<ChatSessionStartResponse>("/api/v1/assistant/session", {})).sessionId;
        }
        const turn = await post<ChatTurnResponse>("/api/v1/assistant/chat", {
          sessionId: session.current,
          message: text,
        });
        push({
          who: "assistant",
          text: turn.reply,
          tools: turn.toolCalls.map((c) => toolChip(c.name, c.output)),
        });
        const settled = turn.settled || turn.toolCalls.some((c) => SETTLED.has(String(c.output.status)));
        if (turn.pending) setPending(turn.pending);
        else if (settled) setPending(null);
      } catch (e) {
        // Oturum düştüyse (süre doldu / kapatıldı) bir sonraki mesaj yeni oturum açar.
        if ((e as { code?: string }).code === "NOT_FOUND") session.current = null;
        setError(e instanceof Error ? e.message : "Şu anda yanıt veremiyorum.");
      } finally {
        setBusy(false);
      }
    },
    [busy, push],
  );

  const decide = useCallback(
    async (kind: "confirm" | "cancel") => {
      const sid = session.current;
      if (!sid || !pending) return;
      setBusy(true);
      try {
        const out = await post<VoiceToolOutput>(`/api/v1/voice/actions/${pending.actionId}/${kind}`, {
          sessionId: sid,
        });
        push({
          who: "assistant",
          text: kind === "cancel" ? "İşlem iptal edildi." : String(out.message ?? ""),
          tools: [toolChip(kind === "confirm" ? "voice_confirm_action" : "voice_cancel_action", out)],
        });
        setPending(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "İşlem yapılamadı.");
      } finally {
        setBusy(false);
      }
    },
    [pending, push],
  );

  const reset = useCallback(async () => {
    await endSession();
    setLines([]);
    setPending(null);
    setError(null);
  }, [endSession]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        aria-live="polite"
        data-testid="chat-transcript"
      >
        {lines.length === 0 ? (
          <div className="grid gap-3 pt-2">
            <div className="flex items-start gap-2.5">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-600 text-white">
                <Sparkles className="size-3.5" />
              </span>
              <p className="rounded-2xl rounded-tl-sm bg-slate-100 px-3 py-2 text-sm leading-relaxed dark:bg-white/5">
                Merhaba! Randevu, doktor müsaitliği ve stok hakkında yardımcı olabilirim. Randevu oluşturma,
                taşıma ve iptal işlemlerini önce özetler, onayınızla yaparım.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 pl-9">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="rounded-full border border-line bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:border-brand-300 hover:bg-brand-50 hover:text-brand-800 focus-visible:outline-none focus-visible:shadow-focus dark:border-line-dark dark:bg-surface-dark dark:text-slate-300 dark:hover:bg-brand-500/10"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {lines.map((l) =>
          l.who === "user" ? (
            <div key={l.id} className="flex justify-end" data-testid="chat-line" data-who="user">
              <p className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-tr-sm bg-brand-600 px-3 py-2 text-sm text-white">
                {l.text}
              </p>
            </div>
          ) : (
            <div key={l.id} className="flex items-start gap-2.5" data-testid="chat-line" data-who={l.who}>
              <span
                className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-600 text-white"
                aria-hidden="true"
              >
                <Sparkles className="size-3.5" />
              </span>
              <div className="min-w-0 max-w-[85%]">
                {l.tools?.length ? (
                  <ul className="mb-1.5 flex flex-wrap gap-1" aria-label="Sistem işlemleri">
                    {l.tools.map((t, i) => (
                      <li
                        key={i}
                        data-testid="chat-tool"
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                          t.ok
                            ? "bg-slate-100 text-slate-600 dark:bg-white/5 dark:text-slate-300"
                            : "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300",
                        )}
                      >
                        {t.ok ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
                        {t.text}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="whitespace-pre-line rounded-2xl rounded-tl-sm bg-slate-100 px-3 py-2 text-sm leading-relaxed dark:bg-white/5">
                  <span className="sr-only">Kliniva AI (yapay zekâ): </span>
                  <span data-testid="chat-text">{l.text}</span>
                </p>
              </div>
            </div>
          ),
        )}
        {busy ? (
          <div className="flex items-center gap-2.5" aria-label="Yanıt hazırlanıyor">
            <span
              className="grid size-7 place-items-center rounded-full bg-brand-600 text-white"
              aria-hidden="true"
            >
              <Sparkles className="size-3.5" />
            </span>
            <span className="flex gap-1 rounded-2xl rounded-tl-sm bg-slate-100 px-3 py-3 dark:bg-white/5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className={cn(
                    "size-1.5 animate-bounce rounded-full bg-slate-400",
                    i === 1 && "[animation-delay:120ms]",
                    i === 2 && "[animation-delay:240ms]",
                  )}
                />
              ))}
            </span>
          </div>
        ) : null}
        {pending ? (
          <ConfirmCard
            pending={pending}
            onDecide={(k) => void decide(k)}
            busy={busy}
            testId="chat-confirm-card"
          />
        ) : null}
        {error ? (
          <p role="alert" className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400">
            <CircleAlert className="size-3.5" />
            {error}
          </p>
        ) : null}
      </div>
      <form
        className="border-t border-line p-3 dark:border-line-dark"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-line bg-white p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-brand-500 focus-within:shadow-focus dark:border-line-dark dark:bg-surface-dark">
          <label htmlFor="assistant-input" className="sr-only">
            Mesaj
          </label>
          <textarea
            ref={input}
            id="assistant-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
            rows={1}
            maxLength={1000}
            placeholder="Bir şey sorun veya randevu oluşturun…"
            className="max-h-28 min-h-9 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-slate-400"
          />
          <Button type="submit" size="icon-sm" disabled={busy || !draft.trim()} aria-label="Gönder">
            <SendHorizontal />
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span>Yapay zekâ yanıtıdır · değişiklikler yalnızca onayınızla yapılır.</span>
          {lines.length ? (
            <button
              type="button"
              onClick={() => void reset()}
              className="inline-flex items-center gap-1 rounded font-medium text-slate-500 hover:text-slate-900 focus-visible:outline-none focus-visible:shadow-focus dark:hover:text-white"
            >
              <RotateCcw className="size-3" />
              Yeni sohbet
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

// ================================================================ sesli (OpenAI Realtime / WebRTC)

type Line = { who: "user" | "assistant" | "system"; text: string };
type Card = { id: string; text: string; ok: boolean };

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

function VoicePanel({ onLiveChange }: { onLiveChange: (live: boolean) => void }) {
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

  const active = state !== "idle" && state !== "error";
  useEffect(() => onLiveChange(active), [active, onLiveChange]);

  const say = useCallback((who: Line["who"], text: string) => {
    if (!text.trim()) return;
    setLines((l) => [...l.slice(-30), { who, text }]);
  }, []);
  const card = useCallback((name: string, out: VoiceToolOutput) => {
    const chip = toolChip(name, out);
    setCards((c) => [...c.slice(-6), { id: `${Date.now()}-${Math.random()}`, ...chip }]);
    if (out.status === "CONFIRMATION_REQUIRED" && out.actionId) {
      setPending({ actionId: out.actionId, summary: String(out.summary ?? "") });
      setState("confirm");
    }
    if (SETTLED.has(String(out.status))) setPending(null);
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 dark:border-line-dark">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "relative grid size-9 place-items-center rounded-full",
              active
                ? "bg-red-50 text-red-600 dark:bg-red-500/10"
                : "bg-slate-100 text-slate-500 dark:bg-white/5",
            )}
          >
            {active ? (
              <span className="absolute inset-0 animate-ping rounded-full bg-red-400/30" aria-hidden="true" />
            ) : null}
            {active ? <Mic className="size-4" /> : <MicOff className="size-4" />}
          </span>
          <div>
            <p className="text-sm font-medium">{active ? "Mikrofon açık" : "Mikrofon kapalı"}</p>
            <p
              role="status"
              data-testid="voice-status"
              className="text-xs text-slate-500 dark:text-slate-400"
            >
              {active ? "● " : ""}
              {STATE_LABEL[state]}
            </p>
          </div>
        </div>
        {active ? (
          <Button variant="destructive" size="sm" onClick={() => void stop()}>
            Mikrofonu kapat
          </Button>
        ) : (
          <Button size="sm" onClick={() => void start()}>
            <Mic />
            {state === "error" ? "Yeniden bağlan" : "Başlat"}
          </Button>
        )}
      </div>
      <div
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3 text-sm"
        aria-live="polite"
        data-testid="voice-transcript"
      >
        {lines.length === 0 ? (
          <p className="text-slate-500 dark:text-slate-400">
            &quot;Başlat&quot;a basıp konuşun: randevu, doktor müsaitliği veya stok sorabilirsiniz. Tanı /
            tedavi önerisi verilmez.
          </p>
        ) : null}
        {lines.map((l, i) => (
          <p
            key={i}
            data-testid="voice-line"
            data-who={l.who}
            className={
              l.who === "user"
                ? "ml-8 rounded-2xl rounded-tr-sm bg-brand-600 px-3 py-2 text-white"
                : l.who === "system"
                  ? "text-xs text-slate-500"
                  : "mr-8 rounded-2xl rounded-tl-sm bg-slate-100 px-3 py-2 dark:bg-white/5"
            }
          >
            {l.text}
          </p>
        ))}
        {cards.length ? (
          <ul className="flex flex-wrap gap-1" aria-label="Sistem işlemleri">
            {cards.map((c) => (
              <li
                key={c.id}
                data-testid="voice-tool-card"
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  c.ok
                    ? "bg-slate-100 text-slate-600 dark:bg-white/5 dark:text-slate-300"
                    : "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300",
                )}
              >
                {c.ok ? <Check className="size-3" /> : <CircleAlert className="size-3" />}
                {c.text}
              </li>
            ))}
          </ul>
        ) : null}
        {pending ? (
          <ConfirmCard
            pending={pending}
            onDecide={(k) => void decide(k)}
            busy={state === "tool"}
            testId="voice-confirm-card"
          />
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-red-700 dark:text-red-400">
            {error}
          </p>
        ) : null}
      </div>
      {mock && active ? (
        <form
          className="flex gap-2 border-t border-line px-4 py-3 dark:border-line-dark"
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
          <Button type="submit" size="sm" className="h-auto">
            Gönder
          </Button>
        </form>
      ) : (
        <p className="border-t border-line px-4 py-2.5 text-[11px] text-slate-400 dark:border-line-dark">
          Ses ve döküm kaydedilmez · mikrofon yalnızca &quot;Başlat&quot; ile açılır.
        </p>
      )}
    </div>
  );
}

// ================================================================ panel + başlatıcı

export function KlinivaAssistant() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"chat" | "voice">("chat");
  const [voiceLive, setVoiceLive] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-3">
      <section
        aria-label="Kliniva AI asistanı"
        hidden={!open}
        className="animate-enter flex h-[min(620px,calc(100dvh-6.5rem))] w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-white shadow-raised dark:border-line-dark dark:bg-raised-dark"
      >
        <header className="flex items-center gap-3 border-b border-line bg-gradient-to-br from-brand-50 to-white px-4 py-3 dark:border-line-dark dark:from-brand-500/10 dark:to-raised-dark">
          <span className="grid size-9 place-items-center rounded-xl bg-brand-600 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2)]">
            <Sparkles className="size-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Kliniva AI</p>
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">Randevu ve muayene asistanı</p>
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Paneli kapat">
            <X />
          </Button>
        </header>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "chat" | "voice")}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="border-b border-line px-4 py-2 dark:border-line-dark">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="chat">
                <MessageSquareText />
                Yazışma
              </TabsTrigger>
              <TabsTrigger value="voice">
                <Mic />
                Sesli
                {voiceLive ? <span className="size-1.5 rounded-full bg-red-500" aria-label="açık" /> : null}
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="chat" className="min-h-0 flex-1 data-[state=inactive]:hidden">
            <ChatPanel active={open && tab === "chat"} />
          </TabsContent>
          <TabsContent value="voice" className="min-h-0 flex-1 data-[state=inactive]:hidden">
            <VoicePanel onLiveChange={setVoiceLive} />
          </TabsContent>
        </Tabs>
      </section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Kliniva AI panelini gizle" : "Kliniva AI asistanını aç"}
        className={cn(
          "relative grid size-14 place-items-center rounded-full text-white shadow-raised transition-[transform,background-color] duration-200 ease-out-expo hover:scale-105 focus-visible:outline-none focus-visible:shadow-focus active:scale-95",
          voiceLive ? "bg-red-600" : "bg-gradient-to-br from-brand-500 to-brand-700",
        )}
      >
        {voiceLive ? (
          <span className="absolute inset-0 animate-ping rounded-full bg-red-500/40" aria-hidden="true" />
        ) : null}
        {open ? (
          <X className="size-6" />
        ) : voiceLive ? (
          <Mic className="size-6" />
        ) : (
          <Sparkles className="size-6" />
        )}
      </button>
    </div>
  );
}
