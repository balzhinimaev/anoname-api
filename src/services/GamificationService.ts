import User from '../models/User';
import { wsManager } from '../server';
import { wsLogger } from '../utils/logger';

/**
 * Геймификация: XP → уровни/титулы + ачивки за вехи.
 *
 * Все начисления идут через award(userId, event): атомарный $inc счётчиков,
 * затем проверка порогов ачивок и $addToSet новых. Разблокированная ачивка
 * и апы уровня пушатся юзеру WS-событиями (клиент показывает тост).
 * Клиентский каталог названий/эмодзи — utils/achievements.ts (id-совместим).
 */

export type GamificationEvent =
  | 'message'        // отправил сообщение (+анти-спам кап)
  | 'match'          // состоялся матч
  | 'voice'          // отправил голосовое
  | 'game_played'    // доиграл партию
  | 'game_won'       // выиграл партию
  | 'quiz_soulmates' // квиз с ≥8 совпадениями из 10
  | 'five_star'      // получил оценку 5★
  | 'referral';      // приглашённый реферал квалифицировался

const XP: Record<GamificationEvent, number> = {
  message: 1,
  match: 20,
  voice: 5,
  game_played: 10,
  game_won: 15,
  quiz_soulmates: 25,
  five_star: 25,
  referral: 40,
};

// Какие счётчики инкрементит событие (помимо xp)
const COUNTER: Partial<Record<GamificationEvent, string>> = {
  message: 'gamification.messages',
  match: 'gamification.matches',
  voice: 'gamification.voices',
  game_played: 'gamification.gamesPlayed',
  game_won: 'gamification.gamesWon',
  five_star: 'gamification.fiveStars',
  referral: 'gamification.referrals',
};

interface GamificationState {
  xp?: number;
  messages?: number;
  matches?: number;
  voices?: number;
  gamesPlayed?: number;
  gamesWon?: number;
  fiveStars?: number;
  referrals?: number;
  achievements?: string[];
}

// Пороговые ачивки: id → проверка по счётчикам
const ACHIEVEMENT_CHECKS: Array<{ id: string; test: (g: GamificationState) => boolean }> = [
  { id: 'first_match', test: (g) => (g.matches || 0) >= 1 },
  { id: 'social_10', test: (g) => (g.matches || 0) >= 10 },
  { id: 'social_50', test: (g) => (g.matches || 0) >= 50 },
  { id: 'first_voice', test: (g) => (g.voices || 0) >= 1 },
  { id: 'first_game', test: (g) => (g.gamesPlayed || 0) >= 1 },
  { id: 'game_winner_5', test: (g) => (g.gamesWon || 0) >= 5 },
  { id: 'chatterbox_100', test: (g) => (g.messages || 0) >= 100 },
  { id: 'chatterbox_1000', test: (g) => (g.messages || 0) >= 1000 },
  { id: 'five_star_10', test: (g) => (g.fiveStars || 0) >= 10 },
  { id: 'referral_1', test: (g) => (g.referrals || 0) >= 1 },
];

// Событийные ачивки (без счётчика — выдаются напрямую)
const EVENT_ACHIEVEMENTS: Partial<Record<GamificationEvent, string>> = {
  quiz_soulmates: 'quiz_soulmates',
};

/** Уровень из XP: порог уровня n = 50·n·(n+1) (100, 300, 600, 1000, …) */
export function computeLevel(xp: number): number {
  let level = 1;
  while (xp >= 50 * level * (level + 1) && level < 99) level++;
  return level;
}

class GamificationServiceImpl {
  // Анти-спам XP за сообщения: не чаще раза в 30 секунд на юзера
  private lastMessageXpAt = new Map<string, number>();
  private static readonly MESSAGE_XP_COOLDOWN_MS = 30_000;

  /** Начислить событие. Ошибки глотаются — геймификация не должна ломать основной поток. */
  async award(userId: string, event: GamificationEvent): Promise<void> {
    try {
      if (event === 'message') {
        const now = Date.now();
        const last = this.lastMessageXpAt.get(userId) || 0;
        if (now - last < GamificationServiceImpl.MESSAGE_XP_COOLDOWN_MS) return;
        this.lastMessageXpAt.set(userId, now);
        // Заодно прибираем карту (редко, дёшево)
        if (this.lastMessageXpAt.size > 5000) {
          const stale = now - 3600_000;
          for (const [k, v] of this.lastMessageXpAt) {
            if (v < stale) this.lastMessageXpAt.delete(k);
          }
        }
      }

      const inc: Record<string, number> = { 'gamification.xp': XP[event] };
      const counter = COUNTER[event];
      if (counter) inc[counter] = 1;

      const before = await User.findByIdAndUpdate(userId, { $inc: inc })
        .select('gamification')
        .lean();
      if (!before) return;

      const prev = (before as { gamification?: GamificationState }).gamification || {};
      const next: GamificationState = { ...prev };
      next.xp = (prev.xp || 0) + XP[event];
      if (counter) {
        const key = counter.split('.')[1] as keyof GamificationState;
        (next as Record<string, unknown>)[key] = ((prev[key] as number) || 0) + 1;
      }

      // Ап уровня
      const prevLevel = computeLevel(prev.xp || 0);
      const newLevel = computeLevel(next.xp);
      if (newLevel > prevLevel) {
        wsManager.sendToUser(userId, 'user:level_up', { level: newLevel, xp: next.xp });
      }

      // Ачивки: пороговые + событийные
      const unlocked = new Set(prev.achievements || []);
      const fresh: string[] = [];
      for (const a of ACHIEVEMENT_CHECKS) {
        if (!unlocked.has(a.id) && a.test(next)) fresh.push(a.id);
      }
      const eventAch = EVENT_ACHIEVEMENTS[event];
      if (eventAch && !unlocked.has(eventAch)) fresh.push(eventAch);

      if (fresh.length > 0) {
        await User.updateOne(
          { _id: userId },
          { $addToSet: { 'gamification.achievements': { $each: fresh } } }
        );
        for (const id of fresh) {
          wsManager.sendToUser(userId, 'user:achievement', { id });
        }
        wsLogger.info('achievement_unlocked', `User ${userId}: ${fresh.join(', ')}`, { userId, fresh });
      }
    } catch (error) {
      wsLogger.warn('gamification_award_failed', (error as Error).message, { userId, event });
    }
  }
}

export const GamificationService = new GamificationServiceImpl();
