export interface SearchPromptRecord {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  sourceType?: string;
}

function limitText(value: string | undefined, maxLength: number): string {
  const normalized = (value ?? "").replace(/\0/g, "").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

export function serializeUntrustedSearchResults(
  records: SearchPromptRecord[]
): string {
  return JSON.stringify(
    records.map((record, index) => ({
      index: index + 1,
      title: limitText(record.title, 300),
      sourceType: limitText(record.sourceType, 40),
      snippet: limitText(record.snippet, 1_000),
      content: limitText(record.content, 2_000),
      url: limitText(record.url, 1_000),
    })),
    null,
    2
  );
}
