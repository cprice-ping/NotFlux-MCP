import { useState, useCallback, useRef } from 'react';
import type { ChatMessage, AgentStreamEvent, HitlChallenge } from '../types';

/**
 * Generate a unique ID for chat messages.
 */
function uid(): string {
  return Math.random().toString(36).slice(2, 11);
}

/** Extract the text payload from a single Agent Engine stream event */
function extractText(event: AgentStreamEvent): string {
  if (event.type === 'TEXT_MESSAGE_CONTENT' || event.type === 'TEXT_MESSAGE_CHUNK') {
    return typeof event.delta === 'string' ? event.delta : '';
  }
  if (event.content?.parts) {
    return event.content.parts.map((p) => p.text ?? '').join('');
  }
  if (typeof event.output === 'string') return event.output;
  if (typeof event.text === 'string') return event.text;
  if (typeof event.message === 'string' && typeof event.code !== 'number') {
    return event.message;
  }
  return '';
}

function extractError(event: AgentStreamEvent): string | null {
  if (event.type === 'RUN_ERROR' && typeof event.message === 'string') {
    return event.message;
  }
  if (event.error) return event.error;
  if (typeof event.message === 'string' && typeof event.code === 'number') {
    return `${event.code}: ${event.message}`;
  }
  return null;
}

/**
 * @param agentToken  The agent-scoped token (aud=google-agent, scope=agent-use).
 *                    The backend exchanges this for an MCP-audience token before
 *                    injecting it into the Vertex session state.
 *                    Falls back to the person_token when the agent resource is
 *                    not configured (VITE_PINGONE_AGENT_RESOURCE unset).
 */
export function useAgent(agentToken: string | null, userSub?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [activeHitl, setActiveHitl] = useState<HitlChallenge | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Create (or re-use) an Agent Engine session tied to the current agent token
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    if (!agentToken) return null;

    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${agentToken}`,
        },
        body: JSON.stringify({ sub: userSub ?? 'anonymous' }),
      });

      if (!res.ok) {
        console.warn('Session creation failed, will use stateless mode');
        return null;
      }

      const data = await res.json() as { sessionId: string };
      setSessionId(data.sessionId);
      return data.sessionId;
    } catch {
      console.warn('Session creation error, using stateless mode');
      return null;
    }
  }, [sessionId, agentToken, userSub]);

  const sendMessageCore = useCallback(
    async (
      text: string,
      displayText?: string,
      resume?: Array<{
        interruptId: string;
        status: 'resolved' | 'cancelled';
        payload?: Record<string, unknown>;
      }>
    ) => {
      if (!agentToken || !text.trim() || thinking) return;

      // Append user message
      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: displayText ?? text,
      };
      setMessages((prev) => [...prev, userMsg]);

      // Reserve a streaming assistant message slot
      const assistantId = uid();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        streaming: true,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      setThinking(true);

      const sid = await ensureSession();
      abortRef.current = new AbortController();

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${agentToken}`,
          },
          body: JSON.stringify({
            message: text,
            sessionId: sid,
            sub: userSub ?? 'anonymous',
            ...(resume && resume.length > 0 ? { resume } : {}),
          }),
          signal: abortRef.current.signal,
        });

        if (!res.ok || !res.body) {
          const errText = await res.text();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: `Error: ${errText}`, streaming: false, error: true }
                : m
            )
          );
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (payload === '[DONE]') break;

            try {
              const event = JSON.parse(payload) as AgentStreamEvent;
              if (
                event.type === 'RUN_FINISHED' &&
                event.outcome?.type === 'interrupt' &&
                Array.isArray(event.outcome.interrupts) &&
                event.outcome.interrupts.length > 0
              ) {
                const interrupt = event.outcome.interrupts[0] as HitlChallenge;
                setActiveHitl(interrupt);
                const msg = interrupt.message ?? 'Verification is required to continue.';
                accumulated += `\n\n🔐 ${msg}\nPlease complete verification to continue.`;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: accumulated, streaming: true }
                      : m
                  )
                );
                continue;
              }

              const error = extractError(event);
              if (error) {
                accumulated += `\n⚠️ ${error}`;
              } else {
                accumulated += extractText(event);
              }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: accumulated, streaming: true }
                    : m
                )
              );
            } catch {
              // non-JSON line — skip
            }
          }
        }

        // Mark streaming done
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, streaming: false }
              : m
          )
        );
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: `Connection error: ${String(e)}`,
                  streaming: false,
                  error: true,
                }
              : m
          )
        );
      } finally {
        setThinking(false);
        abortRef.current = null;
      }
    },
    [agentToken, thinking, ensureSession]
  );

  const sendMessage = useCallback(
    async (text: string) => {
      await sendMessageCore(text);
    },
    [sendMessageCore]
  );

  const submitHitlOtp = useCallback(
    async (otpCode: string) => {
      if (!activeHitl || !otpCode.trim()) return;

      const transactionId =
        typeof activeHitl.metadata?.transaction_id === 'string'
          ? activeHitl.metadata.transaction_id
          : activeHitl.id;
      const eventType =
        typeof activeHitl.metadata?.event_type === 'string'
          ? activeHitl.metadata.event_type
          : 'otp-required';

      const resume = [
        {
          interruptId: activeHitl.id,
          status: 'resolved' as const,
          payload: {
            transaction_id: transactionId,
            otp_code: otpCode.trim(),
            event_type: eventType,
          },
        },
      ];

      setActiveHitl(null);
      await sendMessageCore('Resuming interrupted flow.', 'Submitted verification code.', resume);
    },
    [activeHitl, sendMessageCore]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    setSessionId(null);
    setActiveHitl(null);
  }, []);

  return {
    messages,
    thinking,
    sendMessage,
    clearMessages,
    sessionId,
    activeHitl,
    submitHitlOtp,
  };
}
