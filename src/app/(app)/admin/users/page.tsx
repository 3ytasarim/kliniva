import type { Metadata } from "next";
import { requireUser } from "@/server/auth/guards";
import { hasPermission } from "@/server/auth/authz";
import { ROLE_KEYS, SYSTEM_ROLES } from "@/server/auth/permissions";
import { listUsers } from "@/server/services/users";
import { listBranches } from "@/server/services/org";
import { ActionForm, Field } from "@/components/action-form";
import { Forbidden } from "@/components/forbidden";
import { createUserAction } from "@/app/actions/admin";

export const metadata: Metadata = { title: "Kullanıcılar" };

export default async function UsersPage() {
  const ctx = await requireUser();
  if (!hasPermission(ctx, "user.read")) return <Forbidden />;
  const [rows, branchList] = await Promise.all([
    listUsers(ctx),
    hasPermission(ctx, "branch.read") ? listBranches(ctx) : Promise.resolve([]),
  ]);
  const branchName = new Map(branchList.map((b) => [b.id, b.name]));
  // Atanabilir roller: kullanıcının kendi yetkilerinin alt kümesi (sunucu da ayrıca doğrular).
  const assignable = ROLE_KEYS.filter(
    (k) => k !== "PLATFORM_SUPER_ADMIN" && SYSTEM_ROLES[k].permissions.every((p) => ctx.permissions.has(p)),
  );
  const describeRoles = (roles: { roleKey: string; branchId: string | null }[]) =>
    roles
      .map((r) => (r.branchId ? r.roleKey + " (" + (branchName.get(r.branchId) ?? "şube") + ")" : r.roleKey))
      .join(", ");

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Kullanıcılar</h1>
      <div className="card overflow-x-auto">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Ad Soyad</th>
              <th scope="col">E-posta</th>
              <th scope="col">Roller</th>
              <th scope="col">2FA</th>
              <th scope="col">Durum</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.firstName} {u.lastName}
                </td>
                <td>{u.email}</td>
                <td>{describeRoles(u.roles)}</td>
                <td>{u.twoFactorEnabled ? "Etkin" : "—"}</td>
                <td>{u.active ? "Aktif" : "Pasif"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasPermission(ctx, "user.manage") ? (
        <div className="card">
          <h2 className="mb-4 font-semibold">Yeni kullanıcı</h2>
          <ActionForm
            action={createUserAction}
            submitLabel="Kullanıcı ekle"
            className="grid gap-4 sm:grid-cols-2"
          >
            <Field label="Ad" name="firstName" required />
            <Field label="Soyad" name="lastName" required />
            <Field label="E-posta" name="email" type="email" required autoComplete="off" />
            <Field label="Telefon" name="phone" type="tel" />
            <Field
              label="Geçici parola (12+ karakter, harf ve rakam)"
              name="password"
              type="password"
              required
              autoComplete="new-password"
            />
            <div>
              <label htmlFor="f-roleKey" className="label">
                Rol *
              </label>
              <select id="f-roleKey" name="roleKey" required className="input">
                {assignable.map((k) => (
                  <option key={k} value={k}>
                    {SYSTEM_ROLES[k].name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="f-branchId" className="label">
                Şube kapsamı
              </label>
              <select id="f-branchId" name="branchId" className="input">
                {ctx.branchScope.all ? <option value="">Tüm şubeler</option> : null}
                {branchList.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          </ActionForm>
        </div>
      ) : null}
    </section>
  );
}
