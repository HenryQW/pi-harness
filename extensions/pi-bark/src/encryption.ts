import { createCipheriv, randomBytes } from "node:crypto";
import { ENCRYPTION_KEY_BYTES, type BarkEncryption } from "./config.ts";

const RANDOM_TEXT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const GCM_IV_BYTES = 12;

function randomText(length: number): string {
	return Array.from(randomBytes(length), (byte) => RANDOM_TEXT_ALPHABET[byte & 63]).join("");
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
