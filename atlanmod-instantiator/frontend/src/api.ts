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
  stats: { objects: number; external: number; edges: number; containments: number; byType: Record<string, number> };
}

export interface ClassInfo {
  id: string;
  name: string;
  abstract: boolean;
  supertypes: string[];
  attributes: number;
  references: number;
  containments: number;
  rootCandidate: boolean;
}

export interface MetamodelInfo {
  file: string;
  status: 'ok' | 'invalid' | 'error';
  errors: string[];
  warnings: string[];
  packages: { name: string; nsURI: string }[];
  classes: ClassInfo[];
  /** OCL invariants that apply to this metamodel (from every *.ocl file in metamodels/ whose context classes match). */
  constraints: { context: string; name: string; expression: string }[];
  oclErrors: string[];
}

export interface GenerateRequest {
  metamodel: string;
  size: number;
  degree: number;
  /** +/- tolerance around size and degree, as a fraction (0.1 = 10 %). */
  sizeVariation: number;
  degreeVariation: number;
  seed?: number;
  excluded: string[];
  roots: string[];
}

export interface OclConstraint {
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
  constraints: OclConstraint[];
  fileErrors: string[];
}

export interface GenerateOk {
  ok: true;
  seed: number;
  requested: number;
  objects: number;
  applied: { elements: number[]; properties: number[]; references: number[]; values: number[] };
  byClass: Record<string, number>;
  graph: Graph | null;
  graphSkipped: string | null;
  xmi: string | null;
  xmiBytes: number;
  diagnosis: { ok: boolean; errors: number; messages: string[] } | null;
  ocl: OclResult | null;
  warnings: number;
  log: { level: string; message: string }[];
  millis: { generate: number; total: number };
}

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
