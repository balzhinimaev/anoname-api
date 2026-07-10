/**
 * Сервис монетизации для управления подписками, лимитами и покупками
 * @module services/MonetizationService
 */

import User, { IUser } from '../models/User';
import { wsLogger } from '../utils/logger';
import config from '../config';
import crypto from 'crypto';
import mongoose from 'mongoose';
import PaymentLog from '../models/Payment';
import { SettingsService } from './SettingsService';
import AnalyticsEvent from '../models/AnalyticsEvent';

export interface SubscriptionTier {
  type: 'basic' | 'premium';
  price: number;
  duration: number; // дни
  features: {
    unlimitedSearches: boolean;
    advancedFilters: boolean;
    priorityInSearch: boolean;
    analytics: boolean;
  };
}

export const SUBSCRIPTION_TIERS: Record<string, SubscriptionTier> = {
  basic: {
    type: 'basic',
    price: 0,
    duration: 0,
    features: {
      unlimitedSearches: false,
      advancedFilters: false,
      priorityInSearch: false,
      analytics: false
    }
  },
  premium_1day: {
    type: 'premium',
    price: 149,
    duration: 1, // 1 день
    features: {
      unlimitedSearches: true,
      advancedFilters: true,
      priorityInSearch: true,
      analytics: true
    }
  },
  premium_7days: {
    type: 'premium',
    price: 299,
    duration: 7, // 7 дней
    features: {
      unlimitedSearches: true,
      advancedFilters: true,
      priorityInSearch: true,
      analytics: true
    }
  },
  premium_30days: {
    type: 'premium',
    price: 599,
    duration: 30, // 30 дней
    features: {
      unlimitedSearches: true,
      advancedFilters: true,
      priorityInSearch: true,
      analytics: true
    }
  },
  premium_forever: {
    type: 'premium',
    price: 1490,
    duration: -1, // -1 означает навсегда
    features: {
      unlimitedSearches: true,
      advancedFilters: true,
      priorityInSearch: true,
      analytics: true
    }
  }
};

export interface PurchaseItem {
  type: 'boosts' | 'subscription';
  amount?: number;
  subscriptionType?: 'premium' | 'gold';
  price: number;
}

export const PURCHASE_ITEMS: Record<string, PurchaseItem> = {
  boosts_1: { type: 'boosts', amount: 1, price: 99 },
  boosts_5: { type: 'boosts', amount: 5, price: 399 },
  premium_1day: { type: 'subscription', subscriptionType: 'premium', price: 149 },
  premium_7days: { type: 'subscription', subscriptionType: 'premium', price: 299 },
  premium_30days: { type: 'subscription', subscriptionType: 'premium', price: 599 },
  premium_forever: { type: 'subscription', subscriptionType: 'premium', price: 1490 }
};

/**
 * Цены в Telegram Stars — источник истины на сервере.
 * Клиентский starCount никогда не используется для определения суммы.
 */
export const STARS_PRICES: Record<string, number> = {
  premium_1day: 100,
  premium_7days: 200,
  premium_30days: 400,
  premium_forever: 1000,
  boosts_1: 70,
  boosts_5: 270
};

/** Сколько действует один буст (приоритет в выдаче поиска). */
export const BOOST_DURATION_MS = 30 * 60 * 1000;

export class MonetizationService {
  private static toSafeSubscription(sub: IUser['subscription'] | undefined) {
    return {
      type: (sub && sub.type) || 'basic',
      startDate: sub?.startDate,
      endDate: sub?.endDate,
      isActive: !!(sub && sub.isActive),
      autoRenew: !!(sub && sub.autoRenew)
    };
  }

  /**
   * Разрешает itemKey подписки в ключ тарифа SUBSCRIPTION_TIERS.
   * Легаси-ключ 'premium' (старые Stars-инвойсы) трактуем как 30 дней.
   */
  static resolveSubscriptionTierKey(itemKey?: string): string | null {
    if (itemKey && SUBSCRIPTION_TIERS[itemKey] && itemKey !== 'basic') return itemKey;
    if (itemKey === 'premium') return 'premium_30days';
    return null;
  }

