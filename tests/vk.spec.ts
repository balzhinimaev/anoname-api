import { describe, expect, it } from '@jest/globals';
import crypto from 'crypto';
import { verifyVkLaunchParams, isVkLaunchFresh } from '../src/utils/vk';

const SECRET = 'synthetic_vk_secure_key_for_tests';

/** Подписывает набор vk_*-параметров тем же алгоритмом, что и VK, и возвращает готовую query-строку. */
function buildSignedSearch(
  vkParams: Record<string, string>,
  secret: string = SECRET,
  extra: Record<string, string> = {}
): string {
  const ordered = new URLSearchParams();
  Object.keys(vkParams)
    .filter((k) => k.startsWith('vk_'))
    .sort()
    .forEach((k) => ordered.append(k, vkParams[k]));
  const checkString = ordered.toString();
  const sign = crypto
    .createHmac('sha256', secret)
    .update(checkString)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const full = new URLSearchParams();
  Object.entries(vkParams).forEach(([k, v]) => full.append(k, v));
  Object.entries(extra).forEach(([k, v]) => full.append(k, v));
  full.append('sign', sign);
  return '?' + full.toString();
}

const sampleParams = (): Record<string, string> => ({
  vk_access_token_settings: '',
  vk_app_id: '51234567',
  vk_are_notifications_enabled: '0',
  vk_is_app_user: '1',
  vk_is_favorite: '0',
  vk_language: 'ru',
  vk_platform: 'desktop_web',
  vk_ref: 'other',
  vk_ts: '1718450000',
  vk_user_id: '1272270574',
});

describe('verifyVkLaunchParams', () => {
  it('принимает корректную подпись и извлекает поля', () => {
    const search = buildSignedSearch(sampleParams());
    const res = verifyVkLaunchParams(search, SECRET);
    expect(res.ok).toBe(true);
    expect(res.vkUserId).toBe(1272270574);
    expect(res.vkAppId).toBe(51234567);
    expect(res.vkTs).toBe(1718450000);
  });

  it('работает и без ведущего "?"', () => {
    const search = buildSignedSearch(sampleParams()).slice(1);
    expect(verifyVkLaunchParams(search, SECRET).ok).toBe(true);
  });

  it('игнорирует посторонние не-vk_ параметры при проверке подписи', () => {
    const search = buildSignedSearch(sampleParams(), SECRET, { utm_source: 'vk', foo: 'bar' });
    expect(verifyVkLaunchParams(search, SECRET).ok).toBe(true);
  });

  it('отклоняет неверный секрет', () => {
    const search = buildSignedSearch(sampleParams());
    const res = verifyVkLaunchParams(search, 'wrong_secret');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('SIGN_MISMATCH');
  });

  it('отклоняет подделанный параметр', () => {
    const search = buildSignedSearch(sampleParams());
    const tampered = search.replace('vk_user_id=1272270574', 'vk_user_id=999');
    const res = verifyVkLaunchParams(tampered, SECRET);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('SIGN_MISMATCH');
  });

  it('требует наличие sign', () => {
    expect(verifyVkLaunchParams('?vk_user_id=1&vk_app_id=2', SECRET).reason).toBe('SIGN_MISSING');
  });

  it('требует наличие секрета', () => {
    const search = buildSignedSearch(sampleParams());
    expect(verifyVkLaunchParams(search, '').reason).toBe('VK_SECRET_MISSING');
  });

  it('требует хотя бы один vk_ параметр', () => {
    expect(verifyVkLaunchParams('?sign=abc&foo=bar', SECRET).reason).toBe('NO_VK_PARAMS');
  });
});

describe('isVkLaunchFresh', () => {
  it('отключена при maxAge<=0', () => {
    expect(isVkLaunchFresh(undefined, 0)).toBe(true);
    expect(isVkLaunchFresh(1, 0)).toBe(true);
  });

  it('свежий ts проходит, старый — нет', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isVkLaunchFresh(now, 3600)).toBe(true);
    expect(isVkLaunchFresh(now - 7200, 3600)).toBe(false);
  });
});
