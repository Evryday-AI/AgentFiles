import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const FILE_CODE_NAMESPACE_SIZE = ALPHABET.length ** 5;
export const FILE_CODE_ALLOCATION_ATTEMPTS = 32;

export function createFileCode(): string {
  let value = "F-";
  const bytes = randomBytes(5);
  for (const byte of bytes) {
    value += ALPHABET[byte % ALPHABET.length];
  }
  return value;
}
