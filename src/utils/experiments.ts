import crypto from 'crypto';
import config from '../config';

// Опционально: «липкое» распределение через Redis
let redis: any = null;
async function getRedis() {
  if (!config || !config['redisUrl']) return null;
  if (!config['redisUrl']) return null;
  if (redis) return redis;
  try {
    // динамический импорт, чтобы не требовать ioredis как обязательную зависимость
    const { default: Redis } = await import('ioredis');
    redis = new Redis(config['redisUrl']);
    return redis;
  } catch {
    return null;
  }
}

export function assignCohortDeterministic(userKey: string, splitA = config.abSplitA || 50): 'A' | 'B' {
  const h = crypto.createHash('sha256').update(String(userKey)).digest();
  const bucket = h[0] % 100; // 0..99
  return bucket < splitA ? 'A' : 'B';
}

export async function getStickyCohort(userKey: string): Promise<'A' | 'B'> {
  const r = await getRedis();
  const key = `ab:cohort:${userKey}`;
  if (!r) {
    return assignCohortDeterministic(userKey);
  }
  const existing = await r.get(key);
  if (existing === 'A' || existing === 'B') return existing as 'A' | 'B';
  const v = assignCohortDeterministic(userKey);
  await r.set(key, v, 'NX');
  return v;
}

export function getCohortVariant(userKey: string): 'A' | 'B' {
  return assignCohortDeterministic(userKey);
}


