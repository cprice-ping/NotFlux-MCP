// ---------------------------------------------------------------------------
// Shared TypeScript types for the NotFlux application
// ---------------------------------------------------------------------------

/** Media metadata returned by GET /media/metadata */
export interface MediaItem {
  id: string;
  title?: string;
  description?: string;
  rating?: string;       // e.g. "PG", "PG-13", "R", "TV-G"
  genre?: string;
  year?: number;
  duration?: string;
  thumbnailUrl?: string;
  drm?: string;          // DRM token for content access
  [key: string]: unknown; // tolerate additional mock fields
}

/** Account info returned by GET /accounts/:id */
export interface AccountInfo {
  id: string;
  name?: string;
  email?: string;
  subscriptionTier?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Agent / chat types
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  streaming?: boolean; // true while the response is being streamed in
  error?: boolean;     // true if this message represents an error
}

export interface HitlChallenge {
  id: string;
  reason: string;
  message?: string;
  responseSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  metadata?: {
    event_type?: string;
    transaction_id?: string;
    [key: string]: unknown;
  };
}

export interface AgUiRunFinishedEvent {
  type: 'RUN_FINISHED';
  threadId?: string;
  runId?: string;
  outcome?:
    | { type: 'success' }
    | {
        type: 'interrupt';
        interrupts: HitlChallenge[];
      };
}

// ---------------------------------------------------------------------------
// Vertex AI Agent Engine event shapes (NDJSON stream from backend)
// Multiple formats depending on ADK version / agent config
// ---------------------------------------------------------------------------

export interface AgentStreamEvent {
  // AG-UI lifecycle / content events
  type?: string;
  threadId?: string;
  runId?: string;
  outcome?: AgUiRunFinishedEvent['outcome'];
  messageId?: string;
  delta?: string;
  role?: string;

  // ADK streaming part format
  content?: {
    parts?: Array<{ text?: string }>;
    role?: string;
  };
  // LangGraph / older ADK
  output?: string;
  text?: string;
  // Error
  error?: string;
  code?: number;
  message?: string;
  // Terminal sentinel forwarded by backend
  done?: boolean;
}
