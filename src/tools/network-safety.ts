import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1") return true;
  if (/^(fc|fd)/.test(normalized)) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

export function isPublicIpAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(normalized);
  if (version === 4) return !isPrivateIPv4(normalized);
  if (version === 6) return !isPrivateIPv6(normalized);
  return false;
}

export function isSafePublicHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal")
    ) {
      return false;
    }
    const ipVersion = isIP(hostname);
    if (ipVersion > 0) return isPublicIpAddress(hostname);
    return true;
  } catch {
    return false;
  }
}

export async function resolvesToPublicHttpTarget(value: string): Promise<boolean> {
  if (!isSafePublicHttpUrl(value)) return false;
  const hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(hostname)) return isPublicIpAddress(hostname);
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return (
      addresses.length > 0 &&
      addresses.every((entry) => isPublicIpAddress(entry.address))
    );
  } catch {
    return false;
  }
}

export async function readResponseText(
  response: {
    headers: { get(name: string): string | null };
    body: { getReader(): unknown } | null;
  },
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`响应体过大，限制 ${maxBytes} 字节`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader() as {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    cancel(reason?: unknown): Promise<void>;
    releaseLock(): void;
  };
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortHandler: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel("response body timeout");
      reject(new Error("读取响应体超时"));
    }, timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    abortHandler = () => {
      void reader.cancel("response body aborted");
      reject(signal.reason ?? new Error("读取响应体已取消"));
    };
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  });

  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await Promise.race([
        reader.read(),
        timeout,
        aborted,
      ]);
      signal?.throwIfAborted();
      if (done) break;
      if (!value) continue;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel("response body too large");
        throw new Error(`响应体过大，限制 ${maxBytes} 字节`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    reader.releaseLock();
  }
}
