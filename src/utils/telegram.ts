import crypto from 'crypto';

export interface TelegramWebAppUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  allows_write_to_pm?: boolean;
  photo_url?: string;
}

export interface VerifiedInitData {
  ok: boolean;
  reason?: string;
  user?: TelegramWebAppUser;
  auth_date?: number;
  query_id?: string;
  raw?: Record<string, string>;
}

/**
 * Verify Telegram WebApp initData according to Telegram docs
 * Algorithm:
 * 1) Build data_check_string from initData (exclude 'hash', sort by key, join with '\n' as key=value)
 * 2) secret_key = HMAC_SHA256(key='WebAppData', data=bot_token)
 * 3) check_hash = HMAC_SHA256(key=secret_key, data=data_check_string) as hex
 * 4) compare check_hash === hash
 */
export function verifyTelegramWebAppInitData(initData: string, botToken: string): VerifiedInitData {
  try {
    if (!botToken) {
      return { ok: false, reason: 'BOT_TOKEN_MISSING' };
    }

    const params = new URLSearchParams(initData);
    const hash = params.get('hash') || '';
    if (!hash) {
      return { ok: false, reason: 'HASH_MISSING' };
    }

    // Prepare data_check_string
    const entries: string[] = [];
    const raw: Record<string, string> = {};
    params.forEach((value, key) => {
      if (key === 'hash') return;
      entries.push(`${key}=${value}`);
      raw[key] = value;
    });
    entries.sort();
    const dataCheckString = entries.join('\n');

    // secret_key = HMAC_SHA256('WebAppData', bot_token)
    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();
    const checkHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (checkHash !== hash) {
      return { ok: false, reason: 'HASH_MISMATCH' };
    }

    // Parse user (JSON string stored in 'user')
    let user: TelegramWebAppUser | undefined;
    const userParam = params.get('user');
    if (userParam) {
      try {
        user = JSON.parse(decodeURIComponent(userParam)) as TelegramWebAppUser;
      } catch {
        // Some clients already pass decoded value
        try {
          user = JSON.parse(userParam) as TelegramWebAppUser;
        } catch {
          // ignore parsing error
        }
      }
    }

    const authDateStr = params.get('auth_date') || undefined;
    const queryId = params.get('query_id') || undefined;

    return {
      ok: true,
      user,
      auth_date: authDateStr ? Number(authDateStr) : undefined,
      query_id: queryId,
      raw,
    };
  } catch (error) {
    return { ok: false, reason: 'EXCEPTION' };
  }
}

/**
 * Проверка свежести initData по полю auth_date.
 * Возвращает true, если возраст не превышает maxAgeSec.
 */
export function isInitDataFresh(authDateSec: number | undefined, maxAgeSec: number): boolean {
  if (!authDateSec || !Number.isFinite(authDateSec)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec - authDateSec <= Math.max(0, maxAgeSec);
}


