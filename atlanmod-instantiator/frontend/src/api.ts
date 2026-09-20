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
}

export interface GenerateRequest {
  metamodel: string;
  size: number;
  degree: number;
  seed?: number;
  excluded: string[];
  roots: string[];
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
