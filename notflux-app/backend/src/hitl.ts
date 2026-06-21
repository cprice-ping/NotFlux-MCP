// ---------------------------------------------------------------------------
// HITL challenge parsing — extracted from server.ts so the recursive scanner
// can be unit-tested without standing up the Express server. Pure functions.
// ---------------------------------------------------------------------------

export interface HitlChallenge {
  hitl_required: true;
  event_type: string;
  transaction_id: string;
  message: string;
  /** Deep-link URL for QR-code challenges. Frontend renders this as a QR image. */
  qr_code_url?: string;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function tryParseJsonFromMaybeMarkdown(value: string): unknown | null {
  const trimmed = value.trim();
  const direct = tryParseJson(trimmed);
  if (direct !== null) return direct;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (!fenced) return null;
  return tryParseJson(fenced[1]);
}

/** Recursively scans an event payload for an MCP HITL challenge object. */
export function findHitlChallenge(value: unknown): HitlChallenge | null {
  if (typeof value === 'string') {
    const parsed = tryParseJsonFromMaybeMarkdown(value);
    if (parsed !== null) {
      const nested = findHitlChallenge(parsed);
      if (nested) return nested;
    }

    const fencedWithContext = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fencedWithContext) {
      const parsedFromFence = tryParseJson(fencedWithContext[1]);
      if (parsedFromFence !== null) {
        const nested = findHitlChallenge(parsedFromFence);
        if (nested) return nested;
      }
    }
    return null;
  }

  if (!isRecord(value)) return null;

  if (
    value.hitl_required === true &&
    typeof value.event_type === 'string' &&
    typeof value.transaction_id === 'string' &&
    typeof value.message === 'string'
  ) {
    return {
      hitl_required: true,
      event_type: value.event_type,
      transaction_id: value.transaction_id,
      message: value.message,
      qr_code_url: typeof value.qr_code_url === 'string' ? value.qr_code_url : undefined,
    };
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = findHitlChallenge(item);
        if (found) return found;
      }
      continue;
    }

    if (typeof child === 'string' && child.includes('hitl_required')) {
      const parsed = tryParseJsonFromMaybeMarkdown(child.trim());
      if (parsed !== null) {
        const found = findHitlChallenge(parsed);
        if (found) return found;
      }
    }

    const found = findHitlChallenge(child);
    if (found) return found;
  }

  return null;
}
