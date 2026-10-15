import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { tenants } from "@/server/db/schema";

/**
 * Sistem işleri (outbox işlemcisi, SKT taraması) için KİRACI KEŞFİ — yalnızca kiracı KİMLİKLERİ döner. Kiracı
 * verisine erişim her zaman ardından tenantQuery({ tenantId }) ile kiracı bağlamında (RLS altında) yapılır.
 */
export async function listActiveTenantIds(): Promise<string[]> {
  const rows = await getDb().select({ id: tenants.id }).from(tenants).where(eq(tenants.status, "ACTIVE"));
  return rows.map((r) => r.id);
}

/** İşlenmeye hazır outbox olayı olan kiracılar (SECURITY DEFINER fonksiyonu — olay içeriği dönmez). */
export async function outboxReadyTenantIds(limit = 50): Promise<string[]> {
  const r = await getDb().execute<{ id: string }>(sql`select kliniva.outbox_ready_tenants(${limit}) as id`);
  return r.rows.map((x) => x.id);
}
