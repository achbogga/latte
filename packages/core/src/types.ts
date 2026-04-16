export type ProviderName = "claude" | "codex";

export interface ProviderCommandConfig {
  argsTemplate: string[];
  command: string;
  env?: Record<string, string> | undefined;
}

export interface LatteConfig {
  context: {
    include: string[];
    maxCharsPerFile: number;
    maxFiles: number;
  };
  exports: string[];
  ignore: string[];
  name: string;
  namespace: string;
  providers: {
    claude: ProviderCommandConfig;
    codex: ProviderCommandConfig;
    default: ProviderName;
  };
  rulesFiles: string[];
}

export interface ContextArtifact {
  content: string;
  contentHash: string;
  path: string;
  size: number;
}

export interface ContextPack {
  artifacts: ContextArtifact[];
  generatedAt: string;
  projectKey: string;
  repo: {
    branch: string | null;
    root: string;
    sha: string | null;
  };
  rules: string[];
  summary: string[];
}

export interface SessionEvent {
  payload: Record<string, unknown>;
  timestamp: string;
  type: string;
}

export interface SessionRecord {
  cacheKey: string;
  createdAt: string;
  id: string;
  lastPrompt?: string;
  lastProviderCommand?: string[];
  metadata: Record<string, unknown>;
  projectKey: string;
  provider: ProviderName;
  providerSessionId?: string;
  updatedAt: string;
  events: SessionEvent[];
}

export type MemoryKind = "episodic" | "fact" | "policy" | "procedure";

export interface MemoryItem {
  confidence: number;
  content: string;
  createdAt: string;
  freshnessTtlSeconds?: number;
  id: string;
  kind: MemoryKind;
  metadata: Record<string, unknown>;
  namespace: string;
  provenance: string[];
}

export interface RetrievalHit {
  excerpt: string;
  id: string;
  metadata: Record<string, unknown>;
  path: string;
  score: number;
}

export interface LaunchPlan {
  command: string[];
  promptFile: string;
  promptPreview: string;
  provider: ProviderName;
  session: SessionRecord;
}

export type AgentDaemonStatus =
  | "backing_off"
  | "idle"
  | "paused"
  | "running"
  | "starting"
  | "stopped"
  | "stopping";

export type AgentTaskStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "queued"
  | "running";

export interface AgentResourcePolicy {
  heartbeatTtlMs: number;
  maxPeerAgents: number;
  maxRetryBackoffMs: number;
  maxTaskAttempts: number;
  maxTrackedEvents: number;
  maxTrackedFinishedTasks: number;
  minFreeMemoryRatio: number;
  peerLoadPenalty: number;
  pollIntervalMs: number;
  retryBackoffMs: number;
  softLoadPerCpu: number;
}

export interface AgentResourceSnapshot {
  cpuCount: number;
  freeMemoryBytes: number;
  freeMemoryRatio: number;
  load15: number;
  load1: number;
  load5: number;
  peerAgentCount: number;
  sampledAt: string;
}

export interface AgentResourceAssessment {
  allowed: boolean;
  reasons: string[];
}

export interface AgentTask {
  attempts: number;
  completedAt?: string | undefined;
  createdAt: string;
  id: string;
  lastError?: string | undefined;
  lastExitCode?: number | null | undefined;
  logPath?: string | undefined;
  nextAttemptAt: string;
  outputPath?: string | undefined;
  passthroughArgs: string[];
  priority: number;
  prompt: string;
  provider: ProviderName;
  runPath?: string | undefined;
  sessionId?: string | undefined;
  startedAt?: string | undefined;
  status: AgentTaskStatus;
  updatedAt: string;
}

export interface AgentActiveRun {
  command: string[];
  exitPath: string;
  logPath: string;
  outputPath: string;
  pid: number;
  promptPath: string;
  runPath: string;
  sessionId: string;
  startedAt: string;
  taskId: string;
}

export type AgentCommand =
  | {
      createdAt: string;
      id: string;
      payload: {
        passthroughArgs?: string[];
        priority?: number;
        prompt: string;
        provider?: ProviderName;
        sessionId?: string;
      };
      type: "submit";
    }
  | {
      createdAt: string;
      id: string;
      payload: {
        taskId: string;
      };
      type: "cancel";
    }
  | {
      createdAt: string;
      id: string;
      payload: {
        reason?: string;
      };
      type: "pause";
    }
  | {
      createdAt: string;
      id: string;
      payload: Record<string, never>;
      type: "resume";
    }
  | {
      createdAt: string;
      id: string;
      payload: Record<string, never>;
      type: "stop";
    };

export interface AgentRegistryEntry {
  heartbeatAt: string;
  pid: number;
  projectKey: string;
}

export interface AgentDaemonState {
  activeRun?: AgentActiveRun | undefined;
  appliedCommandIds: string[];
  createdAt: string;
  events: SessionEvent[];
  heartbeatAt: string;
  lastError?: string | undefined;
  lastResourceAssessment?: AgentResourceAssessment | undefined;
  lastResourceSnapshot?: AgentResourceSnapshot | undefined;
  pauseReason?: string | undefined;
  pid?: number | undefined;
  projectKey: string;
  provider: ProviderName;
  resourcePolicy: AgentResourcePolicy;
  startedAt: string;
  status: AgentDaemonStatus;
  tasks: AgentTask[];
  updatedAt: string;
}

export type StressStepKind =
  | "approval"
  | "chat"
  | "connector"
  | "memory"
  | "provider"
  | "report"
  | "wait";

export type FailureMode =
  | "cache_corruption"
  | "connector_timeout"
  | "duplicate_delivery"
  | "network_partition"
  | "rate_limit"
  | "token_expired"
  | "worker_crash";

export interface StressStep {
  checkpointKey: string;
  endpoint: string;
  expectedArtifacts: string[];
  id: string;
  kind: StressStepKind;
  prompt: string;
}

export interface StressScenario {
  acceptedFailureModes: FailureMode[];
  description: string;
  durationHours: number;
  id: string;
  projectKey: string;
  steps: StressStep[];
  tags: string[];
}

export interface StressCheckpoint {
  completedStepIds: string[];
  lastUpdatedAt: string;
  runId: string;
}

export type StressRunStatus =
  | "awaiting_approval"
  | "blocked"
  | "completed"
  | "running"
  | "scheduled";

export interface StressRun {
  checkpoint: StressCheckpoint;
  createdAt: string;
  failures: FailureMode[];
  id: string;
  scenario: StressScenario;
  status: StressRunStatus;
}
