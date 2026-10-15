/**
 * E2E temizliği — yalnızca E2E testinin seed klinikte oluşturduğu hastaları (soyadı E2E_SURNAME) yasal imha yoluyla
 * (kliniva.retention_purge = 'on', migration rolü) siler: rıza geri çekmeleri, seçimler, belgeler, şube bağları,
 * hasta. Depodaki şifreli belge / imza nesneleri de imha bağlamında silinir. Audit kayıtları (PII içermez) korunur.
 * Başka hiçbir kayda dokunmaz. Çıktıda yalnızca sayılar vardır.
 *
 * Çalıştırma: npx tsx --conditions=react-server tests/e2e/support/purge-e2e-patients.ts
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

export const E2E_SURNAME = "E2E-Otomasyon";

async function main() {
  const { sql } = await import("drizzle-orm");
  const { getMigrationDb, closeMigrationDb } = await import("@/server/db/migration-client");
  const { getPrivateStorage } = await import("@/server/storage/private-storage");
  const slug = process.env.SEED_TENANT_SLUG ?? "demo-klinik";
  const db = getMigrationDb();
  const keys: string[] = [];
  const n = await db.transaction(async (tx) => {
    const [t] = (await tx.execute<{ id: string }>(sql`select id from kliniva.tenants where slug = ${slug}`))
      .rows;
    if (!t) return 0;
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    await tx.execute(sql`select set_config('kliniva.retention_purge', 'on', true)`);
    const ids = (
      await tx.execute<{ id: string }>(
        sql`select id from kliniva.patients where tenant_id = ${t.id} and last_name = ${E2E_SURNAME}`,
      )
    ).rows.map((r) => r.id);
    if (!ids.length) return 0;
    const list = sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const docs = await tx.execute<{ p: string | null; s: string | null }>(
      sql`select pdf_storage_key as p, signature_storage_key as s from kliniva.patient_documents
          where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    for (const d of docs.rows) for (const k of [d.p, d.s]) if (k) keys.push(k);
    await tx.execute(
      sql`delete from kliniva.consent_revocations where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    await tx.execute(sql`delete from kliniva.consent_choices where tenant_id = ${t.id} and patient_document_id in
      (select id from kliniva.patient_documents where tenant_id = ${t.id} and patient_id in (${list}))`);
    await tx.execute(
      sql`delete from kliniva.patient_documents where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    await tx.execute(
      sql`delete from kliniva.patient_branches where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    await tx.execute(sql`delete from kliniva.patients where tenant_id = ${t.id} and id in (${list})`);
    return ids.length;
  });
  const storage = getPrivateStorage();
  let removed = 0;
  for (const k of keys) if (await storage.deleteIfAllowed(k, { retentionPurge: true })) removed++;
  console.log(`E2E temizlik: ${n} hasta, ${removed} depo nesnesi`);
  await closeMigrationDb();
}

main().catch((e) => {
  console.error(`E2E temizlik başarısız: ${(e as { code?: string }).code ?? "hata"}`);
  process.exit(1);
});
