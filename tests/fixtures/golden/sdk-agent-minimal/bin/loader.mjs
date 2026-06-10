import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(".") || !specifier.endsWith(".js")) {
    return nextResolve(specifier, context);
  }
  const resolved = new URL(specifier, context.parentURL ?? import.meta.url);
  const jsPath = fileURLToPath(resolved);
  if (!existsSync(jsPath)) {
    const tsPath = jsPath.replace(/\.js$/, ".ts");
    if (existsSync(tsPath)) {
      return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
    }
  }
  return nextResolve(specifier, context);
}
