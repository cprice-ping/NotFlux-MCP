import { useEffect, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { getAllMedia } from '../api/notflux';
import type { MediaItem } from '../types';
import Header from '../components/Header';
import MediaCard from '../components/MediaCard';
import MediaCardSkeleton from '../components/MediaCardSkeleton';
import MediaModal from '../components/MediaModal';
import AgentPanel from '../components/AgentPanel';
import KeyboardShortcutsHelp from '../components/KeyboardShortcutsHelp';
import { useAgent } from '../hooks/useAgent';
import { useKeyboardShortcuts } from '../hooks/useKeyboard';

interface Props {
  user: User;
}

// ---------------------------------------------------------------------------
// Sample content categories - the agent can surface items dynamically too
// ---------------------------------------------------------------------------
const HERO_PROMPTS = [
  'What can I stream tonight?',
  'What\u2019s available on my plan?',
  'Recommend something based on my account',
];

export default function HomePage({ user }: Props) {
  const accessToken = user.access_token;   // person_token — direct API calls + agent sessions
  const userSub = user.profile.sub;

  const [media, setMedia] = useState<MediaItem[]>([]);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState('');
  const [selectedItem, setSelectedItem] = useState<MediaItem | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);

  // person_token is sent to the backend, which performs Token Exchange
  // (RFC 8693) to get an MCP-audience token before the Vertex API call.
  const {
    messages,
    thinking,
    sendMessage,
    clearMessages,
    activeHitl,
    submitHitlOtp,
  } = useAgent(
    accessToken,
    userSub
  );

  // Keyboard shortcuts
  useKeyboardShortcuts([
    {
      key: 'k',
      meta: true,
      handler: () => setAgentOpen(prev => !prev),
      description: 'Toggle AI assistant',
    },
    {
      key: 'Escape',
      handler: () => {
        if (selectedItem) setSelectedItem(null);
        else if (agentOpen) setAgentOpen(false);
      },
      description: 'Close modal or panel',
    },
  ]);

  // Fetch media on mount
  useEffect(() => {
    setMedia([]);
    setMediaLoading(true);
    setMediaError('');
    getAllMedia(accessToken)
      .then((items) => {
        setMedia(items);
        setMediaLoading(false);
      })
      .catch((e) => {
        setMediaError(String(e));
        setMediaLoading(false);
      });
  }, [accessToken]);

  // Split into rows by rating for a Netflix-style layout
  const kidsContent = media.filter((m) =>
    ['G', 'TV-G', 'PG', 'TV-PG'].includes(m.rating ?? '')
  );
  const matureContent = media.filter((m) =>
    ['R', 'TV-MA', 'PG-13', 'TV-14'].includes(m.rating ?? '')
  );
  const allContent = media;

  function handleHeroPrompt(prompt: string) {
    setAgentOpen(true);
    sendMessage(prompt);
  }

  return (
    <div className="min-h-screen bg-bg">
      <Header
        user={user}
        onToggleAgent={() => setAgentOpen((v) => !v)}
        agentOpen={agentOpen}
      />

      {/* Content area — right-shifted when agent panel is open */}
      <div
        className={`transition-all duration-300 ${agentOpen ? 'sm:mr-[400px]' : ''}`}
      >
        {/* ------------------------------------------------------------------ */}
        {/* Hero banner                                                         */}
        {/* ------------------------------------------------------------------ */}
        <section className="relative h-[55vh] min-h-[360px] flex items-end">
          {/* Background */}
          <div
            className="absolute inset-0 bg-gradient-to-br from-ping-blue/30 via-bg to-ping-purple/20"
            aria-hidden="true"
          />
          <div
            className="absolute inset-0 bg-gradient-to-t from-bg via-transparent to-transparent"
            aria-hidden="true"
          />

          {/* Hero text */}
          <div className="relative z-10 px-8 pb-12 max-w-2xl">
            <span className="text-xs font-semibold uppercase tracking-widest text-accent mb-3 block">
              AI-Powered Streaming
            </span>
            <h1 className="text-4xl sm:text-5xl font-extrabold leading-tight mb-4">
              Your content,<br />
              <span className="notflux-logo text-4xl sm:text-5xl">curated by AI</span>
            </h1>
            <p className="text-text-secondary text-sm sm:text-base mb-6 max-w-md">
              Your NotFlux AI agent knows what you can access. Ask it anything.
            </p>

            {/* CTA buttons */}
            <div className="flex flex-wrap gap-3">
              <button
                onClick={() => handleHeroPrompt(HERO_PROMPTS[0])}
                className="flex items-center gap-2 bg-white text-bg font-semibold px-5 py-2.5 rounded-lg hover:bg-white/90 transition-colors"
              >
                ▶ Ask AI to browse
              </button>
              <button
                onClick={() => setAgentOpen(true)}
                className="btn-secondary"
              >
                ✦ Open AI Chat
              </button>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------------------ */}
        {/* Content rows                                                        */}
        {/* ------------------------------------------------------------------ */}
        <main className="px-6 sm:px-8 pb-16 space-y-10">
          {mediaLoading && (
            <>
              <section>
                <div className="h-5 bg-bg-surface rounded w-48 mb-4 skeleton" />
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <MediaCardSkeleton key={i} />
                  ))}
                </div>
              </section>
              <section>
                <div className="h-5 bg-bg-surface rounded w-40 mb-4 skeleton" />
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <MediaCardSkeleton key={i} />
                  ))}
                </div>
              </section>
            </>
          )}

          {!mediaLoading && mediaError && (
            <div className="py-12 px-6 rounded-2xl bg-red-900/20 border border-red-500/20 text-center">
              <p className="text-red-400 font-medium mb-2">Could not load media library</p>
              <p className="text-text-muted text-sm">{mediaError}</p>
              <p className="text-text-muted text-xs mt-3">
                Tip: Ask the AI agent to fetch your library — it uses the NotFlux MCP tools directly.
              </p>
            </div>
          )}

          {!mediaLoading && !mediaError && allContent.length === 0 && (
            <div className="py-12 text-center text-text-muted">
              <p className="text-lg font-medium mb-2">No content found</p>
              <p className="text-sm">Your account may not have access to any titles, or AAM policy filtered all results.</p>
              <button
                onClick={() => handleHeroPrompt('What is available for my account?')}
                className="mt-4 btn-primary text-sm"
              >
                Ask the AI agent
              </button>
            </div>
          )}

          {allContent.length > 0 && (
            <>
              <ContentRow
                title="All Available Content"
                items={allContent}
                onSelect={setSelectedItem}
              />
              {kidsContent.length > 0 && (
                <ContentRow
                  title="Family &amp; Kids"
                  items={kidsContent}
                  onSelect={setSelectedItem}
                />
              )}
              {matureContent.length > 0 && (
                <ContentRow
                  title="Mature Audiences"
                  items={matureContent}
                  onSelect={setSelectedItem}
                />
              )}
            </>
          )}

          {/* AI quick actions */}
          <section>
            <h2 className="text-base font-semibold text-text-secondary mb-4 uppercase tracking-wider text-xs">
              Ask the AI
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {HERO_PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => handleHeroPrompt(p)}
                  className="text-left bg-bg-card hover:bg-bg-surface border border-white/8 rounded-xl px-4 py-3 text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                  <span className="text-accent mr-2">✦</span>
                  {p}
                </button>
              ))}
            </div>
          </section>
        </main>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Agent chat panel                                                     */}
      {/* ------------------------------------------------------------------ */}
      {agentOpen && (
        <AgentPanel
          messages={messages}
          thinking={thinking}
          activeHitl={activeHitl}
          onSend={sendMessage}
          onSubmitHitlOtp={submitHitlOtp}
          onClear={clearMessages}
          onClose={() => setAgentOpen(false)}
        />
      )}

      {/* Media detail modal */}
      {selectedItem && (
        <MediaModal
          item={selectedItem}
          accessToken={accessToken}
          onClose={() => setSelectedItem(null)}
        />
      )}

      {/* Floating agent FAB (visible when panel is closed) */}
      {!agentOpen && (
        <button
          onClick={() => setAgentOpen(true)}
          className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-gradient-to-br from-ping-blue to-ping-purple shadow-lg shadow-accent/40 flex items-center justify-center text-white hover:scale-110 transition-transform"
          aria-label="Open AI agent"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z" />
          </svg>
          {messages.length > 0 && (
            <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-accent animate-pulse" />
          )}
        </button>
      )}

      {/* Keyboard shortcuts help */}
      <KeyboardShortcutsHelp />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Content row component
// ---------------------------------------------------------------------------
function ContentRow({
  title,
  items,
  onSelect,
}: {
  title: string;
  items: MediaItem[];
  onSelect: (item: MediaItem) => void;
}) {
  return (
    <section>
      <h2
        className="text-base font-semibold mb-3 text-text-secondary uppercase tracking-wider text-xs"
        dangerouslySetInnerHTML={{ __html: title }}
      />
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {items.map((item) => (
          <MediaCard key={item.id} item={item} onClick={onSelect} />
        ))}
      </div>
    </section>
  );
}
