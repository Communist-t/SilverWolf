import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const SALT_LENGTH = 32;

function generateSalt(): string {
  return randomBytes(SALT_LENGTH).toString("hex");
}

export function hashPassword(password: string): string {
  const salt = generateSalt();
  const hash = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const derived = scryptSync(password, salt, KEY_LENGTH).toString("hex");
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function generateVerificationCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
