import User from '../models/User';
import crypto from 'crypto';
import AnalyticsEvent from '../models/AnalyticsEvent';
import logger from '../utils/logger';
import { metricsCollector } from '../utils/metrics';

export class ReferralService {
  /** Генерирует и привязывает реферальный код пользователю, если отсутствует */
  static async ensureReferralCode(userId: string): Promise<string> {
    const user = await User.findById(userId).select('referralCode telegramId');
    if (user?.referralCode) {
      logger.debug('referral_code_exists', { userId, referralCode: user.referralCode });
      return user.referralCode;
    }
    if (!user) {
      logger.warn('referral_user_not_found_for_code', { userId });
    }
    const base = user?.telegramId ? String(user.telegramId) : userId;
    const raw = crypto.createHash('sha256').update(base + ':' + Date.now()).digest('base64url').replace(/[^a-zA-Z0-9]/g, '');
    const short = raw.slice(0, 8);
    const code = short.toUpperCase();
    try {
      await User.findByIdAndUpdate(userId, { referralCode: code });
      metricsCollector.referralCodeEnsured(false);
      logger.info('referral_code_generated', { userId, referralCode: code, collisionResolved: false });
    } catch (e) {
      // В редком случае коллизии — повторяем с другим суффиксом
      const alt = (raw + Math.floor(Math.random() * 1e6).toString()).slice(0, 8).toUpperCase();
      try {
        await User.findByIdAndUpdate(userId, { referralCode: alt });
        metricsCollector.referralCodeEnsured(true);
        logger.warn('referral_code_collision_resolved', {
          userId,
          previousAttempt: code,
          referralCode: alt,
        });
        return alt;
      } catch (collisionError) {
        metricsCollector.referralErrored();
        logger.error('referral_code_generation_failed', {
          userId,
          error: collisionError instanceof Error ? collisionError.message : String(collisionError),
        });
        throw collisionError;
      }
    }
    return code;
  }

  /** Поиск реферера по коду */
  static async findReferrerByCode(code: string) {
    if (!code || typeof code !== 'string') return null;
    const ref = await User.findOne({ referralCode: code.toUpperCase() }).select('_id');
    return ref;
  }

  /** Атрибуция реферала (однократно, при регистрации) */
  static async attributeReferral(newUserId: string, referralCode?: string) {
    try {
      if (!referralCode) return;
      const referrer = await this.findReferrerByCode(referralCode);
      if (!referrer || !referrer._id) return;
      await User.findByIdAndUpdate(newUserId, { referredBy: referrer._id });
      await User.findByIdAndUpdate(referrer._id, { $inc: { 'referralStats.invitedTotal': 1 } });
      await AnalyticsEvent.create({
        userId: newUserId as any,
        name: 'referral_attributed',
        props: { referrerId: String(referrer._id), code: referralCode }
      } as any);
      metricsCollector.referralAttributed();
      logger.info('referral_attributed_success', {
        newUserId,
        referrerId: String(referrer._id),
        referralCode,
      });
    } catch (error) {
      metricsCollector.referralErrored();
      logger.error('referral_attributed_error', {
        newUserId,
        referralCode,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Маркируем реферала как «квалифицированного» при целевом событии (например, мэтч) */
  static async markQualified(userId: string) {
    try {
      const u = await User.findById(userId).select('referredBy');
      if (!u?.referredBy) return;
      await User.findByIdAndUpdate(u.referredBy, { $inc: { 'referralStats.qualifiedTotal': 1 } });
      await AnalyticsEvent.create({ name: 'referral_qualified', props: { referrerId: String(u.referredBy), userId } } as any);
      metricsCollector.referralQualified();
      logger.info('referral_qualified_success', {
        referrerId: String(u.referredBy),
        userId,
      });
    } catch (error) {
      metricsCollector.referralErrored();
      logger.error('referral_qualified_error', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Начисление награды рефереру (однократно или по правилу) */
  static async rewardReferrer(userId: string) {
    try {
      const u = await User.findById(userId).select('referredBy');
      if (!u?.referredBy) return;
      // Здесь можно начислить валюту/подписку/бусты
      await User.findByIdAndUpdate(u.referredBy, { $inc: { 'referralStats.rewardedTotal': 1 } });
      // Геймификация: приглашённый дошёл до квалификации
      const { GamificationService } = await import('./GamificationService');
      GamificationService.award(String(u.referredBy), 'referral').catch(() => {});
      await AnalyticsEvent.create({ name: 'referral_rewarded', props: { referrerId: String(u.referredBy), userId } } as any);
      metricsCollector.referralRewarded();
      logger.info('referral_rewarded_success', {
        referrerId: String(u.referredBy),
        userId,
      });
    } catch (error) {
      metricsCollector.referralErrored();
      logger.error('referral_rewarded_error', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}


