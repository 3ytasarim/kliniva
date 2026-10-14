import { describe, expect, it } from "vitest";
import { sanitizeForLog, sanitizeString } from "@/server/log/sanitize";
import { logger, setLogSink } from "@/server/log/logger";
import { sanitizeAuditMetadata } from "@/server/audit/audit";

const FAKE_DB_URL =
  "postgresql://kliniva_owner:S3cr3tPassw0rd@ep-example-123.eu-central-1.aws.neon.tech/kliniva?sslmode=require";

describe("PII/PHI-safe logging", () => {
  it("hassas anahtar adları tamamen gizlenir", () => {
    const out = sanitizeForLog({
      password: "hunter2-hunter2",
      sessionToken: "abc",
      notes: "Diyabet tip 2",
      medicalNotes: "x",
      tcKimlik: "12345678950",
      signature: "data",
      pdfContent: "data",
      apiKey: "sk-123",
      DATABASE_URL: FAKE_DB_URL,
      APP_ENCRYPTION_KEY: "AAAA",
      patientId: "6f1c1b7e-1111-4a1a-9a1a-111111111111",
    }) as Record<string, unknown>;
    for (const k of [
      "password",
      "sessionToken",
      "notes",
      "medicalNotes",
      "tcKimlik",
      "signature",
      "pdfContent",
      "apiKey",
      "DATABASE_URL",
      "APP_ENCRYPTION_KEY",
    ]) {
      expect(out[k]).toBe("[REDACTED]");
    }
    expect(out.patientId).toBe("6f1c1b7e-1111-4a1a-9a1a-111111111111"); // kimlikler korunur
  });

  it("masum anahtar altındaki değerlerde de bağlantı dizesi, e-posta, TCKN, telefon, JWT maskelenir", () => {
    const s = sanitizeString(
      `failed ${FAKE_DB_URL} user ayse@example.com tc 12345678950 tel 0532 123 45 67 / +49 151 2345 6789 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U`,
    );
    expect(s).not.toContain("S3cr3tPassw0rd");
    expect(s).not.toContain("neon.tech");
    expect(s).not.toContain("ayse@example.com");
    expect(s).not.toContain("12345678950");
    expect(s).not.toContain("123 45");
    expect(s).not.toContain("2345 6789");
    expect(s).not.toContain("eyJzdWIi");
    expect(s).toContain("[REDACTED_URL]");
  });

  it("tarih ve UUID gibi zararsız değerler bozulmaz", () => {
    expect(sanitizeString("2026-10-14T10:00:00Z")).toBe("2026-10-14T10:00:00Z");
    expect(sanitizeString("6f1c1b7e-1111-4a1a-9a1a-111111111111")).toBe(
      "6f1c1b7e-1111-4a1a-9a1a-111111111111",
    );
  });

  it("Error nesnesinin mesajı temizlenir, ikili veri yazılmaz", () => {
    const out = sanitizeForLog({ error: new Error(`connect failed ${FAKE_DB_URL}`), blob: Buffer.alloc(10) });
    expect(JSON.stringify(out)).not.toContain("S3cr3tPassw0rd");
    expect(JSON.stringify(out)).toContain("[BINARY 10B]");
  });

  it("Drizzle sorgu hatasının SQL parametreleri (hasta verisi) log'a yazılmaz", () => {
    const err = new Error(
      "Failed query: insert into kliniva.patients values ($1, $2)\nparams: Ayşe,Yılmazgizli,v1.abc.def.ghi",
    );
    err.name = "DrizzleQueryError";
    (err as { cause?: unknown }).cause = Object.assign(
      new Error("duplicate key value violates unique constraint"),
      { code: "23505" },
    );
    const out = JSON.stringify(sanitizeForLog({ error: err }));
    expect(out).not.toContain("Yılmazgizli");
    expect(out).not.toContain("insert into");
    expect(out).toContain("23505");
  });

  it("logger çıktısı yapılandırılmış JSON ve temizlenmiş", () => {
    const lines: string[] = [];
    const restore = setLogSink((l) => lines.push(l));
    logger.error("db.failed", { detail: FAKE_DB_URL, password: "x", phone: "05321234567" });
    restore();
    const rec = JSON.parse(lines[0]!);
    expect(rec.event).toBe("db.failed");
    expect(rec.level).toBe("error");
    expect(lines[0]).not.toContain("S3cr3tPassw0rd");
    expect(lines[0]).not.toContain("1234567");
    expect(rec.password).toBe("[REDACTED]");
  });
});

describe("Audit metadata temizleme", () => {
  it("serbest metin (isim, not, e-posta) ve hassas anahtarlar atılır", () => {
    const out = sanitizeAuditMetadata({
      patientName: "Ayşe Yılmaz",
      note: "kemoterapi",
      email: "a@b.com",
      password: "x",
      token: "abc",
      hasHealthNotes: true,
      version: 2,
      type: "KVKK_DISCLOSURE",
      patientId: "6f1c1b7e-1111-4a1a-9a1a-111111111111",
    });
    expect(out).toEqual({
      hasHealthNotes: true,
      version: 2,
      type: "KVKK_DISCLOSURE",
      patientId: "6f1c1b7e-1111-4a1a-9a1a-111111111111",
    });
  });
});
