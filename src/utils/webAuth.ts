import bcrypt from 'bcryptjs';

/**
 * Утилиты регистрации/входа веб-аккаунтов (username + пароль).
 * Отдельный фронт anoname-web (обычный браузер, без Telegram/VK).
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
const BCRYPT_ROUNDS = 12;

// Заранее посчитанный хэш для тайминг-эквализации логина при несуществующем юзере
// (чтобы no-user и bad-password ветки тратили сопоставимое время → нет enumeration-оракула).
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEeO3f4t8x5h8b3a1q2w3e4r5t6y7u8i9o0';

/** «Холостая» проверка пароля (для пути «пользователь не найден»). */
export function dummyVerify(password: string): Promise<boolean> {
  return bcrypt.compare(password || '', DUMMY_HASH).catch(() => false);
}

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
// Небольшой блок-лист самых частых паролей (нижний регистр).
const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'qwerty123',
  'qwertyui', '11111111', '00000000', 'iloveyou', 'admin123', 'welcome1',
  'football', 'baseball', 'sunshine', 'princess', 'dragon123', 'superman',
  'qwerty12', 'password123', 'abc12345', '87654321', 'zxcvbnm1',
]);

export function validatePassword(password: unknown): ValidationResult {
  if (typeof password !== 'string') return { ok: false, reason: 'PASSWORD_REQUIRED' };
  if (password.length < PASSWORD_MIN) return { ok: false, reason: 'PASSWORD_TOO_SHORT' };
  if (password.length > PASSWORD_MAX) return { ok: false, reason: 'PASSWORD_TOO_LONG' };
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return { ok: false, reason: 'PASSWORD_TOO_COMMON' };
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
