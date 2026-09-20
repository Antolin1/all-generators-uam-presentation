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
  /** what is wrong with this object (rules it breaks, structure...) */
  problems?: string[];
  /** line of the LLM's script where the object was created */
  line?: number | null;
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
  superTypes: string[];
}

export interface Setup {
  apiKeyConfigured: boolean;
  canGenerate: boolean;
  defaultModel: string;
  modelSuggestions: string[];
  metamodelLoaded: boolean;
  metamodelFilename?: string;
  constraintCount?: number;
  classes?: ClassInfo[];
  rootCandidates?: string[];
  moduleCode?: string;
  interpreterOnly?: string[];
}

export interface Status {
  metamodel: { loaded: boolean; filename?: string; packageName?: string; classes?: unknown[] };
  constraints: { text: string; error: string | null; warnings: string[]; constraints: { name: string; contextClass: string }[] };
}

export interface Example {
  id: string;
  title: string;
  filename: string;
  ecore: string;
  ocl: string;
}

export type Category = 'syntax' | 'import' | 'forbidden' | 'contract' | 'runtime' | 'timeout' | 'structure' | 'constraint' | 'scope';

export interface Issue {
  category: Category;
  message: string;
  /** line of the LLM's script (the failing line, or where the implicated object was created) */
  line: number | null;
  code: string | null;
  object: number | null;
  /** line of the Pydantic module where the broken rule is */
  moduleLine: number | null;
}

export interface ScopeRow {
  class: string;
  min: number | null;
  max: number | null;
  actual: number;
  ok: boolean;
}

export interface Attempt {
  n: number;
  status: 'generating' | 'validating' | 'ok' | 'failed';
  code: string | null;
  raw?: string;
  issues: Issue[];
  feedback: string | null;
  graph?: Graph | null;
  scope?: ScopeRow[];
  stats?: { objects?: number; created?: number };
  stdout?: string;
  hasXmi?: boolean;
  seconds?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  /** Earlier attempts (their answer and feedback) that the LLM saw in this attempt's messages. */
  context?: number[];
}

/** The first messages of every attempt: the system prompt and the user prompt (module + scope). */
export interface Prompt {
  system: string;
  task: string;
}

export interface Job {
  id: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  phase: string;
  error: string | null;
  model: string;
  maxIterations: number;
  prompt: Prompt;
  attempts: Attempt[];
  usage: { input_tokens: number; output_tokens: number };
  seconds: number;
  valid: boolean;
}

export interface GeneratePayload {
  rootClass: string;
  classBounds: Record<string, { min?: number; max?: number }>;
  totalMin: number | null;
  totalMax: number | null;
  model: string | null;
  maxIterations: number;
}

/** An error the backend explained (FastAPI's {detail}). */
export class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError('No se puede contactar con el backend.');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`Respuesta inesperada del backend (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const detail = (body as { detail?: unknown }).detail;
    throw new ApiError(typeof detail === 'string' ? detail : `Error HTTP ${response.status}`);
  }
  return body as T;
}

const json = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });

export const api = {
  status: () => request<Status>('/api/status'),
  setup: () => request<Setup>('/api/llm/setup'),
  examples: () => request<Example[]>('/api/examples'),
  uploadMetamodel: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ loaded: boolean; filename: string }>('/api/metamodel', { method: 'POST', body: form });
  },
  setConstraints: (text: string) => request<Status['constraints']>('/api/constraints', json({ text })),
  prompt: (payload: GeneratePayload) => request<Prompt>('/api/llm/prompt', json(payload)),
  generate: (payload: GeneratePayload) => request<{ jobId: string }>('/api/llm/generate', json(payload)),
  job: (id: string) => request<Job>(`/api/llm/jobs/${id}`),
  cancel: (id: string) => request<{ ok: boolean }>(`/api/llm/jobs/${id}/cancel`, json({})),
  xmiUrl: (id: string, n: number) => `/api/llm/jobs/${id}/attempts/${n}/xmi`,
  xmi: async (id: string, n: number): Promise<string> => {
    const response = await fetch(`/api/llm/jobs/${id}/attempts/${n}/xmi`);
    if (!response.ok) throw new ApiError('Ese intento no tiene un modelo exportable.');
    return response.text();
  },
};
