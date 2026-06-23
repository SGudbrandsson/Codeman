export interface TranscriptStateLite {
  isComplete: boolean;
  toolExecuting: boolean;
  lastAssistantMessage: string | null;
}
export interface DigestSubagent {
  name: string;
  doing: string | null;
  status: string;
}
export interface DigestInput {
  id: string;
  name: string;
  status: string;
  transcript: TranscriptStateLite | null;
  subagents: Array<{ description?: string; status: string; agentId: string; lastActivityAt: number }>;
  phase: string | null;
  lastActivityAt: number | null;
}
export interface Digest {
  id: string;
  name: string;
  status: 'working' | 'idle' | 'stopped';
  done: boolean;
  toolExecuting: boolean;
  lastAssistantMessage: string | null;
  subagents: { count: number; active: DigestSubagent[] };
  phase: string | null;
  lastActivityAt: number | null;
}

export function mapStatus(raw: string): 'working' | 'idle' | 'stopped' {
  if (raw === 'busy') return 'working';
  if (raw === 'idle') return 'idle';
  return 'stopped';
}

export function buildDigest(input: DigestInput): Digest {
  const status = mapStatus(input.status);
  const t = input.transcript;
  const active = input.subagents
    .filter((s) => s.status !== 'completed')
    .map((s) => ({ name: s.agentId, doing: s.description ?? null, status: s.status }));
  return {
    id: input.id,
    name: input.name,
    status,
    done: Boolean(t?.isComplete && !t.toolExecuting && status === 'idle'),
    toolExecuting: Boolean(t?.toolExecuting),
    lastAssistantMessage: t?.lastAssistantMessage ?? null,
    subagents: { count: active.length, active },
    phase: input.phase,
    lastActivityAt: input.lastActivityAt,
  };
}
