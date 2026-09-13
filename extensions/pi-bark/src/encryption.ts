import { createCipheriv, randomBytes } from "node:crypto";
import { ENCRYPTION_KEY_BYTES, type BarkEncryption } from "./config.ts";

const GCM_IV_BYTES = 12;

function randomText(length: number): string {
	return randomBytes(length).toString("base64url").slice(0, length);
}

export function generateEncryptionKey(): string {
	return randomText(ENCRYPTION_KEY_BYTES);
}

export function encryptPushContent(
	content: Readonly<Record<string, string>>,
	encryption: BarkEncryption,
): { ciphertext: string; iv: string } {
	const iv = randomText(GCM_IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", Buffer.from(encryption.key, "utf8"), Buffer.from(iv, "utf8"));
	const encrypted = Buffer.concat([
		cipher.update(JSON.stringify(content), "utf8"),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	return { ciphertext: encrypted.toString("base64"), iv };
}