  /**
   * Активирует Premium по telegramId (оплата Telegram Stars через бота).
   * itemKey определяет длительность; starCount сверяется с серверным прайсом.
   */
  static async activatePremiumByTelegramId(
    telegramId: string | number,
    itemKey?: string,
    starCount?: number
  ): Promise<{ success: boolean; message?: string }> {
    const tg = Number(telegramId);
    if (!telegramId || Number.isNaN(tg)) {
      return { success: false, message: 'Invalid telegramId' };
    }
    const boostItem = itemKey && PURCHASE_ITEMS[itemKey]?.type === 'boosts' ? itemKey : null;
    const tierKey = boostItem ? null : this.resolveSubscriptionTierKey(itemKey);
    if (!tierKey && !boostItem) {
      return { success: false, message: `Unknown itemKey: ${itemKey}` };
    }
    // Защита от недоплаты: сумма в инвойсе обязана совпадать с прайсом
    const expectedStars = STARS_PRICES[(boostItem || tierKey) as string];
    if (itemKey !== 'premium' && expectedStars && typeof starCount === 'number' && starCount < expectedStars) {
      wsLogger.warn('stars_underpayment', `Stars underpayment: got ${starCount}, expected ${expectedStars}`, { telegramId: tg, itemKey, starCount });
      return { success: false, message: 'Star amount mismatch' };
    }
    const user = await User.findOne({ telegramId: tg }).lean<IUser>();
    if (!user || !user._id) {
      return { success: false, message: 'User not found' };
    }
    const userId = String((user as any)._id);
    if (boostItem) {
      await this.addCurrency(userId, 'boosts', PURCHASE_ITEMS[boostItem].amount || 1);
    } else {
      await this.activateSubscription(userId, tierKey as string);
    }
    this.trackPaymentEvent('payment_succeeded', userId, {
      itemKey: boostItem || tierKey,
      provider: 'stars',
      stars: starCount ?? expectedStars ?? null
    });
    return { success: true };
  }

  /** Событие платёжной воронки в серверную аналитику (best effort). */
  static trackPaymentEvent(name: string, userId?: string, props?: Record<string, any>): void {
    try {
      void AnalyticsEvent.create({
        userId: userId ? new mongoose.Types.ObjectId(userId) : undefined,
        name,
        props
      } as any).catch(() => {});
    } catch { /* noop */ }
  }
  /**
   * Проверяет срок действия подписки и деактивирует её при истечении.
   * Возвращает актуальные данные пользователя (lean), либо null если не найден.
   */
  private static async ensureSubscriptionUpToDateById(userId: string): Promise<IUser | null> {
    const current = await User.findById(userId).lean<IUser>();
    if (!current) return null;

    // Проверяем срок действия подписки только если есть endDate (не навсегда)
    if (
      current.subscription?.isActive &&
      current.subscription.endDate &&
      current.subscription.endDate.getTime() <= Date.now()
    ) {
      await User.findByIdAndUpdate(userId, {
        'subscription.isActive': false,
        'subscription.type': 'basic',
        'limits.canUseAdvancedFilters': SUBSCRIPTION_TIERS.basic.features.advancedFilters
      });
      return await User.findById(userId).lean<IUser>();
    }
    return current;
  }
  /**
   * Проверяет может ли пользователь выполнить поиск
   */
  private static readonly SEARCH_LIMIT = Number(process.env.SEARCH_HOURLY_LIMIT || 2);
  private static readonly SEARCH_WINDOW_MS = Number(process.env.SEARCH_LIMIT_WINDOW_MS || 60 * 60 * 1000);

  /** Активна ли платная подписка (безлимит) у пользователя. */
  private static isPremium(sub: any): boolean {
    return !!(sub?.isActive && sub?.type && sub.type !== 'basic' && (!sub.endDate || new Date(sub.endDate).getTime() > Date.now()));
  }

