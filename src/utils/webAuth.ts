import bcrypt from 'bcryptjs';

/**
 * Утилиты регистрации/входа веб-аккаунтов (username + пароль).
 * Отдельный фронт anoname-web (обычный браузер, без Telegram/VK).
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
const BCRYPT_ROUNDS = 10;

/** Допустимые символы логина: буквы/цифры/._- , не начинается и не кончается разделителем. */
const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

/** Нормализует логин к каноничному виду для хранения и поиска (нижний регистр, без пробелов). */
export function normalizeLogin(username: string): string {
  return String(username || '').trim().toLowerCase();
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Проверяет имя пользователя (логин). Принимает «сырое» значение (до нормализации). */
export function validateUsername(username: unknown): ValidationResult {
  if (typeof username !== 'string') return { ok: false, reason: 'USERNAME_REQUIRED' };
  const trimmed = username.trim();
  if (trimmed.length < USERNAME_MIN) return { ok: false, reason: 'USERNAME_TOO_SHORT' };
  if (trimmed.length > USERNAME_MAX) return { ok: false, reason: 'USERNAME_TOO_LONG' };
  if (!USERNAME_RE.test(trimmed)) return { ok: false, reason: 'USERNAME_INVALID_CHARS' };
  return { ok: true };
}

/** Проверяет пароль. */
export function validatePassword(password: unknown): ValidationResult {
  if (typeof password !== 'string') return { ok: false, reason: 'PASSWORD_REQUIRED' };
  if (password.length < PASSWORD_MIN) return { ok: false, reason: 'PASSWORD_TOO_SHORT' };
  if (password.length > PASSWORD_MAX) return { ok: false, reason: 'PASSWORD_TOO_LONG' };
  return { ok: true };
}

/** Проверяет совпадение пароля и подтверждения (если подтверждение передано). */
export function validatePasswordConfirm(password: unknown, confirm: unknown): ValidationResult {
  if (confirm === undefined || confirm === null) return { ok: true };
  if (password !== confirm) return { ok: false, reason: 'PASSWORD_MISMATCH' };
  return { ok: true };
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return Promise.resolve(false);
  return bcrypt.compare(password, hash);
}
