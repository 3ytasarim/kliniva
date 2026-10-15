import { rmSync } from "node:fs";
import { AUTH_FILE } from "./support/helpers";

/** Oturum çerezi diskte kalmaz. */
export default function globalTeardown() {
  rmSync(AUTH_FILE, { force: true });
}