  /**
   * Проверка возможности поиска (READ-ONLY, без списания): бесплатно — не больше
   * SEARCH_HOURLY_LIMIT поисков в час (восполняется), Premium — безлимит.
   * Списание делает consumeSearch() на старте поиска.
   */
  static async canUserSearch(userId: string): Promise<{ canSearch: boolean; reason?: string; remaining?: number; resetInMin?: number; premium?: boolean }> {
    // Рантайм-тумблер из админки: лимиты выключены — поиск без ограничений всем.
    if (!SettingsService.flags.searchLimitsEnabled) return { canSearch: true };
    const user = await User.findById(userId).select('subscription limits').lean();
    if (!user) return { canSearch: false, reason: 'Пользователь не найден' };
    if (this.isPremium((user as any).subscription)) return { canSearch: true, premium: true };

    const now = Date.now();
    const limits = (user as any).limits || {};
    let count = limits.searchHourCount || 0;
    let resetAt = limits.searchHourResetAt ? new Date(limits.searchHourResetAt).getTime() : 0;
    if (!resetAt || now >= resetAt) { count = 0; resetAt = now + this.SEARCH_WINDOW_MS; }
    if (count >= this.SEARCH_LIMIT) {
      const mins = Math.max(1, Math.ceil((resetAt - now) / 60000));
      return {
        canSearch: false,
        reason: `Лимит бесплатных поисков (${this.SEARCH_LIMIT} в час) исчерпан. Обновится через ~${mins} мин. Оформите Premium, чтобы искать без ограничений.`,
        remaining: 0,
        resetInMin: mins,
      };
    }
    return { canSearch: true, remaining: this.SEARCH_LIMIT - count };
  }

  /** Текущая квота поиска (read-only) для показа счётчика «осталось N». remaining=-1 у Premium (безлимит). */
  static async getSearchQuota(userId: string): Promise<{ premium: boolean; limit: number; remaining: number; resetInMin: number }> {
    // Лимиты выключены глобально: отдаём «безлимит» (premium=true — клиент
    // рисует „безлимитный поиск“ и не показывает счётчик остатка).
    if (!SettingsService.flags.searchLimitsEnabled) {
      return { premium: true, limit: this.SEARCH_LIMIT, remaining: -1, resetInMin: 0 };
    }
    const user = await User.findById(userId).select('subscription limits').lean();
    if (!user) return { premium: false, limit: this.SEARCH_LIMIT, remaining: this.SEARCH_LIMIT, resetInMin: 0 };
    if (this.isPremium((user as any).subscription)) return { premium: true, limit: this.SEARCH_LIMIT, remaining: -1, resetInMin: 0 };
    const now = Date.now();
    const limits: any = (user as any).limits || {};
    let count = limits.searchHourCount || 0;
    const resetAt = limits.searchHourResetAt ? new Date(limits.searchHourResetAt).getTime() : 0;
    if (!resetAt || now >= resetAt) count = 0;
    return {
      premium: false,
      limit: this.SEARCH_LIMIT,
      remaining: Math.max(0, this.SEARCH_LIMIT - count),
      resetInMin: resetAt > now ? Math.ceil((resetAt - now) / 60000) : 0,
    };
  }

  /** Атомарно списывает одну попытку часового лимита (вызывать на старте поиска, если не Premium). */
  static async consumeSearch(userId: string): Promise<void> {
    if (!SettingsService.flags.searchLimitsEnabled) return; // лимиты выключены — не списываем
    const user = await User.findById(userId).select('subscription limits');
    if (!user) return;
    if (this.isPremium((user as any).subscription)) return; // Premium — не списываем
    const now = Date.now();
    const limits: any = (user as any).limits || {};
    const resetAt = limits.searchHourResetAt ? new Date(limits.searchHourResetAt).getTime() : 0;
    if (!resetAt || now >= resetAt) {
      limits.searchHourCount = 1;
      limits.searchHourResetAt = new Date(now + this.SEARCH_WINDOW_MS);
    } else {
      limits.searchHourCount = (limits.searchHourCount || 0) + 1;
    }
    (user as any).limits = limits;
    await user.save();
  }

