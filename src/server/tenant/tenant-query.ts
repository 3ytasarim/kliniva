import "server-only";
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { getDb, type Db, type DbTx } from "@/server/db/client";
import { isUuid } from "@/server/validation";

declare const tenantScopeBrand: unique symbol;

/**
 * Kiracı kapsamlı veritabanı erişimi. Yalnızca tenantQuery() üretir; elle oluşturulamaz (brand).
 * `tx` üzerinde app.tenant_id transaction'a yerel olarak ayarlıdır → RLS yalnızca bu kiracının satırlarını gösterir.
 */
export type TenantScope = {
  readonly tenantId: string;
  readonly tx: DbTx;
  readonly [tenantScopeBrand]: true;
};

/** tenantQuery'ye verilebilen tek şey: sunucuda doğrulanmış oturumdan türetilmiş bağlam (AuthContext). */
export type TenantBound = { readonly tenantId: string };

/**
 * Kiracı kapsamlı sorgu çalıştırır. Tek giriş noktası budur:
 *   tenantQuery(ctx, async (scope) => scope.tx.select().from(patients).where(tenantWhere(patients, scope, ...)))
 *
 * - tenantId istemciden değil, sunucu oturumundan gelir (AuthContext).
 * - Transaction başında set_config('app.tenant_id', ..., true) → RLS politikası devreye girer.
 * - Repository'ler ayrıca tenantWhere() ile açık tenant_id filtresi ekler (savunma derinliği).
 */
export async function tenantQuery<T>(ctx: TenantBound, fn: (scope: TenantScope) => Promise<T>): Promise<T> {
  return runInTenant(ctx.tenantId, fn);
}

/**
 * Yalnızca kimlik doğrulama akışı içindir (giriş sırasında henüz AuthContext yoktur; kiracı slug'dan çözülür).
 * ESLint ile src/server/auth ve src/server/tenant dışına import'u yasaktır.
 */
export async function runInTenant<T>(tenantId: string, fn: (scope: TenantScope) => Promise<T>): Promise<T> {
  return runInTenantWith(getDb(), tenantId, fn);
}

/**
 * Kiracı bağlamı her zaman TRANSACTION'A YERELDİR: set_config(..., is_local = true) ≡ SET LOCAL.
 * COMMIT/ROLLBACK ile bağlam silinir; havuzdan (pg Pool veya Neon PgBouncer transaction modu) aynı bağlantıyı
 * alan sonraki istek önceki kiracının bağlamını göremez. Oturum düzeyinde SET app.tenant_id KULLANILMAZ.
 *
 * `db` parametresi yalnızca seed/test fikstürleri içindir (migration bağlantısı); uygulama runInTenant kullanır.
 */
export async function runInTenantWith<T>(
  db: Db,
  tenantId: string,
  fn: (scope: TenantScope) => Promise<T>,
): Promise<T> {
  if (!isUuid(tenantId)) throw new Error("tenantQuery: invalid tenant context");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn({ tenantId, tx } as TenantScope);
  });
}

/** Açık kiracı filtresi: tenant_id = scope.tenantId AND ...ek koşullar. */
export function tenantWhere(
  table: { tenantId: PgColumn },
  scope: TenantScope,
  ...conditions: (SQL | undefined)[]
): SQL {
  return and(eq(table.tenantId, scope.tenantId), ...conditions) as SQL;
}

/** Ekleme değerlerine kapsamın tenantId'sini zorla yazar (istemciden gelen tenantId'yi ezer). */
export function withTenant<T extends object>(scope: TenantScope, values: T): T & { tenantId: string } {
  return { ...values, tenantId: scope.tenantId };
}
