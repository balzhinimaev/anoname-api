import crypto from 'crypto';
import User from '../models/User';

/**
 * Идентичность не-Telegram аккаунтов (веб, VK).
 *
 * Вся кодовая база (модель Token, JWT, WS-авторизация, контроллеры) завязана на
 * числовой `telegramId`. Чтобы не переписывать downstream, не-Telegram аккаунтам
 * выдаётся СИНТЕТИЧЕСКИЙ ОТРИЦАТЕЛЬНЫЙ telegramId. Реальные Telegram user-id всегда
 * положительные, поэтому отрицательное пространство свободно и коллизий с ними нет.
 */

// Верхняя граница модуля синтетического id (< 2^48, заведомо в пределах Number.MAX_SAFE_INTEGER).
const SYNTH_MAX = 0xffffffffffff; // 281_474_976_710_655

/**
 * Подбирает уникальный отрицательный telegramId, которого ещё нет в БД.
 * Делает несколько попыток на случай маловероятной коллизии.
 */
export async function allocateSyntheticTelegramId(maxAttempts = 5): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    // crypto.randomInt(1, max) -> [1, max-1]; берём отрицательным
    const candidate = -crypto.randomInt(1, SYNTH_MAX);
    const exists = await User.exists({ telegramId: candidate });
    if (!exists) return candidate;
  }
  throw new Error('Не удалось выделить синтетический telegramId');
}
