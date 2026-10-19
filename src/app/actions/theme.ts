"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";

/** Tema tercihini kaydeder (1 yıl). Yalnızca "light" | "dark" kabul edilir; kişisel veri içermez. */
export async function setThemeAction(form: FormData): Promise<void> {
  const theme = parseTheme(String(form.get("theme") ?? ""));
  (await cookies()).set(THEME_COOKIE, theme, {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
}
