export interface Range {
  offset: number;
  length: number;
  startLine: number;
  endLine: number;
}

export interface RuleItem {
  index: number;
  feature?: string | null;
  op?: string;
  ref?: boolean;
  value: string | null;
  times?: string | null;
  priority?: string | null;
  range: Range | null;
}

export interface RuleInfo {
  name: string;
  kind: 'class' | 'alter';
  eClass: string | null;
  params: string[];
  entry: boolean;
  range: Range | null;
  items: RuleItem[];
}

export interface Issue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  line: number;
  column: number;
  offset: number;
  length: number;
}

export interface GeneratorInfo {
  name: string;
  package: string | null;
  metamodel: string | null;
  params: { name: string; type: string }[];
}

export interface AnalyzeResponse {
  ok: boolean;
  issues: Issue[];
  generator: GeneratorInfo | null;
  rules: RuleInfo[];
}

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
  root: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    objects: number;
    external: number;
    edges: number;
    containments: number;
    byType: Record<string, number>;
  };
}

export interface TraceNode {
  id: string;
  kind: 'rule' | 'feature' | 'alt';
  rule: string;
  index?: number;
  count?: number;
  params?: string[];
  object?: string | null;
  children: TraceNode[];
}

export interface Trace {
  roots: TraceNode[];
  resolutions: { rule: string; index: number; source: string | null; target: string | null }[];
}

export interface GenerateOk {
  ok: true;
  seed: number;
  maxObjects: number;
  issues: Issue[];
  generator: GeneratorInfo;
  rules: RuleInfo[];
  graph: Graph;
  trace: Trace;
  java: string;
  millis: { prepare: number; generate: number };
}

export interface GenerateFail {
  ok: false;
  phase: 'validation' | 'compile' | 'run' | 'server';
  error: string;
  issues: Issue[];
  generator: GeneratorInfo | null;
  rules: RuleInfo[];
}

export interface Example {
  id: string;
  title: string;
  source: string;
}

export interface MetamodelInfo {
  file: string;
  builtin: boolean;
  uri: string;
  status: 'ok' | 'error';
  error: string | null;
  packages: { name: string; nsURI: string }[];
  classes: number;
}

export interface MetamodelList {
  directory: string;
  items: MetamodelInfo[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Error('No se puede contactar con el backend.');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Respuesta inesperada del backend (HTTP ${response.status}).`);
  }
  return body as T;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export const api = {
  health: () => request<{ ok: boolean; ready: boolean }>('/api/health'),
  examples: () => request<Example[]>('/api/examples'),
  metamodels: () => request<MetamodelList>('/api/metamodels'),
  reloadMetamodels: () => post<MetamodelList>('/api/metamodels', { reload: true }),
  template: (file: string) => post<{ ok: boolean; source?: string; error?: string }>('/api/template', { file }),
  analyze: (source: string) => post<AnalyzeResponse>('/api/analyze', { source }),
  generate: (payload: {
    source: string;
    seed?: number;
    maxObjects: number;
    args: Record<string, string>;
  }) => post<GenerateOk | GenerateFail>('/api/generate', payload),
};
