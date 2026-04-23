const SNIFF_LIMIT = 512;

export function inferSpecContentType(
  bytes: Buffer,
  declaredContentType: string,
): string {
  const head = bytes.slice(0, SNIFF_LIMIT).toString("utf8");
  const trimmed = skipYamlLead(head);
  if (trimmed.trimStart().startsWith("{")) {
    return classifyJson(trimmed, declaredContentType);
  }
  return classifyYaml(trimmed, declaredContentType);
}

function skipYamlLead(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return lines.slice(i).join("\n");
  }
  return "";
}

function classifyJson(head: string, declared: string): string {
  const lead = head.trimStart();
  if (/"openapi"\s*:\s*"3\./.test(lead)) return "application/openapi+json";
  if (/"swagger"\s*:\s*"2\./.test(lead)) return "application/swagger+json";
  return declared;
}

function classifyYaml(text: string, declared: string): string {
  if (/^openapi\s*:\s*['"]?3\./m.test(text)) return "application/openapi+yaml";
  if (/^swagger\s*:\s*['"]?2\./m.test(text)) return "application/swagger+yaml";
  return declared;
}