  /**
   * Использует попытку поиска
   */
  static async useSearchAttempt(userId: string): Promise<void> {
    await User.findByIdAndUpdate(userId, {
      $inc: { 'limits.searchesToday': 1 }
    });
  }

  /**
   * Проверяет можно ли использовать буст
   */
  static async canUseBoost(userId: string): Promise<{ canUse: boolean; reason?: string; boosts?: number; boostActiveUntil?: Date | null }> {
    const user = await User.findById(userId).select('currency').lean();
    const boosts = (user as any)?.currency?.boosts || 0;
    const activeUntil = (user as any)?.currency?.boostActiveUntil || null;
    if (activeUntil && new Date(activeUntil).getTime() > Date.now()) {
      return { canUse: false, reason: 'Буст уже активен', boosts, boostActiveUntil: activeUntil };
    }
    if (boosts <= 0) {
      return { canUse: false, reason: 'Недостаточно бустов. Купите бусты в магазине.', boosts, boostActiveUntil: activeUntil };
    }
    return { canUse: true, boosts, boostActiveUntil: activeUntil };
  }

  /**
   * Активирует буст: списывает 1 буст и даёт приоритет в выдаче на BOOST_DURATION_MS.
   * Атомарно: не спишет, если бустов нет или буст уже активен.
   */
  static async useBoost(userId: string): Promise<{ success: boolean; message?: string; boostActiveUntil?: Date; boostsLeft?: number }> {
    const now = new Date();
    const until = new Date(now.getTime() + BOOST_DURATION_MS);
    const updated = await User.findOneAndUpdate(
      {
        _id: userId,
        'currency.boosts': { $gt: 0 },
        $or: [
          { 'currency.boostActiveUntil': { $exists: false } },
          { 'currency.boostActiveUntil': null },
          { 'currency.boostActiveUntil': { $lte: now } }
        ]
      },
      {
        $inc: { 'currency.boosts': -1 },
        $set: { 'currency.boostActiveUntil': until }
      },
      { new: true }
    ).select('currency').lean();
    if (!updated) {
      const state = await this.canUseBoost(userId);
      return { success: false, message: state.reason || 'Буст недоступен', boostsLeft: state.boosts, boostActiveUntil: state.boostActiveUntil || undefined };
    }
    this.trackPaymentEvent('boost_used', userId, { until });
    // Если пользователь сейчас в поиске — поднимем приоритет активной заявки
    try {
      const { default: Search } = await import('../models/Search');
      await (Search as any).updateMany({ userId, status: 'searching' }, { isBoosted: true });
    } catch { /* noop */ }
    return { success: true, boostActiveUntil: until, boostsLeft: (updated as any)?.currency?.boosts ?? 0 };
  }

  /** Активен ли буст у пользователя прямо сейчас. */
  static isBoostActive(user: Pick<IUser, 'currency'> | null | undefined): boolean {
    const until = (user as any)?.currency?.boostActiveUntil;
    return !!until && new Date(until).getTime() > Date.now();
  }

  /**
   * Начисляет премиум без оплаты (реферальная награда, промо).
   */
  static async grantPremium(userId: string, tierKey: string, source: string): Promise<void> {
    await this.activateSubscription(userId, tierKey);
    this.trackPaymentEvent('premium_granted', userId, { tierKey, source });
  }

