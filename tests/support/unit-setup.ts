import { randomBytes } from "node:crypto";

// Birim testleri gerçek anahtar KULLANMAZ: her çalıştırmada rastgele, geçici test anahtarı.
process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString("base64");
process.env.APP_ORIGIN = "http://localhost:3000";
