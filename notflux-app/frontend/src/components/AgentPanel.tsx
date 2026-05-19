import { useRef, useEffect, useState, type KeyboardEvent } from 'react';
import type { ChatMessage, HitlChallenge } from '../types';
import { useFocusTrap } from '../hooks/useKeyboard';

interface Props {
  messages: ChatMessage[];
  thinking: boolean;
  activeHitl: HitlChallenge | null;
  onSend: (text: string) => void;
  onSubmitHitlOtp: (otpCode: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/** Render markdown-lite: bold (**text**) and line breaks */
function renderContent(content: string, streaming?: boolean) {
  const html = content
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');
  return (
    <span
      className={streaming ? 'streaming-cursor' : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const SUGGESTIONS = [
  'What can I watch tonight?',
  'Show me everything available',
  'What content is restricted for my account?',
  'Find something family-friendly',
];

export default function AgentPanel({
  messages,
  thinking,
  activeHitl,
  onSend,
  onSubmitHitlOtp,
  onClear,
  onClose,
}: Props) {
  const [input, setInput] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  // Trap focus within panel when open
  useFocusTrap(panelRef, true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  function handleSend() {
    const text = input.trim();
    if (!text) return;
    setInput('');
    onSend(text);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSubmitOtp() {
    const code = otpCode.trim();
    if (!code) return;
    onSubmitHitlOtp(code);
    setOtpCode('');
  }

  return (
    <aside
      ref={panelRef}
      className="fixed right-0 top-0 bottom-0 z-50 w-full sm:w-[400px] flex flex-col bg-bg-surface border-l border-white/10 shadow-2xl animate-slide-in"
      role="complementary"
      aria-label="AI Assistant Panel"
    >
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2.5">
          <div 
            className="w-8 h-8 rounded-full bg-gradient-to-br from-ping-blue to-ping-purple flex items-center justify-center text-white"
            aria-hidden="true"
          >
            <SparkleIcon />
          </div>
          <div>
            <p className="text-sm font-semibold text-text-primary">NotFlux AI</p>
            <p className="text-[10px] text-text-muted">Powered by Vertex AI</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onClear}
            title="New conversation"
            aria-label="Start new conversation"
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-bg-card transition-colors"
          >
            <PlusIcon />
          </button>
          <button
            onClick={onClose}
            title="Close"
            aria-label="Close AI assistant"
            className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-bg-card transition-colors"
          >
            ✕
          </button>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" role="log" aria-live="polite" aria-atomic="false">
        {messages.length === 0 && (
          <div className="space-y-4 animate-fade-in">
            <p className="text-text-muted text-sm text-center pt-4">
              Ask me anything about your NotFlux content library.
            </p>
            <div className="grid grid-cols-1 gap-2" role="group" aria-label="Suggested questions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => onSend(s)}
                  className="text-left text-sm text-text-secondary bg-bg-card hover:bg-white/5 border border-white/8 rounded-xl px-3 py-2.5 transition-colors"
                  type="button"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}
          >
            {msg.role === 'assistant' && (
              <span className="w-6 h-6 rounded-full bg-gradient-to-br from-ping-blue to-ping-purple flex items-center justify-center text-white shrink-0 mt-0.5 mr-2">
                <SparkleIcon size={10} />
              </span>
            )}
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-accent text-white rounded-br-sm'
                  : msg.error
                    ? 'bg-red-900/30 border border-red-500/30 text-red-300 rounded-bl-sm'
                    : 'bg-bg-card text-text-primary rounded-bl-sm'
              }`}
            >
              {msg.role === 'assistant'
                ? renderContent(msg.content, msg.streaming)
                : msg.content}
            </div>
          </div>
        ))}

        {thinking && messages[messages.length - 1]?.streaming !== true && (
          <div className="flex items-start gap-2 animate-fade-in">
            <span className="w-6 h-6 rounded-full bg-gradient-to-br from-ping-blue to-ping-purple flex items-center justify-center text-white shrink-0 mt-0.5">
              <SparkleIcon size={10} />
            </span>
            <div className="bg-bg-card rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1 items-center">
              <TypingDot delay="0ms" />
              <TypingDot delay="160ms" />
              <TypingDot delay="320ms" />
            </div>
          </div>
        )}

        {activeHitl && (
          <div className="rounded-2xl border border-amber-400/30 bg-amber-500/10 px-4 py-3 animate-fade-in">
            <p className="text-xs uppercase tracking-wider text-amber-300 font-semibold mb-1">
              Verification Required
            </p>
            <p className="text-sm text-text-primary mb-3">{activeHitl.message ?? 'Verification is required to continue.'}</p>

            {(activeHitl.metadata?.event_type ?? 'otp-required') === 'otp-required' ? (
              <div className="flex items-center gap-2">
                <input
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  placeholder="Enter OTP"
                  className="flex-1 bg-bg-card border border-white/10 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/60"
                  inputMode="numeric"
                />
                <button
                  onClick={handleSubmitOtp}
                  disabled={!otpCode.trim() || thinking}
                  className="px-3 py-2 rounded-lg bg-accent text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Verify
                </button>
              </div>
            ) : (
              <p className="text-xs text-text-muted">
                This challenge type is not yet fully rendered. Continue in chat for now.
              </p>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="px-4 pb-4 shrink-0 border-t border-white/10 pt-3">
        <div className="flex items-end gap-2 bg-bg-card rounded-xl border border-white/10 px-3 py-2 focus-within:border-accent/50 transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your content…"
            rows={3}
            style={{ resize: 'none' }}
            className="flex-1 bg-transparent text-sm text-text-primary placeholder-text-muted outline-none min-h-[60px] max-h-48 overflow-y-auto"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || thinking}
            className="w-8 h-8 rounded-lg bg-accent hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center text-white transition-colors shrink-0"
            aria-label="Send"
          >
            <SendIcon />
          </button>
        </div>
        <p className="text-[10px] text-text-muted mt-1.5 text-center">
          Shift+Enter for new line · Enter to send
        </p>
      </div>
    </aside>
  );
}

function SparkleIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M2 21L23 12 2 3v7l15 2-15 2z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function TypingDot({ delay }: { delay: string }) {
  return (
    <span
      className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-dot"
      style={{ animationDelay: delay }}
    />
  );
}
