// src/sdk-plugins/auth-emit-apply.ts
// C3-owned sibling of auth-emit.ts: applyAuth branch emission.
// Separated so auth-emit.ts stays under the 300-line file cap.
// buildApplyAuth / buildApplyBranches live here; imported by auth-emit.ts.

import type { AuthSchemeDescriptor } from "./runtime.js";

/** Emits the applyAuth method body (branches per scheme kind). */
export function buildApplyAuth(schemes: readonly AuthSchemeDescriptor[]): string {
  const branches = buildApplyBranches(schemes);
  return [
    "  async applyAuth(headers: Record<string, string>, searchParams: URLSearchParams): Promise<void> {",
    "    const auth = this.auth;",
    ...branches,
    "  }",
  ].join("\n");
}

/**
 * Emits the per-kind if-branches inside applyAuth.
 *
 * apiKey branch: when the descriptor carries a non-empty valuePrefix the
 * prefix is baked as a string literal into the emitted code.
 * When prefix is absent or empty the output is BYTE-IDENTICAL to pre-C3.
 */
function buildApplyBranches(schemes: readonly AuthSchemeDescriptor[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const s of schemes) {
    if (s.kind === "bearer" && !seen.has("bearer")) {
      seen.add("bearer");
      lines.push('    if (auth.kind === "bearer") {');
      lines.push('      headers["Authorization"] = `Bearer ${auth.token}`;');
      lines.push("      return;");
      lines.push("    }");
    } else if (s.kind === "apiKey" && !seen.has("apiKey")) {
      seen.add("apiKey");
      lines.push('    if (auth.kind === "apiKey") {');
      const vp = s.valuePrefix ?? "";
      if (vp.length > 0) {
        lines.push(`      if (auth.in === "header") headers[auth.name] = "${vp}" + auth.value;`);
        lines.push(`      else searchParams.append(auth.name, "${vp}" + auth.value);`);
      } else {
        lines.push('      if (auth.in === "header") headers[auth.name] = auth.value;');
        lines.push('      else searchParams.append(auth.name, auth.value);');
      }
      lines.push("      return;");
      lines.push("    }");
    } else if (s.kind === "basic" && !seen.has("basic")) {
      seen.add("basic");
      lines.push('    if (auth.kind === "basic") {');
      lines.push("      const encoded = btoa(`${auth.username}:${auth.password}`);");
      lines.push('      headers["Authorization"] = `Basic ${encoded}`;');
      lines.push("      return;");
      lines.push("    }");
    } else if (s.kind === "oauth2ClientCredentials" && !seen.has("oauth2")) {
      seen.add("oauth2");
      lines.push('    if (auth.kind === "oauth2") {');
      lines.push("      const token = await this.getOauth2Token();");
      lines.push('      headers["Authorization"] = `Bearer ${token}`;');
      lines.push("      return;");
      lines.push("    }");
    }
  }
  // tokenProvider — always
  lines.push('    if (auth.kind === "tokenProvider") {');
  lines.push("      const token = await auth.getToken();");
  lines.push('      headers["Authorization"] = `Bearer ${token}`;');
  lines.push("    }");
  return lines;
}
