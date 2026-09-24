export interface GraphNode {
  id: string;
  type: string;
  abstract: boolean;
  name: string | null;
  external: boolean;
  implicit: boolean;
  attributes: { name: string; value: string }[];
  rule: string | null;
  app: string | null;
  /** OCL invariants this object violates, as "Context.Name"; empty when it conforms. */
  problems: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  name: string;
  kind: 'containment' | 'reference';
}

export interface Graph {
  root: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { objects: number; edges: number; containments: number; byType: Record<string, number> };
}

export interface ClassInfo {
  name: string;
  abstract: boolean;
  supertypes: string[];
  /** Nothing in the metamodel contains this class: a natural candidate for the scope's root. */
  rootCandidate: boolean;
}

export interface OclConstraintInfo {
  context: string;
  name: string;
  expression: string;
}

export interface MetamodelInfo {
  file: string;
  status: 'ok' | 'invalid' | 'error';
  errors: string[];
  warnings: string[];
  classes: ClassInfo[];
  /** OCL invariants that apply to this metamodel (from every *.ocl file in metamodels/ whose context classes match). */
  constraints: OclConstraintInfo[];
  oclErrors: string[];
}

export interface GenerateRequest {
  metamodel: string;
  rootClass: string;
  classBounds: Record<string, { min?: number; max?: number }>;
  totalMin?: number | null;
  totalMax?: number | null;
  /** Picks which satisfying model the solver lands on, when the scope allows more than one; omitted (or empty) keeps the solver's deterministic default. */
  seed?: number | null;
  /** How long the solver may search before giving up, in seconds; omitted (or empty) keeps the backend's default. */
  timeoutSeconds?: number | null;
}

export interface SatStats {
  variables: number;
  clauses: number;
  millis: number;
}

export interface OclResultItem {
  context: string;
  name: string;
  expression: string;
  instances: number;
  violations: number;
  examples: string[];
  error: string | null;
}

export interface OclResult {
  ok: boolean;
  constraints: OclResultItem[];
  fileErrors: string[];
}

export interface GenerateSat {
  ok: true;
  sat: true;
  objects: number;
  byClass: Record<string, number>;
  graph: Graph;
  xmi: string;
  /** The CNF SAT4J actually solved (DIMACS text, with the named — existe/enlace — variables listed as comments). */
  cnf: string;
  diagnosis: { ok: boolean; log: string };
  ocl: OclResult;
  translatedConstraints: string[];
  untranslatedConstraints: string[];
  satStats: SatStats;
}

export interface GenerateUnsat {
  ok: true;
  sat: false;
  satStats: SatStats;
  cnf: string;
  translatedConstraints: string[];
  untranslatedConstraints: string[];
  oclFileErrors: string[];
}

export type GenerateOk = GenerateSat | GenerateUnsat;

export interface GenerateFail {
  ok: false;
  phase: 'params' | 'metamodel' | 'run' | 'server';
  error: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error('No se puede contactar con el backend.');
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(`Respuesta inesperada del backend (HTTP ${response.status}).`);
  }
}

export const api = {
  health: () => request<{ ok: boolean; ready: boolean }>('/api/health'),
  metamodels: () => request<{ directory: string; items: MetamodelInfo[] }>('/api/metamodels'),
  generate: (payload: GenerateRequest) =>
    request<GenerateOk | GenerateFail>('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
};
