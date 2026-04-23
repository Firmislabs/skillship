const LLMS_TXT_CONTENT_TYPES = new Set(["text/plain", "text/markdown"]);

function bareContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function firstNonBlankLine(body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length > 0) return line;
  }
  return null;
}

export function isValidLlmsTxt(contentType: string, body: string): boolean {
  const bare = bareContentType(contentType);
  if (!LLMS_TXT_CONTENT_TYPES.has(bare)) return false;
  const first = firstNonBlankLine(body);
  if (first === null) return false;
  return first.trimStart().startsWith("#");
}