  /**
   * Совершает покупку
   */
  static async makePurchase(userId: string, itemKey: string, receiptEmail?: string): Promise<{ success: boolean; message?: string; redirectUrl?: string; paymentId?: string }> {
    const item = PURCHASE_ITEMS[itemKey];
    if (!item) {
      return { success: false, message: 'Товар не найден' };
    }

    // Получаем данные пользователя для формирования чека
    const user = await User.findById(userId).lean<IUser>();
    if (!user) {
      return { success: false, message: 'Пользователь не найден' };
    }

    // Формируем данные покупателя для чека (YooKassa требует email или телефон)
    const customerFullName = (user.firstName && user.lastName)
      ? `${user.firstName} ${user.lastName}`
      : (user.firstName || user.username || `User ${user.telegramId}`);
    // Чек 54-ФЗ: если пользователь указал email — шлём туда, иначе технический адрес
    const isValidEmail = (e?: string) => !!e && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
    const customerEmail = isValidEmail(receiptEmail)
      ? (receiptEmail as string).trim()
      : `${user.username ? user.username : `tg_${user.telegramId}`}@noemail.local`;

    const receipt: any = {
      customer: {
        full_name: customerFullName,
        email: customerEmail
      },
      items: [
        {
          description: item.type === 'subscription' ? 'Подписка Premium' : 'Внутренняя валюта',
          quantity: '1.00',
          amount: { value: item.price.toFixed(2), currency: 'RUB' },
          vat_code: 1, // без НДС
          payment_mode: 'full_payment',
          payment_subject: item.type === 'subscription' ? 'service' : 'commodity'
        }
      ]
    };

    const paymentResult = await this.processPayment(item.price, `${item.type}:${itemKey}`, { userId, itemKey }, receipt);
    if (!paymentResult.success && !paymentResult.redirectUrl) {
      return { success: false, message: paymentResult.message || 'Ошибка обработки платежа' };
    }

    // Применяем покупку
    // Если требуется подтверждение (redirect), возвращаем ссылку без немедленного начисления
    if (paymentResult.redirectUrl) {
      // Логируем платеж (идемпотентность и последующая подтверждающая обработка)
      try {
        await PaymentLog.create({
          paymentId: paymentResult.paymentId as string,
          userId: new mongoose.Types.ObjectId(userId),
          itemKey,
          status: 'pending'
        });
      } catch {}
      this.trackPaymentEvent('payment_created', userId, { itemKey, amount: item.price, provider: 'yookassa' });
      return { success: true, redirectUrl: paymentResult.redirectUrl, paymentId: paymentResult.paymentId, message: 'Перейдите по ссылке для оплаты' };
    }

    // Если платёж уже успешно подтвержден/captured, применяем покупку
    return this.applyPurchaseByItemKey(userId, itemKey);
  }

  /**
   * Активирует подписку
   */
  private static async activateSubscription(userId: string, tierKey: string): Promise<void> {
    const tier = SUBSCRIPTION_TIERS[tierKey];
    if (!tier) {
      throw new Error(`Неизвестный тип подписки: ${tierKey}`);
    }

    const now = new Date();
    let startDate = now;
    let endDate: Date | null = null;

    // Для подписки навсегда (duration = -1) не устанавливаем endDate
    if (tier.duration === -1) {
      endDate = null; // навсегда
    } else {
      endDate = new Date(now.getTime() + tier.duration * 24 * 60 * 60 * 1000);
    }

    // Если подписка уже активна и не просрочена — продлеваем от текущей даты окончания
    try {
      const current = await User.findById(userId).lean<IUser>();
      if (current?.subscription?.isActive && current.subscription.endDate && current.subscription.endDate.getTime() > now.getTime()) {
        startDate = current.subscription.startDate || startDate;
        // Для подписки навсегда не продлеваем, а заменяем
        if (tier.duration !== -1) {
          endDate = new Date(current.subscription.endDate.getTime() + tier.duration * 24 * 60 * 60 * 1000);
        }
      }
    } catch {}

    await User.findByIdAndUpdate(userId, {
      subscription: {
        type: tier.type,
        startDate,
        endDate,
        isActive: true,
        autoRenew: false
      },
      'limits.canUseAdvancedFilters': tier.features.advancedFilters
    });

    const durationText = tier.duration === -1 ? 'навсегда' : 
                        tier.duration === 1 ? 'на 1 день' : 
                        `на ${tier.duration} дней`;

    wsLogger.info('subscription_activated', `Подписка ${tier.type} ${durationText} активирована для пользователя ${userId}`, {
      userId,
      subscriptionType: tier.type,
      tierKey,
      endDate
    });
  }

