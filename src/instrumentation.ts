/** Sunucu açılışında bir kez: runtime DB rolünün RLS'i atlayamadığını doğrula (üretimde güvensizse başlama). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertRuntimeRoleSafe } = await import("@/server/db/runtime-guard");
  await assertRuntimeRoleSafe(process.env.NODE_ENV === "production");
  // Bildirim outbox işçisi + SKT taraması (süreç içi; OUTBOX_AUTOPROCESS=off ise kapalı).
  const { startNotificationWorker } = await import("@/server/notifications/worker");
  startNotificationWorker();
}
