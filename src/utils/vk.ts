import crypto from 'crypto';

/**
 * Подпись и параметры запуска VK Mini Apps.
 * Документация: https://dev.vk.com/ru/mini-apps/development/launch-params-sign
 */
export interface VerifiedVkLaunchParams {
  ok: boolean;
  reason?: string;
  vkUserId?: number;
  vkAppId?: number;
  vkTs?: number;
  /** Все параметры запуска (включая не-vk_*), в декодированном виде */
  raw?: Record<string, string>;
}

/**
 * Преобразует base64 в base64url (как требует VK для параметра sign):
 * '+' -> '-', '/' -> '_', хвостовые '=' отбрасываются.
 */
function toBase64Url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Проверяет подпись launch-параметров VK Mini App.
 * Алгоритм VK:
 * 1) Берём только параметры с префиксом `vk_`, сортируем по ключу;
 * 2) Собираем query-строку `k=v&k=v` (www-form-urlencoded);
 * 3) sign = base64url( HMAC_SHA256( query, secret ) );
 * 4) сравниваем со значением параметра `sign`.
 *
 * @param search строка запроса (window.location.search) — c ведущим '?' или без
 * @param secret защищённый ключ VK-приложения (config.vkSecureKey)
 */
export function verifyVkLaunchParams(search: string, secret: string): VerifiedVkLaunchParams {
  try {
    if (!secret) {
      return { ok: false, reason: 'VK_SECRET_MISSING' };
    }

    const qs = search.startsWith('?') ? search.slice(1) : search;
    const params = new URLSearchParams(qs);

    const sign = params.get('sign');
    if (!sign) {
      return { ok: false, reason: 'SIGN_MISSING' };
    }

    // Только vk_* параметры, отсортированные по ключу
    const vkPairs: Array<[string, string]> = [];
    const raw: Record<string, string> = {};
    params.forEach((value, key) => {
      raw[key] = value;
      if (key.startsWith('vk_')) {
        vkPairs.push([key, value]);
      }
    });
    if (vkPairs.length === 0) {
      return { ok: false, reason: 'NO_VK_PARAMS' };
    }
    vkPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const ordered = new URLSearchParams();
    for (const [k, v] of vkPairs) {
      ordered.append(k, v);
    }
    const checkString = ordered.toString();

    const computed = toBase64Url(
      crypto.createHmac('sha256', secret).update(checkString).digest('base64')
    );

    if (!timingSafeEqualStr(computed, sign)) {
      return { ok: false, reason: 'SIGN_MISMATCH' };
    }

    const vkUserIdRaw = params.get('vk_user_id');
    const vkAppIdRaw = params.get('vk_app_id');
    const vkTsRaw = params.get('vk_ts');

    return {
      ok: true,
      vkUserId: vkUserIdRaw ? Number(vkUserIdRaw) : undefined,
      vkAppId: vkAppIdRaw ? Number(vkAppIdRaw) : undefined,
      vkTs: vkTsRaw ? Number(vkTsRaw) : undefined,
      raw,
    };
  } catch {
    return { ok: false, reason: 'EXCEPTION' };
  }
}

/**
 * Проверка свежести launch-параметров по полю vk_ts (unix-секунды).
 * Если maxAgeSec <= 0 — проверка отключена (VK ts обновляется не на каждый запрос).
 */
export function isVkLaunchFresh(vkTs: number | undefined, maxAgeSec: number): boolean {
  if (!maxAgeSec || maxAgeSec <= 0) return true;
  if (!vkTs || !Number.isFinite(vkTs)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.abs(nowSec - vkTs) <= maxAgeSec;
}
