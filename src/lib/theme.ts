/** Arayüz teması — çerezde tutulur (sunucu ilk render'da uygular → yanıp sönme yok). Varsayılan: açık. */
export const THEME_COOKIE = "kliniva_theme";
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const parseTheme = (v: string | undefined | null): Theme => (v === "dark" ? "dark" : "light");
