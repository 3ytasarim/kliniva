import type { z } from "zod";
import { AppError } from "@/server/errors";

/** Zod ile doğrular; hata yalnızca ALAN ADLARINI döndürür (girilen değerleri asla). */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("VALIDATION", {
      fields: [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "")))],
    });
  }
  return parsed.data;
}
