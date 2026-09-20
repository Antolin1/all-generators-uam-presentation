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
  /** step of the generation that created it (0: the root) */
  step?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  name: string;
  kind: 'containment' | 'reference';
  step?: number;
}

export interface Graph {
  root: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { objects: number; external: number; edges: number; containments: number; byType: Record<string, number> };
}

export interface Dataset {
  id: string;
  label: string;
  description: string;
  available: boolean;
  train: number;
  test: number;
  root: string;
  metamodel: string;
  complex: boolean;
  constraints: boolean;
  pretrained: string | null;
}

export interface TrainParams {
  epochs: number;
  k: number;
  hidden_dim: number;
  lr: number;
  batch_size: number;
  patience: number;
  seed: number;
  complex: boolean;
  pool?: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  source: 'pretrained' | 'trained';
  dataset: string;
  status: 'done' | 'training' | 'failed' | 'cancelled' | 'interrupted';
  ready: boolean;
  complex: boolean;
  params: Partial<TrainParams>;
  losses: number[];
  created: number | null;
  seconds: number | null;
  error?: string | null;
  device?: string | null;
  graphs?: number | null;
  skipped?: number | null;
}

export interface Job {
  id: string;
  name: string;
  dataset: string;
  status: 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';
  phase: 'starting' | 'loading' | 'decomposition' | 'training' | 'done';
  params: TrainParams;
  mc_done: number;
  k: number;
  epoch: number;
  epochs: number;
  losses: number[];
  graphs: number | null;
  skipped: number | null;
  device: string | null;
  device_name: string | null;
  error: string | null;
  elapsed: number;
  log: string[];
}

export interface GenStep {
  index: number;
  op: string;
  nodes: string[];
  edges: string[];
}

export interface GenerateOk {
  ok: true;
  seed: number;
  max_size: number;
  stop: 'size' | 'finished' | 'stuck';
  graph: Graph;
  steps: GenStep[];
  failed_attempts: number;
  consistency: { consistent: boolean; checks: { id: string; label: string; ok: boolean }[] } | null;
  novel: boolean | null;
  xmi: string | null;
  dataset: string;
  model: { id: string; name: string };
  millis: number;
}

export interface Failure {
  ok: false;
  error: string;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
  health: () => request<{ ok: boolean; ready: boolean; device: string | null; gpu: string | null }>('/api/health'),
  datasets: () => request<{ datasets: Dataset[]; defaults: TrainParams; limits: Record<string, [number, number]> }>('/api/datasets'),
  models: () => request<{ models: ModelInfo[] }>('/api/models'),
  deleteModel: (id: string) => request<{ ok: boolean; error?: string }>('/api/models/delete', { id }),
  job: () => request<{ job: Job | null }>('/api/train'),
  train: (payload: Partial<TrainParams> & { name: string; dataset: string }) => request<{ ok: boolean; id?: string; error?: string }>('/api/train', payload),
  cancel: () => request<{ ok: boolean }>('/api/train/cancel', {}),
  generate: (payload: { model: string; max_size: number; seed?: number }) => request<GenerateOk | Failure>('/api/generate', payload),
};
