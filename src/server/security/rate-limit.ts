import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { keyedHash } from "@/server/security/crypto";

/**
 * Sabit pencereli, veritabanı tabanlı hız sınırlama (sunucusuz/çok örnekli dağıtımda bellek paylaşılmadığı için).
 * Anahtarlar HMAC özetidir: e-posta veya IP düz metin olarak rate_limits tablosuna yazılmaz.
 */
export type RateLimitRule = { name: string; limit: number; windowSeconds: number };

export const RULES = {
  loginPerAccount: { name: "login-acct", limit: 5, windowSeconds: 15 * 60 },
  loginPerIp: { name: "login-ip", limit: 30, windowSeconds: 15 * 60 },
  mfaPerSession: { name: "mfa", limit: 5, windowSeconds: 15 * 60 },
} satisfies Record<string, RateLimitRule>;

const bucketKey = (rule: RateLimitRule, subject: string) =>
  `${rule.name}:${keyedHash("rate-limit", subject)}`;

/** Pencere içindeki mevcut sayaç ≥ limit ise true (engelli). Sayaç artırmaz. */
export async function isRateLimited(rule: RateLimitRule, subject: string): Promise<boolean> {
  const key = bucketKey(rule, subject);
  const res = await getDb().execute<{ count: number }>(sql`
    select count from kliniva.rate_limits
     where key = ${key} and window_start > now() - make_interval(secs => ${rule.windowSeconds})`);
  const count = res.rows[0]?.count ?? 0;
  return count >= rule.limit;
}

/** Başarısız denemeyi kaydeder (atomik upsert). Pencere dolmuşsa sayaç 1'den başlar. */
export async function recordHit(rule: RateLimitRule, subject: string): Promise<number> {
  const key = bucketKey(rule, subject);
  const res = await getDb().execute<{ count: number }>(sql`
    insert into kliniva.rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when kliniva.rate_limits.window_start > now() - make_interval(secs => ${rule.windowSeconds})
                   then kliniva.rate_limits.count + 1 else 1 end,
      window_start = case when kliniva.rate_limits.window_start > now() - make_interval(secs => ${rule.windowSeconds})
                   then kliniva.rate_limits.window_start else now() end
    returning count`);
  return res.rows[0]?.count ?? 1;
}

export async function clearHits(rule: RateLimitRule, subject: string): Promise<void> {
  await getDb().execute(sql`delete from kliniva.rate_limits where key = ${bucketKey(rule, subject)}`);
}
