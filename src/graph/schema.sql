-- skillship capability graph — SQLite schema.
-- TypeScript mapping: src/graph/types.ts
-- Design context: docs/ARCHITECTURE.md

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------
-- Sources: content-addressable, one row per fetched artifact.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sources (
    id           TEXT PRIMARY KEY,         -- sha256 of bytes
    surface      TEXT NOT NULL,            -- rest|grpc|cli|mcp|sdk|docs|llms_txt
    url          TEXT NOT NULL,
    content_type TEXT NOT NULL,
    fetched_at   TEXT NOT NULL,            -- ISO8601
    bytes        INTEGER NOT NULL,
    cache_path   TEXT NOT NULL             -- .skillship/sources/<sha256>.<ext>
);

CREATE INDEX IF NOT EXISTS idx_sources_surface ON sources(surface);
CREATE INDEX IF NOT EXISTS idx_sources_url     ON sources(url);

-- ---------------------------------------------------------------
-- Nodes: one row per graph node. Field values live in `claims`.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nodes (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,              -- NodeKind
    parent_id  TEXT,                       -- e.g. surface.product_id
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_kind   ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);

-- ---------------------------------------------------------------
-- Claims: per-field provenance. Multiple rows per (node, field)
-- when sources conflict; exactly one has chosen=1.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
    id                  TEXT PRIMARY KEY,
    node_id             TEXT NOT NULL REFERENCES nodes(id)   ON DELETE CASCADE,
    field               TEXT NOT NULL,
    value_json          TEXT NOT NULL,
    source_id           TEXT NOT NULL REFERENCES sources(id),
    extractor           TEXT NOT NULL,    -- "openapi@3", "openref-cli@1"
    extracted_at        TEXT NOT NULL,
    span_start          INTEGER,
    span_end            INTEGER,
    span_path           TEXT,             -- JSONPath / XPath into source
    confidence          TEXT NOT NULL,    -- attested|derived|inferred|conflicted
    chosen              INTEGER NOT NULL DEFAULT 0,
    rejection_rationale TEXT
);

CREATE INDEX IF NOT EXISTS idx_claims_node_field ON claims(node_id, field);
CREATE INDEX IF NOT EXISTS idx_claims_source     ON claims(source_id);
CREATE INDEX IF NOT EXISTS idx_claims_chosen     ON claims(node_id, field, chosen);

-- ---------------------------------------------------------------
-- Edges: typed, directed, optionally provenance-bearing.
-- Structural edges (e.g. surface→product) have NULL source_id;
-- derived edges (same_capability) carry a source_id + rationale.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edges (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    from_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    source_id    TEXT REFERENCES sources(id),
    rationale    TEXT,
    created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node_id, kind);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_node_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS uq_edges_triple
    ON edges(from_node_id, to_node_id, kind);

-- ---------------------------------------------------------------
-- Overrides: human decisions that win over any machine claim.
-- Mirrored from .skillship/overlays/*.yaml. Rationale is REQUIRED.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS overrides (
    id           TEXT PRIMARY KEY,
    node_id      TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    field        TEXT NOT NULL,
    value_json   TEXT NOT NULL,
    rationale    TEXT NOT NULL,
    authored_by  TEXT NOT NULL,
    authored_at  TEXT NOT NULL,
    supersedes   TEXT REFERENCES overrides(id),
    active       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_overrides_node_field
    ON overrides(node_id, field, active);

-- ---------------------------------------------------------------
-- Releases: frozen sets of sources for reproducible rebuilds.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS releases (
    id          TEXT PRIMARY KEY,          -- e.g. "supabase@v2.3.1"
    product_id  TEXT NOT NULL REFERENCES nodes(id),
    tag         TEXT NOT NULL,
    released_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS release_sources (
    release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    source_id  TEXT NOT NULL REFERENCES sources(id),
    PRIMARY KEY (release_id, source_id)
);

-- ---------------------------------------------------------------
-- Snapshots: registry of point-in-time graph copies.
-- Each lives at its own .skillship/snapshots/<ts>.sqlite.
-- ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS snapshots (
    id         TEXT PRIMARY KEY,           -- ISO8601 timestamp
    path       TEXT NOT NULL,
    node_count INTEGER NOT NULL,
    edge_count INTEGER NOT NULL,
    reason     TEXT                        -- "pre-refresh", "pre-release", ...
);
