import "server-only";
import { randomToken } from "@/server/security/crypto";

/**
 * Realtime taşıyıcı bağdaştırıcısı. Ana OPENAI_API_KEY YALNIZCA sunucu ortamında; tarayıcıya yalnızca kısa ömürlü
 * istemci sırrı (client secret) gider. Sır / anahtar hiçbir yerde loglanmaz, saklanmaz, audit'e yazılmaz.
 *
 *  OpenAIRealtimeTransport — üretim: POST https://api.openai.com/v1/realtime/client_secrets (sunucudan).
 *  MockRealtimeTransport   — CI / testler / E2E (VOICE_TRANSPORT=mock): ağ çağrısı yok; tarayıcı metin tabanlı
 *                            sahte oturumla (deterministik model) aynı sunucu araçlarını kullanır.
 */
export type RealtimeTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RealtimeSessionConfig = {
  instructions: string;
  tools: RealtimeTool[];
  language: "tr" | "en";
};

export type ClientSecret = { value: string; expiresAt: number; model: string };

export interface RealtimeTransport {
  readonly kind: "openai" | "mock";
  createClientSecret(config: RealtimeSessionConfig): Promise<ClientSecret>;
}

const CLIENT_SECRET_TTL_S = 120;

export const realtimeModel = () => process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";

export class OpenAIRealtimeTransport implements RealtimeTransport {
  readonly kind = "openai" as const;
  constructor(private readonly apiKey: string) {}

  async createClientSecret(config: RealtimeSessionConfig): Promise<ClientSecret> {
    const model = realtimeModel();
    const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: CLIENT_SECRET_TTL_S },
        session: {
          type: "realtime",
          model,
          instructions: config.instructions,
          output_modalities: ["audio"],
          max_output_tokens: 1024,
          audio: {
            input: {
              noise_reduction: { type: "near_field" },
              transcription: {
                model: process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
                language: config.language,
              },
              // Araya girme (barge-in): kullanıcı konuşunca model yanıtı kesilir. Mutasyon sunucuda atomiktir.
              turn_detection: { type: "semantic_vad", create_response: true, interrupt_response: true },
            },
            output: { voice: process.env.OPENAI_REALTIME_VOICE || "marin" },
          },
          tools: config.tools,
          tool_choice: "auto",
        },
      }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      // Yalnızca durum kodu (yanıt gövdesi / anahtar loglanmaz).
      throw new Error(`REALTIME_HTTP_${res.status}`);
    }
    const json = (await res.json()) as { value?: string; expires_at?: number };
    if (!json.value) throw new Error("REALTIME_NO_SECRET");
    return {
      value: json.value,
      expiresAt: json.expires_at ?? Math.floor(Date.now() / 1000) + CLIENT_SECRET_TTL_S,
      model,
    };
  }
}

export class MockRealtimeTransport implements RealtimeTransport {
  readonly kind = "mock" as const;
  async createClientSecret(): Promise<ClientSecret> {
    return {
      value: `mock_${randomToken(16)}`,
      expiresAt: Math.floor(Date.now() / 1000) + CLIENT_SECRET_TTL_S,
      model: "mock-realtime",
    };
  }
}

/** Etkin taşıyıcı: VOICE_TRANSPORT=mock → sahte; aksi hâlde OPENAI_API_KEY varsa OpenAI; yoksa null (kullanılamaz). */
export function getRealtimeTransport(): RealtimeTransport | null {
  if (process.env.VOICE_TRANSPORT === "mock") return new MockRealtimeTransport();
  const key = process.env.OPENAI_API_KEY;
  return key ? new OpenAIRealtimeTransport(key) : null;
}

export const isMockTransportEnabled = () => process.env.VOICE_TRANSPORT === "mock";
