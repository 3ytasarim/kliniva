import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireMigrationDatabaseUrl } from "@/server/env";

/**
 * Migration / yönetim bağlantısı — MIGRATION_DATABASE_URL (doğrudan host, şema sahibi rol).
 *
 * ⚠ Uygulama çalışma anında ASLA kullanılmaz. Yalnızca: seed, RBAC kataloğu senkronizasyonu, rol kurulumu,
 * salt okunur inspect ve test fikstürlerinin kurulum/temizlik adımları. ESLint, src/app ve servislerden import'u yasaklar.
 * Uygulama sorguları her zaman en az yetkili rol (DATABASE_URL → kliniva_app) ile çalışır.
 */
let pool: Pool | undefined;
let database: NodePgDatabase | undefined;

export function getMigrationPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: requireMigrationDatabaseUrl(),
      max: 2,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
    pool.on("error", (err) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "db.migration_pool_error",
          code: (err as { code?: string }).code ?? null,
        }),
      );
    });
  }
  return pool;
}

export function getMigrationDb(): NodePgDatabase {
  if (!database) database = drizzle(getMigrationPool());
  return database;
}

export async function closeMigrationDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}
