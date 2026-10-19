import { describe, expect, it } from "vitest";
import { loadEnvLocal } from "../support/load-env-local";
import { OpenAIRealtimeTransport } from "@/server/voice/transport";
import { realtimeToolDefinitions } from "@/server/voice/tools";
import { buildVoiceInstructions } from "@/server/voice/instructions";
import { OpenAIChatModel } from "@/server/assistant/chat";

/**
 * İSTEĞE BAĞLI gerçek OpenAI Realtime duman testi (npm run test:voice).
 * OPENAI_API_KEY yoksa ATLANIR (CI'da varsayılan). Yalnızca sentetik yapılandırma gönderilir: kiracı / hasta verisi YOK.
 * Doğrulanan: sunucu kısa ömürlü istemci sırrı üretebiliyor (model + araç şeması OpenAI tarafından kabul ediliyor).
 * Sır ve anahtar ASLA yazdırılmaz; yalnızca biçim / süre doğrulanır.
 */
loadEnvLocal();
const hasKey = Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!hasKey)("OpenAI Realtime duman testi", () => {
  it("istemci sırrı üretilir: kısa ömürlü, ana anahtar değil", async () => {
    const t = new OpenAIRealtimeTransport(process.env.OPENAI_API_KEY!);
    const r = await t.createClientSecret({
      instructions: buildVoiceInstructions({
        language: "tr",
        privacyMode: "DISCREET",
        clinicName: "Duman Testi",
      }),
      tools: realtimeToolDefinitions(),
      language: "tr",
    });
    expect(typeof r.value).toBe("string");
    expect(r.value.length).toBeGreaterThan(10);
    expect(r.value).not.toBe(process.env.OPENAI_API_KEY);
    const ttl = r.expiresAt * 1000 - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
  }, 30_000);

  it("yazılı sohbet: model + 19 araç şeması + talimatlar kabul edilir; araç gerektiren soruda araç çağrılır", async () => {
    const m = new OpenAIChatModel(process.env.OPENAI_API_KEY!);
    const tools = realtimeToolDefinitions().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const system = buildVoiceInstructions({
      language: "tr",
      privacyMode: "DISCREET",
      clinicName: "Duman Testi",
      mode: "chat",
    });
    const out = await m.complete(
      [
        { role: "system", content: system },
        { role: "user", content: "Kritik stokta hangi ürünler var?" },
      ],
      tools,
    );
    // Veri kuralı: stok sorusunda model sayı uydurmaz, aracı çağırır.
    expect(out.toolCalls.map((c) => c.function.name)).toContain("voice_get_low_stock");
  }, 45_000);
});

describe.skipIf(hasKey)("OpenAI Realtime duman testi (anahtar yok)", () => {
  it("OPENAI_API_KEY tanımlı değil → gerçek duman testi ATLANDI", () => {
    expect(hasKey).toBe(false);
  });
});
