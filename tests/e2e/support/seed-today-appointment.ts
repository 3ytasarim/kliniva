/**
 * E2E fikstürü (yalnızca yerel test ortamı): verilen E2E hastası için BUGÜN 07:00 (şube saati) demo doktorla BOOKED
 * randevu ekler — operasyon ekranı testi günün saatinden bağımsız çalışsın diye (çalışma saati dışı, çakışmasız).
 * Rezervasyon kuralları (uygunluk) burada test edilmez; durum geçişleri uygulama servisleriyle test edilir.
 * Çıktı: yalnızca randevu kimliği.
 *
 * Çalıştırma: npx tsx --conditions=react-server tests/e2e/support/seed-today-appointment.ts <hasta adı>
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: () => {} });

const E2E_SURNAME = "E2E-Otomasyon";

async function main() {
  const firstName = process.argv[2];
  if (!firstName) throw new Error("hasta adı gerekli");
  const { sql } = await import("drizzle-orm");
  const { getMigrationDb, closeMigrationDb } = await import("@/server/db/migration-client");
  const { zonedDateTimeToUtc, dateInZone } = await import("@/lib/time");
  const slug = process.env.SEED_TENANT_SLUG ?? "demo-klinik";
  const db = getMigrationDb();
  const id = await db.transaction(async (tx) => {
    const [t] = (await tx.execute<{ id: string }>(sql`select id from kliniva.tenants where slug = ${slug}`))
      .rows;
    if (!t) throw new Error("seed kliniği yok");
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [ctx] = (
      await tx.execute<{
        patient_id: string;
        branch_id: string;
        timezone: string;
        doctor_id: string;
        service_id: string;
        owner_id: string;
      }>(sql`
        select p.id as patient_id, b.id as branch_id, b.timezone,
               (select d.id from kliniva.doctor_profiles d join kliniva.users u on u.id = d.user_id
                 where d.tenant_id = ${t.id} and u.email_normalized = ${`doktor@${slug}.demo`}) as doctor_id,
               (select s.id from kliniva.clinical_services s where s.tenant_id = ${t.id} and s.name = 'Muayene') as service_id,
               (select ur.user_id from kliniva.user_roles ur join kliniva.roles r on r.id = ur.role_id
                 where ur.tenant_id = ${t.id} and r.key = 'CLINIC_OWNER' limit 1) as owner_id
          from kliniva.patients p
          join kliniva.patient_branches pb on pb.tenant_id = p.tenant_id and pb.patient_id = p.id
          join kliniva.branches b on b.tenant_id = pb.tenant_id and b.id = pb.branch_id
         where p.tenant_id = ${t.id} and p.first_name = ${firstName} and p.last_name = ${E2E_SURNAME}
         order by p.created_at desc limit 1`)
    ).rows;
    if (!ctx?.doctor_id || !ctx.service_id)
      throw new Error("E2E hasta / demo doktor / Muayene hizmeti bulunamadı");
    const day = dateInZone(new Date(), ctx.timezone);
    const start = zonedDateTimeToUtc(day, 7 * 60, ctx.timezone);
    const end = new Date(start.getTime() + 30 * 60_000);
    const [row] = (
      await tx.execute<{ id: string }>(sql`
        insert into kliniva.appointments (tenant_id, branch_id, patient_id, doctor_id, service_id, status,
          scheduled_start, scheduled_end, timezone, duration_minutes, source, created_by_user_id)
        values (${t.id}, ${ctx.branch_id}, ${ctx.patient_id}, ${ctx.doctor_id}, ${ctx.service_id}, 'BOOKED',
          ${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz, ${ctx.timezone}, 30, 'STAFF', ${ctx.owner_id})
        returning id`)
    ).rows;
    await tx.execute(sql`
      insert into kliniva.appointment_events (tenant_id, appointment_id, type, from_status, to_status, actor_user_id, source, metadata_safe)
      values (${t.id}, ${row!.id}, 'CREATED', null, 'BOOKED', ${ctx.owner_id}, 'STAFF', '{}'::jsonb)`);
    return row!.id;
  });
  await closeMigrationDb();
  process.stdout.write(id);
}

main().catch((e) => {
  process.stderr.write(`seed-today-appointment: ${e instanceof Error ? e.message.split("\n")[0] : "hata"}\n`);
  process.exit(1);
});
