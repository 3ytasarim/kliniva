import "server-only";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireDatabaseUrl } from "@/server/env";

/**
 * Ham veritabanı istemcisi.
 *
 * ⚠ Bu modülü doğrudan import ETMEYİN. ESLint (no-restricted-imports) yalnızca src/server/db, src/server/tenant ve
 * platform düzeyindeki auth modüllerinin import etmesine izin verir. Kiracı verisine erişim tenantQuery() ile yapılır.
 *
 * Drizzle'a şema bilinçli olarak VERİLMEZ: böylece `db.query.patients.findMany()` gibi kiracı filtresiz ilişkisel
 * sorgu API'si hiç oluşmaz. Ayrıca kiracı tabloları RLS (FORCE) ile korunur; bağlamsız sorgu 0 satır döner.
 */
let pool: Pool | undefined;
let database: NodePgDatabase | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: requireDatabaseUrl(),
      max: Number(process.env.DB_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // pg hata nesneleri bağlantı dizesini içermez; yine de yalnızca kod/mesaj sınıfı loglanır.
    pool.on("error", (err) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "db.pool_error",
          code: (err as { code?: string }).code ?? null,
        }),
      );
    });
  }
  return pool;
}

export function getDb(): NodePgDatabase {
  if (!database) database = drizzle(getPool());
  return database;
}

export type Db = NodePgDatabase;
export type DbTx = Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0];

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}
