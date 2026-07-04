function validHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function validInteger(
  value: string | undefined,
  minimum: number,
  maximum: number
): boolean {
  if (value === undefined || value.trim() === "") return true;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

export function collectConfigErrors(
  env: Record<string, string | undefined>
): string[] {
  const errors: string[] = [];
  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  if (apiKey && /your[-_ ]?api[-_ ]?key|replace[-_ ]?me|sk-your/i.test(apiKey)) {
    errors.push("LLM_API_KEY 仍是示例占位值");
  }

  const baseURL = env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1";
  if (!validHttpUrl(baseURL)) errors.push("LLM_BASE_URL 必须是有效的 HTTP(S) URL");
  if (env.LLM_MODEL !== undefined && !env.LLM_MODEL.trim()) {
    errors.push("LLM_MODEL 不能为空");
  }

  const host = env.HOST?.trim();
  if (
    host !== undefined &&
    (!host || host.length > 253 || /[\s/?#]/.test(host) || host.includes("://"))
  ) {
    errors.push("HOST 必须是有效的主机名或 IP 地址");
  }

  for (const name of ["LLM_PROXY_URL", "WEB_SEARCH_PROXY_URL"] as const) {
    const value = env[name]?.trim();
    if (value && !validHttpUrl(value)) errors.push(`${name} 必须是有效的 HTTP(S) URL`);
  }

  const provider = env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (provider && !["auto", "tavily", "brave", "html"].includes(provider)) {
    errors.push("WEB_SEARCH_PROVIDER 只能是 auto、tavily、brave 或 html");
  }
  const logLevel = env.LOG_LEVEL?.trim().toLowerCase();
  if (logLevel && !["debug", "info", "warn", "error"].includes(logLevel)) {
    errors.push("LOG_LEVEL 只能是 debug、info、warn 或 error");
  }

  const authToken = env.APP_AUTH_TOKEN?.trim();
  if (authToken && /replace[-_ ]?with|change[-_ ]?me|your[-_ ]?token/i.test(authToken)) {
    errors.push("APP_AUTH_TOKEN 仍是示例占位值");
  } else if (
    authToken &&
    (authToken.length < 16 || authToken.length > 512 || /\s/.test(authToken))
  ) {
    errors.push("APP_AUTH_TOKEN 必须是 16-512 位且不含空白字符");
  }

  const numericRules = [
    ["PORT", 1, 65_535],
    ["REQUEST_TIMEOUT_MS", 5_000, 300_000],
    ["WEB_SEARCH_TIMEOUT_MS", 1_000, 60_000],
    ["WEB_SEARCH_RETRIES", 0, 5],
    ["WEB_SEARCH_CACHE_TTL_MS", 0, 3_600_000],
  ] as const;
  for (const [name, minimum, maximum] of numericRules) {
    if (!validInteger(env[name], minimum, maximum)) {
      errors.push(`${name} 必须是 ${minimum}-${maximum} 范围内的整数`);
    }
  }
  return errors;
}
