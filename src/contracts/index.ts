export type SourceMode = 'replay' | 'live' | 'practice';
export type SpeakerRole = 'seller' | 'customer' | 'unknown';
export type Vec3 = [number, number, number];

export interface Turn {
  id: string;
  sessionId: string;
  speaker: string;
  role: SpeakerRole;
  atMs: number;
  text: string;
  revision: number;
  final: boolean;
  sourceMode: SourceMode;
}

export interface NameAlias {
  id: string;
  original: string;
  replacement: string;
  enabled: boolean;
  kind: 'person' | 'company';
}

export interface Topic {
  id: string;
  key: string;
  label: string;
  summary: string;
  parentId?: string;
  turnIds: string[];
  position: Vec3;
  createdAtTurnId: string;
  createdAt: number;
}

export interface Suggestion {
  id: string;
  topicId: string;
  text: string;
  rationale: string;
  turnIds: string[];
  recommended: boolean;
  kind: 'question' | 'response';
}

export interface EvidenceSource {
  id: string;
  title: string;
  passage: string;
  outcome: string;
  topicTags: string[];
  sourceLabel: string;
  fictional?: boolean;
}

export type DimensionId = 'discovery' | 'listening' | 'evidence' | 'next_step';
export interface AssessmentDimension {
  id: DimensionId;
  label: string;
  score: 0 | 1 | 2 | null;
  reason: string;
  turnIds: string[];
}

export interface Assessment {
  rubricVersion: 'branch-v1';
  throughTurnId: string;
  dimensions: AssessmentDimension[];
  total: number;
  maximum: number;
  nextPractice: string;
}

export type MapOperation =
  | { type: 'topic'; id: string; key: string; label: string; summary: string; parentId?: string; turnIds: string[] }
  | { type: 'exchange'; turnId: string; topicId: string };

export interface CoachUpdate {
  sessionId: string;
  generation: number;
  throughTurnId: string;
  operations: MapOperation[];
  suggestions: Suggestion[];
  evidenceId: string | null;
  assessment: Assessment | null;
  provider: 'astra' | 'local-preview' | 'recorded';
  model?: string;
  providerResponseId?: string;
  latencyMs?: number;
  serviceTier?: string;
}

export type MapUpdate = Pick<CoachUpdate,
  'sessionId' | 'generation' | 'throughTurnId' | 'operations' | 'provider' | 'model' | 'providerResponseId' | 'latencyMs' | 'serviceTier'>;

export interface CoachRequest {
  sessionId: string;
  generation: number;
  turns: Turn[];
  pendingTurnIds?: string[];
  activeTopicId?: string | null;
  topics: Pick<Topic, 'id' | 'key' | 'label' | 'summary'>[];
  evidence: EvidenceSource[];
}

export interface Session {
  id: string;
  title: string;
  mode: SourceMode;
  timing: 'recorded' | 'estimated';
  generation: number;
  turns: Turn[];
  topics: Topic[];
  turnTopics: Record<string, string>;
  coachHistory: CoachUpdate[];
  mapHistory?: MapUpdate[];
  suggestions: Suggestion[];
  evidence: EvidenceSource[];
  evidenceId: string | null;
  assessment: Assessment | null;
  activeTopicId: string | null;
  analyzedThroughTurnId: string | null;
  guidanceStatus: 'idle' | 'analysing' | 'ready' | 'error';
  guidanceError: string | null;
  provider: 'astra' | 'local-preview' | 'recorded' | null;
  fork?: { parentSessionId: string; throughTurnId: string; parentAssessment: Assessment | null };
}

export interface ParsedTranscript {
  title: string;
  turns: Turn[];
  durationMs: number;
  timing: 'recorded' | 'estimated';
}

export interface LiveCallbacks {
  onTurn: (turn: Turn) => void;
  onStatus: (status: 'connecting' | 'listening' | 'stopped' | 'error', message?: string) => void;
  onProviderEvent?: (event: { type: string; at: number; model?: string }) => void;
}

export interface SceneProps {
  session: Session;
  selectedTopicId: string | null;
  onSelectTopic: (id: string) => void;
  onSelectTurn: (id: string) => void;
  follow: boolean;
  onExplore: () => void;
  view: 'focus' | 'topic' | 'overview';
  cameraReset: number;
}
