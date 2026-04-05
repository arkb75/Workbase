import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function resolveEncryptionKey() {
  const secret = process.env.WORKBASE_ENCRYPTION_KEY;

  if (!secret) {
    throw new Error("WORKBASE_ENCRYPTION_KEY is required for encrypted token storage.");
  }

  return createHash("sha256").update(secret).digest();
}

export function encryptString(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", resolveEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return ["v1", iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptString(payload: string) {
  const [version, ivBase64, authTagBase64, encryptedBase64] = payload.split(":");

  if (version !== "v1" || !ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new Error("Encrypted payload is malformed.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    resolveEncryptionKey(),
    Buffer.from(ivBase64, "base64"),
  );

  decipher.setAuthTag(Buffer.from(authTagBase64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedBase64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
