/**
 * E2E temizliği — yalnızca E2E testinin seed klinikte oluşturduğu hastaları (soyadı E2E_SURNAME) yasal imha yoluyla
 * (kliniva.retention_purge = 'on', migration rolü) siler: E2E stok ürünleri (kod E2E-*) ve hareketleri, malzeme
 * kullanımları, randevular + geçmişi, rıza geri çekmeleri, seçimler, belgeler, şube bağları,
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
    // E2E stok ürünleri (kod "E2E-" ile başlar) ve E2E hastalarının malzeme kullanımları.
    const items = (
      await tx.execute<{ id: string }>(
        sql`select id from kliniva.inventory_items where tenant_id = ${t.id} and code like 'E2E-%'`,
      )
    ).rows.map((r) => r.id);
    const uuidList = (xs: string[]) =>
      sql.join(
        xs.map((x) => sql`${x}::uuid`),
        sql`, `,
      );
    const itemCond = items.length ? sql`inventory_item_id in (${uuidList(items)})` : sql`false`;
    const patientCond = ids.length ? sql`patient_id in (${uuidList(ids)})` : sql`false`;
    // Sprint 6: E2E randevu / ürün / lotlarına ait bildirimler ve outbox olayları (iş kayıtlarıyla birlikte imha).
    const refs = sql`(
      ${items.length ? sql`id_ref in (${uuidList(items)})` : sql`false`}
      or id_ref in (select id from kliniva.stock_lots where tenant_id = ${t.id} and ${itemCond})
      or id_ref in (select id from kliniva.appointments where tenant_id = ${t.id} and ${patientCond})
      or id_ref in (select id from kliniva.patient_tasks where tenant_id = ${t.id} and ${patientCond}))`;
    await tx.execute(
      sql`delete from kliniva.notifications n where n.tenant_id = ${t.id} and exists (select 1 from (select n.entity_id as id_ref) x where ${refs})`,
    );
    await tx.execute(
      sql`delete from kliniva.outbox_events o where o.tenant_id = ${t.id} and exists (select 1 from (select o.aggregate_id as id_ref) x where ${refs})`,
    );
    await tx.execute(sql`delete from kliniva.patient_material_usage_allocations where tenant_id = ${t.id} and (${itemCond}
      or patient_usage_item_id in (select i.id from kliniva.patient_material_usage_items i
        where i.tenant_id = ${t.id} and i.patient_usage_id in
          (select id from kliniva.patient_material_usages where tenant_id = ${t.id} and ${patientCond})))`);
    await tx.execute(sql`delete from kliniva.patient_material_usage_items where tenant_id = ${t.id} and (${itemCond}
      or patient_usage_id in (select id from kliniva.patient_material_usages where tenant_id = ${t.id} and ${patientCond}))`);
    await tx.execute(sql`delete from kliniva.stock_movements where tenant_id = ${t.id} and (${itemCond}
      or patient_usage_id in (select id from kliniva.patient_material_usages where tenant_id = ${t.id} and ${patientCond}))`);
    await tx.execute(sql`delete from kliniva.stock_balances where tenant_id = ${t.id} and ${itemCond}`);
    await tx.execute(sql`delete from kliniva.stock_lots where tenant_id = ${t.id} and ${itemCond}`);
    await tx.execute(
      sql`delete from kliniva.patient_material_usages where tenant_id = ${t.id} and ${patientCond}`,
    );
    if (items.length) {
      await tx.execute(
        sql`delete from kliniva.inventory_items where tenant_id = ${t.id} and id in (${uuidList(items)})`,
      );
    }
    await tx.execute(
      sql`delete from kliniva.inventory_categories where tenant_id = ${t.id} and name like 'E2E %'`,
    );
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
    // Sprint 7: E2E randevularına bağlı sesli asistan eylemleri / günlükleri; açık kalan E2E ses oturumları kapatılır.
    const e2eAppts = sql`(select id from kliniva.appointments where tenant_id = ${t.id} and patient_id in (${list}))`;
    await tx.execute(
      sql`delete from kliniva.pending_ai_actions where tenant_id = ${t.id} and result_entity_id in ${e2eAppts}`,
    );
    await tx.execute(sql`delete from kliniva.ai_action_logs where tenant_id = ${t.id} and entity_id in ${e2eAppts}
      and id not in (select ai_action_log_id from kliniva.pending_ai_actions where tenant_id = ${t.id} and ai_action_log_id is not null)`);
    await tx.execute(
      sql`update kliniva.voice_sessions set status = 'ENDED', ended_at = now() where tenant_id = ${t.id} and status = 'ACTIVE'`,
    );
    // Sprint 8: E2E hastalarının hizmet bedelleri ve tahsilatları (finans defteri; yalnızca imha bağlamında silinir)
    await tx.execute(
      sql`delete from kliniva.patient_charges where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    await tx.execute(
      sql`delete from kliniva.cash_transactions where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    // Sprint 7.3: E2E hastalarının muayene kayıtları (sağlık verisi; yalnızca yasal imha bağlamında silinebilir)
    await tx.execute(
      sql`delete from kliniva.patient_tasks where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    await tx.execute(
      sql`delete from kliniva.lab_results where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    const att = await tx.execute<{ k: string }>(
      sql`select storage_key as k from kliniva.clinical_attachments where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    for (const r of att.rows) keys.push(r.k);
    await tx.execute(
      sql`delete from kliniva.clinical_attachments where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    await tx.execute(
      sql`delete from kliniva.clinical_notes where tenant_id = ${t.id} and patient_id in (${list})`,
    );
    await tx.execute(sql`delete from kliniva.appointment_events where tenant_id = ${t.id} and appointment_id in
      (select id from kliniva.appointments where tenant_id = ${t.id} and patient_id in (${list}))`);
    await tx.execute(
      sql`delete from kliniva.appointments where tenant_id = ${t.id} and patient_id in (${list})`,
    );
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
