import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type GetBlob = (path: string) => Promise<Buffer | null>;

interface ParsedRef {
  readonly file: string;
  readonly fragment: string | null;
}

export async function bundleOpenapiRefs(
  rootBytes: Buffer,
  rootPath: string,
  getBlob: GetBlob,
): Promise<Buffer> {
  const rootDoc = parseDoc(rootBytes);
  const resolved = await resolveRefs(
    rootDoc,
    dirOf(rootPath),
    getBlob,
    new Set<string>(),
  );
  return Buffer.from(stringifyYaml(resolved), "utf8");
}

async function resolveRefs(
  node: unknown,
  baseDir: string,
  getBlob: GetBlob,
  stack: ReadonlySet<string>,
): Promise<unknown> {
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    for (const item of node) {
      out.push(await resolveRefs(item, baseDir, getBlob, stack));
    }
    return out;
  }
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  const refVal = obj["$ref"];
  if (typeof refVal === "string" && isExternalRef(refVal)) {
    return resolveExternalRef(refVal, baseDir, getBlob, stack, obj);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = await resolveRefs(v, baseDir, getBlob, stack);
  }
  return out;
}

async function resolveExternalRef(
  ref: string,
  baseDir: string,
  getBlob: GetBlob,
  stack: ReadonlySet<string>,
  original: Record<string, unknown>,
): Promise<unknown> {
  const parsed = parseRefString(ref);
  const absPath = normalizePath(joinPath(baseDir, parsed.file));
  if (stack.has(absPath)) return original;
  const bytes = await getBlob(absPath);
  if (bytes === null) return original;
  const doc = parseDoc(bytes);
  const targeted = parsed.fragment !== null
    ? extractFragment(doc, parsed.fragment)
    : doc;
  if (targeted === undefined) return original;
  const nextStack = new Set<string>(stack);
  nextStack.add(absPath);
  return resolveRefs(targeted, dirOf(absPath), getBlob, nextStack);
}

function isExternalRef(ref: string): boolean {
  if (ref.startsWith("#")) return false;
  if (/^https?:\/\//.test(ref)) return false;
  return true;
}

function parseRefString(ref: string): ParsedRef {
  const hashIdx = ref.indexOf("#");
  if (hashIdx === -1) return { file: ref, fragment: null };
  return {
    file: ref.slice(0, hashIdx),
    fragment: ref.slice(hashIdx + 1),
  };
}

function parseDoc(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  return parseYaml(text) as unknown;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function joinPath(base: string, rel: string): string {
  if (base === "") return rel;
  return `${base}/${rel}`;
}

function normalizePath(path: string): string {
  const parts = path.split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      out.pop();
      continue;
    }
    out.push(p);
  }
  return out.join("/");
}

function extractFragment(doc: unknown, fragment: string): unknown {
  const segments = fragment.split("/").filter((s) => s !== "");
  let cur: unknown = doc;
  for (const seg of segments) {
    if (cur === null || typeof cur !== "object") return undefined;
    const key = decodeJsonPointerSegment(seg);
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function decodeJsonPointerSegment(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~");
}
