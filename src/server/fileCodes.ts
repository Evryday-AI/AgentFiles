import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createFileCode(length = 5): string {
  let value = "F-";
  const bytes = randomBytes(length);
  for (const byte of bytes) {
    value += ALPHABET[byte % ALPHABET.length];
  }
  return value;
}
