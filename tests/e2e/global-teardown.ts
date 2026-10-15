import { rmSync } from "node:fs";
import { AUTH_FILE, AUTH_FILE_DOCTOR, AUTH_FILE_RECEPTION } from "./support/helpers";

/** Oturum çerezi diskte kalmaz. */
export default function globalTeardown() {
  for (const f of [AUTH_FILE, AUTH_FILE_RECEPTION, AUTH_FILE_DOCTOR]) rmSync(f, { force: true });
}
