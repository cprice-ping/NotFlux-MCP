import type { MediaItem, AccountInfo } from '../types';

/**
 * Fetch all media metadata for the authenticated user.
 * Calls are routed through Vite's proxy to the backend (/api/notflux/*)
 * which forwards them to the NotFlux Kong API with the Bearer token.
 */
export async function getAllMedia(accessToken: string): Promise<MediaItem[]> {
  const res = await fetch('/api/notflux/media/metadata', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch media: ${res.status}`);
  const data = await res.json();
  // Normalise: API might return an array directly or wrapped in { items: [...] }
  if (Array.isArray(data)) return data as MediaItem[];
  if (Array.isArray(data?.items)) return data.items as MediaItem[];
  if (Array.isArray(data?.data)) return data.data as MediaItem[];
  return [];
}

export async function getMediaById(
  id: string,
  accessToken: string
): Promise<MediaItem> {
  const res = await fetch(`/api/notflux/media/metadata/${id}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch media ${id}: ${res.status}`);
  return res.json() as Promise<MediaItem>;
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
