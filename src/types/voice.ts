/** Sesli asistan — istemci ve sunucunun paylaştığı tipler (çalışma zamanı kodu yok). */
export type VoiceSessionStartResponse = {
  sessionId: string;
  transport: "openai" | "mock";
  /** Kısa ömürlü istemci sırrı (ana API anahtarı DEĞİL). Bellekte tutulur; saklanmaz / loglanmaz. */
  clientSecret: string;
  expiresAt: number;
  model: string;
  language: "tr" | "en";
  privacyMode: "STANDARD" | "DISCREET";
};

export type VoiceToolOutput = Record<string, unknown> & {
  ok: boolean;
  status?: string;
  actionId?: string;
  summary?: string;
  message?: string;
};

export type VoiceMockTurn = {
  reply: string;
  toolCalls: { name: string; ok: boolean; output: VoiceToolOutput }[];
  pending: { actionId: string; summary: string } | null;
  grounded: boolean;
  language: "tr" | "en";
};

export type VoiceUiState =
  "idle" | "connecting" | "listening" | "thinking" | "speaking" | "tool" | "confirm" | "error";

/** Yazılı sohbet oturumu: istemciye sır DÖNMEZ (model çağrısı sunucuda). */
export type ChatSessionStartResponse = {
  sessionId: string;
  transport: "openai" | "mock";
  language: "tr" | "en";
  privacyMode: "STANDARD" | "DISCREET";
};

export type ChatTurnResponse = {
  reply: string;
  toolCalls: { name: string; output: VoiceToolOutput }[];
  pending: { actionId: string; summary: string } | null;
  settled: boolean;
  grounded: boolean;
};
