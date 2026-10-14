import "server-only";
import { getPool } from "@/server/db/client";
import { logger } from "@/server/log/logger";

/**
 * Çalışma anı rol koruması: uygulama SUPERUSER / BYPASSRLS / kliniva tablo sahibi bir rolle bağlanıyorsa RLS etkisiz
 * kalır. Üretimde uygulama bu durumda BAŞLAMAZ; geliştirmede yüksek seviyeli uyarı loglanır.
 */
export type RuntimeRoleReport = { role: string; unsafe: string[] };

export async function inspectRuntimeRole(): Promise<RuntimeRoleReport> {
  const r = await getPool().query<{ u: string; su: boolean; by: boolean; owns: number }>(`
    select current_user as u, r.rolsuper as su, r.rolbypassrls as by,
           (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'kliniva' and c.relowner = r.oid) as owns
      from pg_roles r where r.rolname = current_user`);
  const row = r.rows[0]!;
  const unsafe: string[] = [];
  if (row.su) unsafe.push("SUPERUSER");
  if (row.by) unsafe.push("BYPASSRLS");
  if (row.owns > 0) unsafe.push("TABLE_OWNER");
  return { role: row.u, unsafe };
}

export async function assertRuntimeRoleSafe(production: boolean): Promise<void> {
  let report: RuntimeRoleReport;
  try {
    report = await inspectRuntimeRole();
  } catch (e) {
    // Bağlantı yoksa istekler zaten güvenli şekilde hata verir; burada yalnızca olay loglanır (değer yok).
    logger.error("db.runtime_role_check_failed", { error: e });
    return;
  }
  if (!report.unsafe.length) {
    logger.info("db.runtime_role_ok", { role: report.role });
    return;
  }
  logger.error("db.runtime_role_unsafe", { role: report.role, unsafe: report.unsafe.join(",") });
  if (production) {
    throw new Error(`KLINIVA_UNSAFE_DB_ROLE: runtime role is ${report.unsafe.join(",")}; use kliniva_app`);
  }
}