  /**
   * Добавляет валюту пользователю
   */
  private static async addCurrency(userId: string, type: 'boosts', amount: number): Promise<void> {
    const updateField = `currency.${type}`;
    await User.findByIdAndUpdate(userId, {
      $inc: { [updateField]: amount }
    });
  }

  /**
   * Сбрасывает дневные лимиты если прошли сутки
   */
  private static async resetDailyLimitsIfNeeded(userId: string, limits: IUser['limits'] | undefined): Promise<void> {
    if (!limits) return;

    const now = new Date();
    const lastResetDate = limits.lastReset instanceof Date ? limits.lastReset : new Date(0);
    const daysSinceReset = Math.floor((now.getTime() - lastResetDate.getTime()) / (24 * 60 * 60 * 1000));

    if (daysSinceReset >= 1 || typeof limits.searchesToday !== 'number') {
      await User.findByIdAndUpdate(userId, {
        'limits.searchesToday': 0,
        'limits.lastReset': now
      });
    }
  }

  /**
   * Заглушка для обработки платежа
   */
  private static async processPayment(amount: number, description: string, metadata: { userId: string; itemKey: string }, receipt: any): Promise<{ success: boolean; redirectUrl?: string; paymentId?: string; message?: string }> {
    try {
      const isTest = (config.yookassa.mode || 'test') === 'test';
      const shopId = isTest ? config.yookassa.shopIdTest : config.yookassa.shopIdProd;
      const secretKey = isTest ? config.yookassa.secretKeyTest : config.yookassa.secretKeyProd;

      if (!shopId || !secretKey) {
        wsLogger.warn('yookassa_config', 'YooKassa credentials are not configured');
        return { success: false, message: 'YooKassa not configured' };
      }

      const idempotenceKey = crypto.randomUUID();
      const authHeader = Buffer.from(`${shopId}:${secretKey}`).toString('base64');

      const response = await fetch('https://api.yookassa.ru/v3/payments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotence-Key': idempotenceKey,
          'Authorization': `Basic ${authHeader}`
        },
        body: JSON.stringify({
          amount: { value: amount.toFixed(2), currency: 'RUB' },
          capture: true,
          confirmation: { type: 'redirect', return_url: `${config.clientUrl}/app/?payment=return` },
          description,
          metadata,
          receipt
        })
      });

      const data: any = await response.json();
      if (!response.ok) {
        wsLogger.warn('yookassa_payment_create', 'Failed to create payment', { status: response.status, data });
        return { success: false, message: (data && data.description) || 'Create payment failed' };
      }

      // Если платеж требует подтверждения — отдаем ссылку на оплату
      if (data && data.status === 'pending' && data.confirmation && data.confirmation.confirmation_url) {
        return { success: true, redirectUrl: data.confirmation.confirmation_url, paymentId: data.id as string };
      }

      // Если платеж сразу прошел (редко), считаем успехом
      if (data && (data.status === 'succeeded' || data.paid === true)) {
        return { success: true, paymentId: data.id as string };
      }

