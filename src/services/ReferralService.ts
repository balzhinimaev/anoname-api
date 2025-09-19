import User from '../models/User';
import crypto from 'crypto';
import AnalyticsEvent from '../models/AnalyticsEvent';

export class ReferralService {
  /** Генерирует и привязывает реферальный код пользователю, если отсутствует */
  static async ensureReferralCode(userId: string): Promise<string> {
    const user = await User.findById(userId).select('referralCode telegramId');
    if (user?.referralCode) return user.referralCode;
    const base = user?.telegramId ? String(user.telegramId) : userId;
    const raw = crypto.createHash('sha256').update(base + ':' + Date.now()).digest('base64url').replace(/[^a-zA-Z0-9]/g, '');
    const short = raw.slice(0, 8);
    const code = short.toUpperCase();
    try {
      await User.findByIdAndUpdate(userId, { referralCode: code });
    } catch (e) {
      // В редком случае коллизии — повторяем с другим суффиксом
      const alt = (raw + Math.floor(Math.random() * 1e6).toString()).slice(0, 8).toUpperCase();
      await User.findByIdAndUpdate(userId, { referralCode: alt });
      return alt;
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
    } catch {}
  }

  /** Маркируем реферала как «квалифицированного» при целевом событии (например, мэтч) */
  static async markQualified(userId: string) {
    try {
      const u = await User.findById(userId).select('referredBy');
      if (!u?.referredBy) return;
      await User.findByIdAndUpdate(u.referredBy, { $inc: { 'referralStats.qualifiedTotal': 1 } });
      await AnalyticsEvent.create({ name: 'referral_qualified', props: { referrerId: String(u.referredBy), userId } } as any);
    } catch {}
  }

  /** Начисление награды рефереру (однократно или по правилу) */
  static async rewardReferrer(userId: string) {
    try {
      const u = await User.findById(userId).select('referredBy');
      if (!u?.referredBy) return;
      // Здесь можно начислить валюту/подписку/бусты
      await User.findByIdAndUpdate(u.referredBy, { $inc: { 'referralStats.rewardedTotal': 1 } });
      await AnalyticsEvent.create({ name: 'referral_rewarded', props: { referrerId: String(u.referredBy), userId } } as any);
    } catch {}
  }
}


