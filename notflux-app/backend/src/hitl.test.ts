import { describe, it, expect } from 'vitest';
import { findHitlChallenge, tryParseJsonFromMaybeMarkdown } from './hitl.js';

const otp = {
  hitl_required: true,
  event_type: 'otp-required',
  transaction_id: 'tx-1',
  message: 'Enter the code',
};

describe('findHitlChallenge', () => {
  it('finds a top-level challenge object', () => {
    expect(findHitlChallenge(otp)).toMatchObject(otp);
  });

  it('finds a challenge nested in arrays/objects (ADK event shape)', () => {
    const event = {
      content: { parts: [{ text: JSON.stringify(otp) }] },
    };
    expect(findHitlChallenge(event)).toMatchObject(otp);
  });

  it('finds a challenge inside a ```json markdown fence', () => {
    const text = 'Here you go:\n```json\n' + JSON.stringify(otp) + '\n```';
    expect(findHitlChallenge(text)).toMatchObject(otp);
  });

  it('promotes qr_code_url when present', () => {
    const qr = {
      hitl_required: true,
      event_type: 'qr-required',
      transaction_id: 'tx-2',
      message: 'Scan it',
      qr_code_url: 'https://example.com/qr?code=123',
    };
    expect(findHitlChallenge(qr)?.qr_code_url).toBe('https://example.com/qr?code=123');
  });

  it('returns null when no challenge is present', () => {
    expect(findHitlChallenge({ content: { parts: [{ text: 'hello' }] } })).toBeNull();
    expect(findHitlChallenge('just some prose')).toBeNull();
  });

  it('ignores partial/invalid challenge shapes', () => {
    expect(findHitlChallenge({ hitl_required: true, event_type: 'otp-required' })).toBeNull();
  });
});

describe('tryParseJsonFromMaybeMarkdown', () => {
  it('parses bare JSON', () => {
    expect(tryParseJsonFromMaybeMarkdown('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses fenced JSON', () => {
    expect(tryParseJsonFromMaybeMarkdown('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('returns null on non-JSON', () => {
    expect(tryParseJsonFromMaybeMarkdown('nope')).toBeNull();
  });
});