      return { success: false, message: 'Unknown payment status' };
    } catch (error) {
      wsLogger.error('system', 'yookassa_payment', error as Error);
      return { success: false, message: 'Payment exception' };
    }
  }

  /**
   * Получает платёж из YooKassa и применяет покупку по metadata
   */
  static async confirmAndApplyPayment(paymentId: string): Promise<{ success: boolean; status?: string; message?: string }> {
    try {
      const isTest = (config.yookassa.mode || 'test') === 'test';
      const shopId = isTest ? config.yookassa.shopIdTest : config.yookassa.shopIdProd;
      const secretKey = isTest ? config.yookassa.secretKeyTest : config.yookassa.secretKeyProd;

      if (!shopId || !secretKey) {
        return { success: false, message: 'YooKassa not configured' };
      }

      const authHeader = Buffer.from(`${shopId}:${secretKey}`).toString('base64');
      const response = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${authHeader}`
        }
      });
      const data: any = await response.json();
      if (!response.ok) {
        return { success: false, message: data?.description || 'Failed to fetch payment' };
      }

      const meta = (data?.metadata || {}) as { userId?: string; itemKey?: string };

      // Платёж отменён/просрочен на стороне YooKassa — фиксируем терминальный статус
      if (data && data.status === 'canceled') {
        const prev = await PaymentLog.findOne({ paymentId });
        if (!prev || prev.status === 'pending') {
          await PaymentLog.findOneAndUpdate(
            { paymentId },
            { status: 'canceled', payload: data },
            { upsert: true }
          );
          this.trackPaymentEvent('payment_canceled', meta.userId, {
            itemKey: meta.itemKey,
            reason: data?.cancellation_details?.reason
          });
        }
        return { success: false, status: 'canceled', message: 'Payment canceled' };
      }

      if (!(data && (data.status === 'succeeded' || data.paid === true))) {
        return { success: false, status: 'pending', message: 'Payment not confirmed' };
      }

      if (!meta.userId || !meta.itemKey) {
        return { success: false, message: 'Missing metadata' };
      }

      // Применяем покупку согласно itemKey
      // Защита от повторной обработки: если уже applied — выходим идемпотентно
      const existing = await PaymentLog.findOne({ paymentId });
      if (existing && existing.status === 'applied') {
        return { success: true, status: 'applied', message: 'Already processed' };
      }

      const applyResult = await this.applyPurchaseByItemKey(meta.userId, meta.itemKey);
      if (applyResult.success) {
        await PaymentLog.findOneAndUpdate(
          { paymentId },
          { status: 'applied', payload: data },
          { upsert: true }
        );
        this.trackPaymentEvent('payment_succeeded', meta.userId, {
          itemKey: meta.itemKey,
          amount: Number(data?.amount?.value) || undefined,
          currency: data?.amount?.currency || 'RUB',
          provider: 'yookassa',
          test: data?.test === true
        });
      } else {
        await PaymentLog.findOneAndUpdate(
          { paymentId },
          { status: 'failed', payload: data },
          { upsert: true }
        );
      }
      return { ...applyResult, status: applyResult.success ? 'applied' : 'failed' };
    } catch (error) {
      wsLogger.error('system', 'yookassa_confirm', error as Error);
      return { success: false, message: 'Confirm exception' };
    }
  }

  /**
   * Статус платежа для клиентского поллинга после возврата с оплаты.
   * pending → активно перепроверяем в YooKassa (и применяем, если оплачен).
   */
  static async getPaymentStatusForUser(userId: string, paymentId: string): Promise<{ found: boolean; status?: string; message?: string }> {
    const log = await PaymentLog.findOne({ paymentId }).lean();
    if (!log || !log.userId || String(log.userId) !== String(userId)) {
      return { found: false };
    }
    if (log.status === 'pending') {
      const result = await this.confirmAndApplyPayment(paymentId);
      const status = (result as any).status || (result.success ? 'applied' : 'pending');
      return { found: true, status, message: result.message };
    }
    return { found: true, status: log.status };
  }

  private static async applyPurchaseByItemKey(userId: string, itemKey: string): Promise<{ success: boolean; message?: string }> {
    const item = PURCHASE_ITEMS[itemKey];
    if (!item) {
      return { success: false, message: 'Товар не найден' };
    }
    if (item.type === 'subscription') {
      if (!item.subscriptionType || item.subscriptionType !== 'premium') {
        return { success: false, message: 'Неверный тип подписки' };
      }

      const subscriptionTier = this.resolveSubscriptionTierKey(itemKey);
      if (!subscriptionTier) {
        return { success: false, message: 'Неизвестный тариф подписки' };
      }

      await this.activateSubscription(userId, subscriptionTier);

      const tier = SUBSCRIPTION_TIERS[subscriptionTier];
      const durationText = tier.duration === -1 ? 'навсегда' :
                          tier.duration === 1 ? 'на 1 день' :
                          `на ${tier.duration} дней`;

      return { success: true, message: `Подписка Premium ${durationText} активирована!` };
    } else {
      if (!item.amount) {
        return { success: false, message: 'Неверное количество валюты' };
      }
      await this.addCurrency(userId, item.type, item.amount);
      return { success: true, message: `${item.amount} ${item.type} добавлено к вашему счету!` };
    }
  }

  /**
   * Получает информацию о статусе пользователя
   */
  static async getUserStatus(userId: string): Promise<any> {
    const user = await this.ensureSubscriptionUpToDateById(userId);
    if (!user) return null;

    await this.resetDailyLimitsIfNeeded(userId, user.limits);

    return {
      subscription: this.toSafeSubscription(user.subscription),
      currency: user.currency,
      limits: user.limits,
      analytics: user.analytics
    };
  }

  /**
   * Получает только лимиты поиска пользователя
   */
  static async getSearchLimits(userId: string): Promise<any> {
    const user = await this.ensureSubscriptionUpToDateById(userId);
    if (!user) return null;

    // Реальный часовой лимит: безлимит только у Premium.
    const q = await this.getSearchQuota(userId);
    return {
      searchesToday: q.premium ? 0 : (q.limit - q.remaining),
      maxSearches: q.premium ? -1 : q.limit,
      unlimited: q.premium,
      remaining: q.premium ? -1 : q.remaining,
      resetsAt: new Date(Date.now() + (q.resetInMin || 60) * 60 * 1000),
      subscriptionType: user.subscription?.type || 'free'
    };
  }

  // === ФОНОВЫЕ ДЖОБЫ ===

  private static jobsStarted = false;

  /**
   * Запускает фоновые задачи монетизации:
   * - экспирация истёкших подписок (каждые 10 мин) — иначе isActive виснет в true
   *   для пользователей, которые не дергают getUserStatus;
   * - дожим/чистка зависших pending-платежей (каждый час).
   */
  static startBackgroundJobs(): void {
    if (this.jobsStarted) return;
    this.jobsStarted = true;

    const expireSubscriptions = async () => {
      try {
        const res = await User.updateMany(
          { 'subscription.isActive': true, 'subscription.endDate': { $ne: null, $lte: new Date() } },
          {
            'subscription.isActive': false,
            'subscription.type': 'basic',
            'limits.canUseAdvancedFilters': false
          }
        );
        if (res.modifiedCount > 0) {
          wsLogger.info('subscriptions_expired', `Деактивировано истёкших подписок: ${res.modifiedCount}`, { count: res.modifiedCount });
        }
      } catch (e) {
        wsLogger.error('system', 'subscriptions_expire_job', e as Error);
      }
    };

    const reconcilePendingPayments = async () => {
      try {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        const stale = await PaymentLog.find({ status: 'pending', createdAt: { $lte: twoHoursAgo } })
          .sort({ createdAt: 1 })
          .limit(20)
          .lean();
        for (const log of stale) {
          // confirmAndApplyPayment сам переведёт в applied/canceled по данным YooKassa
          await this.confirmAndApplyPayment(log.paymentId).catch(() => {});
        }
        // Совсем древние pending без ответа от YooKassa считаем отменёнными
        const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
        await PaymentLog.updateMany(
          { status: 'pending', createdAt: { $lte: twoDaysAgo } },
          { status: 'canceled' }
        );
      } catch (e) {
        wsLogger.error('system', 'pending_payments_job', e as Error);
      }
    };

    setInterval(expireSubscriptions, 10 * 60 * 1000).unref?.();
    setInterval(reconcilePendingPayments, 60 * 60 * 1000).unref?.();
    // Прогон при старте, чтобы подхватить накопившееся
    void expireSubscriptions();
    void reconcilePendingPayments();
  }
}