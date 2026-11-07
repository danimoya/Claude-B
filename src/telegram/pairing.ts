import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_PAIRING_TTL_MS = 3 * 60 * 1000;
export interface PairingChallenge {
  digest: string;
  createdAt: number;
  expiresAt: number;
  minUpdateId: number;
  used: boolean;
  expectedSenderId?: string;
}
export interface PairingMessage {
  text?: string;
  date?: number;
  chat?: { id?: number; type?: string };
  from?: { id?: number; is_bot?: boolean };
}

export function createPairingChallenge(options: {
  ttlMs?: number; now?: number; minUpdateId?: number; expectedSenderId?: string;
} = {}): { code: string; challenge: PairingChallenge } {
  const ttl = options.ttlMs ?? MAX_PAIRING_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_PAIRING_TTL_MS) throw new Error('Pairing lifetime must be between 1ms and three minutes');
  if (options.expectedSenderId && !/^[1-9]\d*$/.test(options.expectedSenderId)) throw new Error('Pairing sender must be a private user ID');
  const now = options.now ?? Date.now();
  const code = randomBytes(24).toString('base64url');
  return { code, challenge: {
    digest: createHash('sha256').update(code).digest('hex'), createdAt: now,
    expiresAt: now + ttl, minUpdateId: options.minUpdateId ?? 0, used: false,
    expectedSenderId: options.expectedSenderId
  } };
}

export function isPairingChallenge(value: unknown): value is PairingChallenge {
  if (!value || typeof value !== 'object') return false;
  const x = value as PairingChallenge;
  return /^[a-f0-9]{64}$/.test(x.digest) && Number.isSafeInteger(x.createdAt) &&
    Number.isSafeInteger(x.expiresAt) && x.expiresAt > x.createdAt &&
    x.expiresAt - x.createdAt <= MAX_PAIRING_TTL_MS && Number.isSafeInteger(x.minUpdateId) &&
    x.minUpdateId >= 0 && typeof x.used === 'boolean' &&
    (x.expectedSenderId === undefined || /^[1-9]\d*$/.test(x.expectedSenderId));
}

/** Consume synchronously before any async enrollment writes, so replays lose. */
export function consumePairingChallenge(challenge: PairingChallenge, message: PairingMessage,
  now = Date.now(), updateId?: number): string | null {
  if (!isPairingChallenge(challenge) || challenge.used || now < challenge.createdAt || now >= challenge.expiresAt) return null;
  const id = message.chat?.id;
  if (message.chat?.type !== 'private' || !Number.isSafeInteger(id) || !id || id <= 0 ||
      message.from?.id !== id || message.from?.is_bot) return null;
  if (challenge.expectedSenderId && String(id) !== challenge.expectedSenderId) return null;
  if (!Number.isSafeInteger(message.date) || message.date! < Math.floor(challenge.createdAt / 1000) ||
      message.date! > Math.floor(now / 1000) + 2) return null;
  if (updateId !== undefined && (!Number.isSafeInteger(updateId) || updateId < challenge.minUpdateId)) return null;
  const match = message.text?.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]{32})\s*$/);
  if (!match) return null;
  const supplied = createHash('sha256').update(match[1]).digest();
  if (!timingSafeEqual(Buffer.from(challenge.digest, 'hex'), supplied)) return null;
  challenge.used = true;
  return String(id);
}
