import type { MediaItem, AccountInfo } from '../types';

/**
 * Normalise a raw API item into a flat MediaItem.
 * Handles both the nested { id, metaData: { name, thumbnail, ... } } shape
 * returned by the NotFlux API and any already-flat shape.
 */
function normalise(raw: Record<string, unknown>): MediaItem {
  const meta = (raw.metaData ?? {}) as Record<string, unknown>;
  return {
    id: String(raw.id ?? ''),
    title:        (meta.name        ?? raw.title)        as string | undefined,
    description:  (meta.description ?? raw.description)  as string | undefined,
    rating:       (meta.rating      ?? raw.rating)       as string | undefined,
    genre:        (meta.ratingType  ?? raw.genre)        as string | undefined,
    duration:     (meta.length      ?? raw.duration)     as string | undefined,
    thumbnailUrl: (meta.thumbnail   ?? raw.thumbnailUrl) as string | undefined,
    drm:          (meta.drm         ?? raw.drm)          as string | undefined,
  };
}

/**
 * Fetch all media metadata for the authenticated user.
 * Calls are routed through Vite's proxy to the backend (/api/notflux/*)
 * which forwards them to the NotFlux Kong API with the Bearer token.
 */
export async function getAllMedia(accessToken: string): Promise<MediaItem[]> {
  const res = await fetch('/api/notflux/media/metadata', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to fetch media: ${res.status}`);
  const data = await res.json();
  // Normalise: API might return an array directly or wrapped in { items: [...] }
  const raw: unknown[] = Array.isArray(data) ? data
    : Array.isArray(data?.items) ? data.items
    : Array.isArray(data?.data)  ? data.data
    : [];
  return raw.map((item) => normalise(item as Record<string, unknown>));
}

export async function getMediaById(
  id: string,
  accessToken: string
): Promise<MediaItem> {
  const res = await fetch(`/api/notflux/media/metadata/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Failed to fetch media ${id}: ${res.status}`);
  const raw = await res.json() as Record<string, unknown>;
  return normalise(raw);
}

/** POST /media/content/:id — requires a drm token from the metadata */
export async function getMediaContent(
  id: string,
  drm: string,
  accessToken: string
): Promise<unknown> {
  const res = await fetch(`/api/notflux/media/content/${id}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ drm }),
  });
  if (!res.ok) throw new Error(`Access denied: ${res.status}`);
  return res.json();
}

export async function getAccount(
  id: string,
  accessToken: string
): Promise<AccountInfo> {
  const res = await fetch(`/api/notflux/accounts/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch account: ${res.status}`);
  return res.json() as Promise<AccountInfo>;
}
