import type { MediaItem } from '../types';

interface Props {
  item: MediaItem;
  onClick: (item: MediaItem) => void;
}

/** Generate a stable gradient from a media item ID */
function idToGradient(id: string): string {
  const hash = [...id].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const hues = [
    ['#1B6AFF', '#6C47FF'], // purple-blue
    ['#FF4785', '#6C47FF'], // pink-purple
    ['#00C9A7', '#1B6AFF'], // teal-blue
    ['#FF6B35', '#FF4785'], // orange-pink
    ['#6C47FF', '#00C9A7'], // purple-teal
    ['#FFB800', '#FF6B35'], // amber-orange
  ];
  const pair = hues[hash % hues.length];
  const angle = (hash % 60) + 120;
  return `linear-gradient(${angle}deg, ${pair[0]}, ${pair[1]})`;
}

const RATING_COLORS: Record<string, string> = {
  G: 'bg-emerald-600',
  PG: 'bg-yellow-600',
  'PG-13': 'bg-orange-500',
  R: 'bg-red-600',
  'TV-G': 'bg-emerald-600',
  'TV-PG': 'bg-yellow-600',
  'TV-14': 'bg-orange-500',
  'TV-MA': 'bg-red-600',
};

export default function MediaCard({ item, onClick }: Props) {
  const gradient = idToGradient(item.id);
  const ratingColor = RATING_COLORS[item.rating ?? ''] ?? 'bg-bg-card';
  const title = item.title ?? item.id.slice(0, 8).toUpperCase();

  return (
    <button
      onClick={() => onClick(item)}
      className="group relative rounded-xl overflow-hidden bg-bg-card aspect-video w-full text-left cursor-pointer card-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      aria-label={`View ${title}`}
    >
      {/* Thumbnail — gradient placeholder (swap for real img when available) */}
      {item.thumbnailUrl ? (
        <img
          src={item.thumbnailUrl}
          alt={title}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <div
          className="absolute inset-0"
          style={{ background: gradient }}
          aria-hidden="true"
        />
      )}

      {/* Dark overlay on hover */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors duration-200" />

      {/* Bottom info */}
      <div className="absolute bottom-0 inset-x-0 p-3 bg-gradient-to-t from-black/80 via-black/30 to-transparent">
        <p className="text-white text-sm font-semibold line-clamp-1">{title}</p>
        {item.genre && (
          <p className="text-white/60 text-xs mt-0.5 line-clamp-1">{item.genre}</p>
        )}
      </div>

      {/* Rating badge */}
      {item.rating && (
        <span
          className={`absolute top-2 right-2 text-white text-[10px] font-bold px-1.5 py-0.5 rounded ${ratingColor}`}
        >
          {item.rating}
        </span>
      )}

      {/* Play hint on hover */}
      <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <span className="w-11 h-11 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </div>
    </button>
  );
}
