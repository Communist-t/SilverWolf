import { timingSafeEqual } from "node:crypto";

export function isBearerTokenValid(
  authorization: string | undefined,
  expectedToken: string
): boolean {
  if (!expectedToken) return true;
  if (!authorization?.startsWith("Bearer ")) return false;

  const supplied = Buffer.from(authorization.slice(7), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
