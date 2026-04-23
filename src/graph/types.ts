// skillship capability graph — TypeScript types.
// SQL mapping: src/graph/schema.sql
// Design context: docs/ARCHITECTURE.md

export type NodeKind =
  | "product"
  | "surface"
  | "operation"
  | "parameter"
  | "response_shape"
  | "resource"
  | "auth_scheme"
  | "example"
  | "doc_page"
  | "override_note"
  | "source"
  | "release";

export type SurfaceKind =
  | "rest"
  | "grpc"
  | "cli"
  | "mcp"
  | "sdk"
  | "docs"
  | "llms_txt";

export type ClaimConfidence =
  | "attested"
  | "derived"
  | "inferred"
  | "conflicted";

export interface Provenance {
  source_id: string;
  source_url: string;
  surface: SurfaceKind;
  extractor: string;
  extracted_at: string;
  span?: {
    start: number;
    end: number;
    path?: string;
  };
  confidence: ClaimConfidence;
}

export interface Claim<T> {
  value: T;
  provenance: Provenance;
  overridden_by?: string;
}

export interface ConflictedClaim<T> {
  chosen: Claim<T>;
  rejected: Claim<T>[];
  rationale: string;
}

export type Claimed<T> = Claim<T> | ConflictedClaim<T>;

// ---- Node shapes ---------------------------------------------------

export interface ProductNode {
  id: string;
  kind: "product";
  name: Claimed<string>;
  domain: Claimed<string>;
  github_org?: Claimed<string>;
  tagline?: Claimed<string>;
}

export interface SurfaceNode {
  id: string;
  kind: "surface";
  product_id: string;
  surface: SurfaceKind;
  version?: Claimed<string>;
  base_url?: Claimed<string>;
  spec_url?: Claimed<string>;
}

export type ParameterLocation =
  | "query"
  | "path"
  | "header"
  | "body"
  | "flag"
  | "positional";

export interface OperationNode {
  id: string;
  kind: "operation";
  surface_id: string;
  resource_id?: string;
  method?: Claimed<string>;
  path_or_name: Claimed<string>;
  summary?: Claimed<string>;
  description?: Claimed<string>;
  is_destructive?: Claimed<boolean>;
  is_idempotent?: Claimed<boolean>;
  is_read_only?: Claimed<boolean>;
  opens_world?: Claimed<boolean>;
  task_support?: Claimed<string[]>;
  auth_scheme_ids?: Claimed<string[]>;
  deprecated?: Claimed<boolean>;
}

export interface ParameterNode {
  id: string;
  kind: "parameter";
  operation_id: string;
  name: Claimed<string>;
  location: Claimed<ParameterLocation>;
  type: Claimed<string>;
  required: Claimed<boolean>;
  description?: Claimed<string>;
  default?: Claimed<unknown>;
  enum?: Claimed<unknown[]>;
  sensitive?: Claimed<boolean>;
}

export interface ResponseShapeNode {
  id: string;
  kind: "response_shape";
  operation_id: string;
  status_code?: Claimed<number>;
  content_type?: Claimed<string>;
  schema_ref?: Claimed<string>;
  error_codes?: Claimed<string[]>;
}

export type LifecycleVerb = "create" | "read" | "update" | "delete" | "list";

export interface ResourceNode {
  id: string;
  kind: "resource";
  product_id: string;
  name: Claimed<string>;
  description?: Claimed<string>;
  lifecycle?: Claimed<LifecycleVerb[]>;
}

export type AuthType =
  | "oauth2"
  | "apiKey"
  | "bearer"
  | "basic"
  | "mutualTLS"
  | "custom";

export interface AuthSchemeNode {
  id: string;
  kind: "auth_scheme";
  product_id: string;
  type: Claimed<AuthType>;
  location?: Claimed<"header" | "query" | "cookie">;
  param_name?: Claimed<string>;
  flows?: Claimed<unknown>;
}

export interface ExampleNode {
  id: string;
  kind: "example";
  operation_id: string;
  language: Claimed<string>;
  code: Claimed<string>;
  narrative?: Claimed<string>;
  validated_against?: Claimed<string>;
}

export interface DocPageNode {
  id: string;
  kind: "doc_page";
  product_id: string;
  title: Claimed<string>;
  url: Claimed<string>;
  category?: Claimed<string>;
  content_hash: Claimed<string>;
  last_modified?: Claimed<string>;
  tier?: Claimed<"core" | "optional">;
}

export interface OverrideNoteNode {
  id: string;
  kind: "override_note";
  target_node_id: string;
  target_field: string;
  rationale: string;
  authored_by: string;
  authored_at: string;
  supersedes?: string;
}

export interface SourceNode {
  id: string;
  kind: "source";
  surface: SurfaceKind;
  url: string;
  content_type: string;
  fetched_at: string;
  bytes: number;
  cache_path: string;
}

export interface ReleaseNode {
  id: string;
  kind: "release";
  product_id: string;
  tag: string;
  released_at: string;
  source_ids: string[];
}

export type Node =
  | ProductNode
  | SurfaceNode
  | OperationNode
  | ParameterNode
  | ResponseShapeNode
  | ResourceNode
  | AuthSchemeNode
  | ExampleNode
  | DocPageNode
  | OverrideNoteNode
  | SourceNode
  | ReleaseNode;

// ---- Edges ---------------------------------------------------------

export type EdgeKind =
  | "exposes"
  | "has_operation"
  | "has_parameter"
  | "returns"
  | "acts_on"
  | "auth_requires"
  | "documented_by"
  | "illustrated_by"
  | "same_capability";

export interface Edge {
  id: string;
  kind: EdgeKind;
  from_node_id: string;
  to_node_id: string;
  rationale?: Claim<string>;
}
