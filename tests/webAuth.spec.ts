import { describe, expect, it } from '@jest/globals';
import {
  normalizeLogin,
  validateUsername,
  validatePassword,
  validatePasswordConfirm,
  hashPassword,
  verifyPassword,
} from '../src/utils/webAuth';

describe('normalizeLogin', () => {
  it('приводит к нижнему регистру и обрезает пробелы', () => {
    expect(normalizeLogin('  Alex  ')).toBe('alex');
    expect(normalizeLogin('USER_Name')).toBe('user_name');
  });
});

describe('validateUsername', () => {
  it('принимает корректные имена', () => {
    expect(validateUsername('alex').ok).toBe(true);
    expect(validateUsername('a_b-c.d').ok).toBe(true);
    expect(validateUsername('User123').ok).toBe(true);
  });
  it('отклоняет слишком короткое/длинное', () => {
    expect(validateUsername('ab')).toMatchObject({ ok: false, reason: 'USERNAME_TOO_SHORT' });
    expect(validateUsername('x'.repeat(33))).toMatchObject({ ok: false, reason: 'USERNAME_TOO_LONG' });
  });
  it('отклоняет недопустимые символы и крайние разделители', () => {
    expect(validateUsername('hi there')).toMatchObject({ ok: false, reason: 'USERNAME_INVALID_CHARS' });
    expect(validateUsername('_alex')).toMatchObject({ ok: false, reason: 'USERNAME_INVALID_CHARS' });
    expect(validateUsername('alex.')).toMatchObject({ ok: false, reason: 'USERNAME_INVALID_CHARS' });
    expect(validateUsername('пользователь')).toMatchObject({ ok: false, reason: 'USERNAME_INVALID_CHARS' });
  });
  it('отклоняет не-строку', () => {
    expect(validateUsername(undefined)).toMatchObject({ ok: false, reason: 'USERNAME_REQUIRED' });
    expect(validateUsername(123)).toMatchObject({ ok: false, reason: 'USERNAME_REQUIRED' });
  });
});

describe('validatePassword', () => {
  it('принимает нормальный пароль >= 8 символов', () => {
    expect(validatePassword('a8x7q2m9z').ok).toBe(true);
  });
  it('отклоняет короткий/длинный/не-строку', () => {
    expect(validatePassword('1234567')).toMatchObject({ ok: false, reason: 'PASSWORD_TOO_SHORT' });
    expect(validatePassword('x'.repeat(129))).toMatchObject({ ok: false, reason: 'PASSWORD_TOO_LONG' });
    expect(validatePassword(undefined)).toMatchObject({ ok: false, reason: 'PASSWORD_REQUIRED' });
  });
  it('отклоняет частый пароль', () => {
    expect(validatePassword('password')).toMatchObject({ ok: false, reason: 'PASSWORD_TOO_COMMON' });
    expect(validatePassword('12345678')).toMatchObject({ ok: false, reason: 'PASSWORD_TOO_COMMON' });
  });
});

describe('validatePasswordConfirm', () => {
  it('ок, если подтверждение не передано', () => {
    expect(validatePasswordConfirm('secret123', undefined).ok).toBe(true);
  });
  it('ок при совпадении и ошибка при расхождении', () => {
    expect(validatePasswordConfirm('secret123', 'secret123').ok).toBe(true);
    expect(validatePasswordConfirm('secret123', 'nope')).toMatchObject({ ok: false, reason: 'PASSWORD_MISMATCH' });
  });
});

describe('hashPassword / verifyPassword', () => {
  it('хэширует и подтверждает корректный пароль', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(hash).not.toBe('s3cret-pass');
    expect(hash.length).toBeGreaterThan(20);
    expect(await verifyPassword('s3cret-pass', hash)).toBe(true);
  });
  it('отклоняет неверный пароль и пустой хэш', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('whatever', '')).toBe(false);
  });
});
