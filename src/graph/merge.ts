import type { Database as Sqlite3Database } from "better-sqlite3";
import {
  listActiveOverrides,
  listClaimsForField,
  setClaimChosen,
  type ClaimRow,
  type OverrideRow,
} from "./repo.js";
import type { ClaimConfidence } from "./types.js";

export interface PrecedenceConfig {
  readonly extractor: Readonly<Record<string, number>>;
}

export const DEFAULT_PRECEDENCE: PrecedenceConfig = {
  extractor: {
    "openapi@3": 100,
    "swagger@2": 95,
    "mcp-well-known@1": 90,
    "openref-cli@1": 80,
    "openref-sdk@1": 60,
    "zod-ast@1": 55,
    "llms-txt@1": 40,
    "sitemap@1": 30,
    "docs@1": 20,
  },
};

const CONFIDENCE_RANK: Readonly<Record<ClaimConfidence, number>> = {
  attested: 4,
  derived: 3,
  inferred: 2,
  conflicted: 1,
};

export type MergeDecision =
  | { kind: "none" }
  | { kind: "override"; override: OverrideRow }
  | { kind: "winner"; chosen: ClaimRow; rejected: ClaimRow[] }
  | { kind: "conflicted"; candidates: ClaimRow[] };

function scoreClaim(c: ClaimRow, cfg: PrecedenceConfig): number {
  const base = cfg.extractor[c.extractor] ?? 0;
  return base * 10 + CONFIDENCE_RANK[c.confidence];
}

function markConflicted(db: Sqlite3Database, id: string): void {
  db.prepare("UPDATE claims SET confidence = 'conflicted' WHERE id = ?").run(
    id,
  );
}

function persistOverrideDecision(
  db: Sqlite3Database,
  claims: ClaimRow[],
  overrideId: string,
): void {
  for (const c of claims) {
    setClaimChosen(db, c.id, 0, `superseded by override ${overrideId}`);
  }
}

function persistWinner(
  db: Sqlite3Database,
  chosen: ClaimRow,
  rejected: ClaimRow[],
): void {
  setClaimChosen(db, chosen.id, 1, null);
  for (const c of rejected) {
    setClaimChosen(db, c.id, 0, `lower precedence than ${chosen.extractor}`);
  }
}

function persistTie(
  db: Sqlite3Database,
  all: ClaimRow[],
  tiedIds: ReadonlySet<string>,
): void {
  for (const c of all) {
    if (tiedIds.has(c.id)) {
      setClaimChosen(
        db,
        c.id,
        0,
        `tied at top rank with ${tiedIds.size - 1} other claim(s)`,
      );
      markConflicted(db, c.id);
    } else {
      setClaimChosen(db, c.id, 0, "lower precedence than tied winners");
    }
  }
}

export function chooseWinningClaim(
  db: Sqlite3Database,
  nodeId: string,
  field: string,
  cfg: PrecedenceConfig = DEFAULT_PRECEDENCE,
): MergeDecision {
  const overrides = listActiveOverrides(db, nodeId, field);
  const claims = listClaimsForField(db, nodeId, field);

  if (overrides.length > 0) {
    const winner = overrides[0]!;
    persistOverrideDecision(db, claims, winner.id);
    return { kind: "override", override: winner };
  }
  if (claims.length === 0) {
    return { kind: "none" };
  }

  const scored = claims.map((c) => ({ c, s: scoreClaim(c, cfg) }));
  const max = Math.max(...scored.map((x) => x.s));
  const top = scored.filter((x) => x.s === max).map((x) => x.c);

  if (top.length === 1) {
    const chosen = top[0]!;
    const rejected = claims.filter((c) => c.id !== chosen.id);
    persistWinner(db, chosen, rejected);
    return { kind: "winner", chosen, rejected };
  }

  const tiedIds = new Set(top.map((c) => c.id));
  persistTie(db, claims, tiedIds);
  return { kind: "conflicted", candidates: top };
}
