import { useState, useEffect } from 'react';
import type { MediaItem } from '../types';
import { getMediaContent } from '../api/notflux';

interface Props {
  item: MediaItem;
  accessToken: string;
  onClose: () => void;
}

function idToGradient(id: string): string {
  const hash = [...id].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const hues = [
    ['#1B6AFF', '#6C47FF'],
    ['#FF4785', '#6C47FF'],
    ['#00C9A7', '#1B6AFF'],
    ['#FF6B35', '#FF4785'],
    ['#6C47FF', '#00C9A7'],
    ['#FFB800', '#FF6B35'],
  ];
  const pair = hues[hash % hues.length];
  return `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`;
}

export default function MediaModal({ item, accessToken, onClose }: Props) {
  const [watchStatus, setWatchStatus] = useState<
    'idle' | 'loading' | 'playing' | 'denied'
  >('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const title = item.title ?? item.id.slice(0, 8).toUpperCase();

  // Handle Escape key to close modal
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  async function handleWatch() {
    const drm = item.drm as string | undefined;
    if (!drm) {
      setErrorMsg('No DRM token available for this item. Try using the AI to fetch the full metadata first.');
      setWatchStatus('denied');
      return;
    }

    setWatchStatus('loading');
    try {
      await getMediaContent(item.id, drm, accessToken);
      setWatchStatus('playing');
    } catch (e) {
      setErrorMsg(String(e));
      setWatchStatus('denied');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="relative w-full max-w-lg bg-bg-surface rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero image / gradient */}
        <div className="relative h-52" style={{ background: idToGradient(item.id) }}>
          {item.thumbnailUrl && (
            <img
              src={item.thumbnailUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-bg-surface to-transparent" />
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/50 flex items-center justify-center text-white hover:bg-black/70 transition-colors"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Details */}
        <div className="p-6 space-y-4">
          <div>
            <h2 className="text-xl font-bold">{title}</h2>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {item.year && <span className="text-text-secondary text-sm">{String(item.year)}</span>}
              {item.duration && <span className="text-text-secondary text-sm">{item.duration}</span>}
              {item.rating && (
                <span className="border border-text-muted text-text-secondary text-xs px-1.5 py-0.5 rounded">
                  {item.rating}
                </span>
              )}
              {item.genre && <span className="text-accent text-xs font-medium">{item.genre}</span>}
            </div>
          </div>

          {item.description && (
            <p className="text-text-secondary text-sm leading-relaxed">{item.description as string}</p>
          )}

          {watchStatus === 'playing' && (
            <div className="rounded-lg bg-emerald-900/30 border border-emerald-500/30 p-4 text-sm text-emerald-400">
              ✅ Access granted! In a real app, the stream would start here.
            </div>
          )}
          {watchStatus === 'denied' && (
            <div className="rounded-lg bg-red-900/30 border border-red-500/30 p-4 text-sm text-red-400">
              🚫 {errorMsg || 'Access denied by AAM policy.'}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleWatch}
              disabled={watchStatus === 'loading' || watchStatus === 'playing'}
              className="flex items-center gap-2 bg-white text-bg font-semibold px-5 py-2.5 rounded-lg hover:bg-white/90 disabled:opacity-50 transition-colors"
            >
              {watchStatus === 'loading' ? '⏳ Checking…' : '▶ Watch'}
            </button>
            <button
              onClick={onClose}
              className="btn-secondary"
            >
              Close
            </button>
          </div>

          {/* Raw metadata (collapsed) */}
          <details className="text-xs">
            <summary className="text-text-muted cursor-pointer hover:text-text-secondary">
              Raw metadata
            </summary>
            <pre className="mt-2 p-3 bg-bg rounded-lg overflow-x-auto text-text-secondary leading-relaxed">
              {JSON.stringify(item, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
