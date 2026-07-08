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
    price: 10,
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
    price: 249,
    duration: 7, // 7 дней
    features: {
      unlimitedSearches: true,
      advancedFilters: true,
      priorityInSearch: true,
      analytics: true
    }
  },
  premium_forever: {
    type: 'premium',
    price: 699,
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
  premium_1day: { type: 'subscription', subscriptionType: 'premium', price: 10 },
  premium_7days: { type: 'subscription', subscriptionType: 'premium', price: 249 },
  premium_forever: { type: 'subscription', subscriptionType: 'premium', price: 699 }
};

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
   * Активирует Premium по telegramId (30 дней по текущему тарифу premium)
   */
  static async activatePremiumByTelegramId(telegramId: string | number): Promise<{ success: boolean; message?: string }> {
    const tg = Number(telegramId);
    if (!telegramId || Number.isNaN(tg)) {
      return { success: false, message: 'Invalid telegramId' };
    }
    const user = await User.findOne({ telegramId: tg }).lean<IUser>();
    if (!user || !user._id) {
      return { success: false, message: 'User not found' };
    }
    await this.activateSubscription(String((user as any)._id), 'premium');
    return { success: true };
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

  /** Атомарно списывает одну попытку часового лимита (вызывать на старте поиска, если не Premium). */
  static async consumeSearch(userId: string): Promise<void> {
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
  static async canUseBoost(userId: string): Promise<{ canUse: boolean; reason?: string }> {
    const user = await User.findById(userId);
    if (!user || !user.currency || user.currency.boosts <= 0) {
      return { 
        canUse: false, 
        reason: 'Недостаточно буостов. Купите буосты в магазине.' 
      };
    }

    return { canUse: true };
  }

  /**
   * Использует буст
   */
  static async useBoost(userId: string): Promise<void> {
    await User.findByIdAndUpdate(userId, {
      $inc: { 'currency.boosts': -1 }
    });
  }

  /**
   * Совершает покупку
   */
  static async makePurchase(userId: string, itemKey: string): Promise<{ success: boolean; message?: string; redirectUrl?: string; paymentId?: string }> {
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
    // В модели нет телефона/email, поэтому используем технический email на основе Telegram
    const customerEmail = `${user.username ? user.username : `tg_${user.telegramId}`}@noemail.local`;

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
      return { success: true, redirectUrl: paymentResult.redirectUrl, paymentId: paymentResult.paymentId, message: 'Перейдите по ссылке для оплаты' };
    }

    // Если платёж уже успешно подтвержден/captured, применяем покупку
    if (item.type === 'subscription') {
      if (!item.subscriptionType || item.subscriptionType !== 'premium') {
        return { success: false, message: 'Неверный тип подписки' };
      }
      
      // Определяем тип подписки по itemKey
      let subscriptionTier = 'premium_1day'; // по умолчанию
      if (itemKey === 'premium_7days') subscriptionTier = 'premium_7days';
      else if (itemKey === 'premium_forever') subscriptionTier = 'premium_forever';
      
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
          confirmation: { type: 'redirect', return_url: `${config.clientUrl}/payment/return` },
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
  static async confirmAndApplyPayment(paymentId: string): Promise<{ success: boolean; message?: string }> {
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

      if (!(data && (data.status === 'succeeded' || data.paid === true))) {
        return { success: false, message: 'Payment not confirmed' };
      }

      const meta = (data.metadata || {}) as { userId?: string; itemKey?: string };
      if (!meta.userId || !meta.itemKey) {
        return { success: false, message: 'Missing metadata' };
      }

      // Применяем покупку согласно itemKey
      // Защита от повторной обработки: если уже applied — выходим идемпотентно
      const existing = await PaymentLog.findOne({ paymentId });
      if (existing && existing.status === 'applied') {
        return { success: true, message: 'Already processed' };
      }

      const applyResult = await this.applyPurchaseByItemKey(meta.userId, meta.itemKey);
      if (applyResult.success) {
        await PaymentLog.findOneAndUpdate(
          { paymentId },
          { status: 'applied', payload: data },
          { upsert: true }
        );
      } else {
        await PaymentLog.findOneAndUpdate(
          { paymentId },
          { status: 'failed', payload: data },
          { upsert: true }
        );
      }
      return applyResult;
    } catch (error) {
      wsLogger.error('system', 'yookassa_confirm', error as Error);
      return { success: false, message: 'Confirm exception' };
    }
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
      
      // Определяем тип подписки по itemKey
      let subscriptionTier = 'premium_1day'; // по умолчанию
      if (itemKey === 'premium_7days') subscriptionTier = 'premium_7days';
      else if (itemKey === 'premium_forever') subscriptionTier = 'premium_forever';
      
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

    // Лимиты поиска отключены — всегда безлимит.
    return {
      searchesToday: 0,
      maxSearches: -1,
      unlimited: true,
      remaining: -1,
      resetsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      subscriptionType: user.subscription?.type || 'free'
    };
  }
} 