import "server-only";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { permissions, rolePermissions, roles } from "@/server/db/schema";
import { PERMISSIONS, ROLE_KEYS, SYSTEM_ROLES } from "@/server/auth/permissions";

/**
 * Kod içindeki RBAC kataloğunu veritabanına idempotent olarak yazar (seed ve test kurulumu).
 * Sistem rolleri tenant_id NULL'dır; roles tablosu RLS altında olduğu için yazma yalnızca
 * kliniva.platform_seed = 'on' (transaction'a yerel) bağlamında mümkündür.
 *
 * Bu işlem MIGRATION bağlantısıyla çalışır (getMigrationDb); uygulama rolünün roles/permissions tablolarına
 * yazma yetkisi yoktur.
 */
export async function syncRbacCatalog(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('kliniva.platform_seed', 'on', true)`);

    for (const [key, description] of Object.entries(PERMISSIONS)) {
      await tx.insert(permissions).values({ key, description }).onConflictDoUpdate({
        target: permissions.key,
        set: { description },
      });
    }
    // Katalogdan kaldırılan yetkiler (ör. Sprint 2'de document.* → patient.document.*) silinir;
    // role_permissions FK CASCADE ile temizlenir → hiçbir rol eski yetkiyi taşımaya devam etmez.
    await tx.delete(permissions).where(notInArray(permissions.key, Object.keys(PERMISSIONS)));
    const permRows = await tx.select({ id: permissions.id, key: permissions.key }).from(permissions);
    const permId = new Map(permRows.map((p) => [p.key, p.id]));

    for (const key of ROLE_KEYS) {
      const def = SYSTEM_ROLES[key];
      let [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(isNull(roles.tenantId), eq(roles.key, key)));
      if (!role) {
        [role] = await tx
          .insert(roles)
          .values({ tenantId: null, key, name: def.name, isSystem: true })
          .returning({ id: roles.id });
      } else {
        await tx.update(roles).set({ name: def.name }).where(eq(roles.id, role.id));
      }
      // Rol yetkileri katalogla birebir eşitlenir (fazlası silinir).
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role!.id));
      const values = def.permissions.map((p) => ({ roleId: role!.id, permissionId: permId.get(p)! }));
      if (values.length) await tx.insert(rolePermissions).values(values);
    }
  });
}
