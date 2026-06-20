/**
 * Контроллер монетизации
 * @module controllers/monetizationController
 */

import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { safeEqual } from '../utils/secrets';
import { MonetizationService, SUBSCRIPTION_TIERS, PURCHASE_ITEMS } from '../services/MonetizationService';
import config from '../config';
import crypto from 'crypto';
import logger from '../utils/logger';
import PaymentLog from '../models/Payment';

/**
 * Получить статус пользователя (подписка, валюта, лимиты)
 */
export const getUserStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.token;
    if (!token) {
      res.status(401).json({ error: 'Пользователь не авторизован' });
      return;
    }

    const decoded = jwt.decode(token) as { userId: string };
    const userId = decoded?.userId;
    
    if (!userId) {
      res.status(401).json({ error: 'Некорректный токен' });
      return;
    }

    const status = await MonetizationService.getUserStatus(userId);
    if (!status) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Ошибка получения статуса пользователя:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Получить доступные тарифы подписок
 */
export const getSubscriptionTiers = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({
      success: true,
      data: SUBSCRIPTION_TIERS
    });
  } catch (error) {
    console.error('Ошибка получения тарифов:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Получить доступные товары для покупки
 */
export const getPurchaseItems = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({
      success: true,
      data: PURCHASE_ITEMS
    });
  } catch (error) {
    console.error('Ошибка получения товаров:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Совершить покупку
 */
export const makePurchase = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.token;
    if (!token) {
      res.status(401).json({ error: 'Пользователь не авторизован' });
      return;
    }

    const decoded = jwt.decode(token) as { userId: string };
    const userId = decoded?.userId;
    
    if (!userId) {
      res.status(401).json({ error: 'Некорректный токен' });
      return;
    }

    const { itemKey } = req.body;
    
    if (!itemKey) {
      res.status(400).json({ error: 'Необходимо указать товар' });
      return;
    }

    const result = await MonetizationService.makePurchase(userId, itemKey);
    if (!result.success) {
      res.status(400).json({ success: false, error: result.message || 'Ошибка обработки платежа' });
      return;
    }
    res.json({ success: true, message: result.message, redirectUrl: result.redirectUrl, paymentId: result.paymentId });
  } catch (error) {
    console.error('Ошибка совершения покупки:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Вебхук подтверждения платежа от YooKassa
 */
export const yookassaWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    // Логируем входящие заголовки и тело (маскируем Authorization)
    const sanitizeHeaders = (h: Record<string, any>) => {
      const copy: Record<string, any> = { ...h };
      if (copy.authorization) copy.authorization = '***';
      if (copy.Authorization) copy.Authorization = '***';
      return copy;
    };
    logger.info('YooKassa webhook received', {
      type: 'yookassa_webhook_received',
      headers: sanitizeHeaders(req.headers as any),
      body: req.body
    });
    // 1) Валидация базовой авторизации вебхука (рекомендуется настроить в YooKassa basic-auth)
    if (config.yookassa.webhookUser && config.yookassa.webhookPassword) {
      const auth = req.headers['authorization'];
      if (!auth || !auth.startsWith('Basic ')) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const [user, pass] = decoded.split(':');
      if (user !== config.yookassa.webhookUser || pass !== config.yookassa.webhookPassword) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    // 2) Проверка подписи тела (если вы настроили передачу сигнатуры через заголовок X-Content-SHA256)
    const signatureHeader = (req.headers['x-content-sha256'] || req.headers['x-yookassa-signature-sha256']) as string | undefined;
    if (signatureHeader) {
      const secretKey = (config.yookassa.mode === 'test' ? config.yookassa.secretKeyTest : config.yookassa.secretKeyProd) || '';
      // При проверке по хешу тела используем сырой буфер, если он сохранён в middleware JSON-парсера
      const raw = (req as any).rawBody ? (req as any).rawBody : Buffer.from(JSON.stringify(req.body || {}));
      const expected = crypto
        .createHmac('sha256', secretKey)
        .update(raw)
        .digest('hex');
      if (expected !== signatureHeader) {
        res.status(400).json({ error: 'Invalid signature' });
        return;
      }
    }

    const event = req.body || {};
    // Simple validation: ожидаем объект уведомления с payment.id
    const paymentId = event?.object?.id || event?.payment?.id || event?.id;
    if (!paymentId) {
      res.status(400).json({ error: 'Invalid webhook payload' });
      return;
    }
    // Защита от повторной обработки одного и того же paymentId
    const alreadyApplied = await PaymentLog.findOne({ paymentId, status: 'applied' });
    if (alreadyApplied) {
      logger.info('YooKassa webhook duplicate skipped', { type: 'yookassa_webhook_duplicate', paymentId });
      res.json({ success: true, message: 'Already processed' });
      return;
    }
    // Если записи нет — создадим pending, чтобы последующие дубликаты корректно фильтровались
    const existingLog = await PaymentLog.findOne({ paymentId });
    if (!existingLog) {
      try {
        await PaymentLog.create({
          paymentId,
          status: 'pending',
          userId: event?.object?.metadata?.userId ? event.object.metadata.userId : undefined,
          itemKey: event?.object?.metadata?.itemKey ? event.object.metadata.itemKey : undefined
        } as any);
      } catch (e) {
        // ignore duplicate key or validation errors
      }
    }
    const eventType = event?.event || event?.object?.event || 'unknown';
    const status = event?.object?.status;
    logger.info('YooKassa webhook parsed', { type: 'yookassa_webhook_parsed', eventType, status, paymentId });
    const result = await MonetizationService.confirmAndApplyPayment(paymentId);
    if (!result.success) {
      res.status(400).json({ success: false, error: result.message || 'Payment not confirmed' });
      return;
    }
    res.json({ success: true, message: result.message || 'Payment confirmed' });
  } catch (error) {
    console.error('Ошибка обработки вебхука YooKassa:', error);
    logger.error('YooKassa webhook handler exception', { type: 'yookassa_webhook_exception', error: (error as Error)?.message });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Получено уведомление об успешной оплате Stars от бота
 * Требует заголовок X-API-Key: BOT_BACKEND_SECRET
 */
export const starsPaymentSuccess = async (req: Request, res: Response): Promise<void> => {
  try {
    const apiKey = (req.headers['x-api-key'] || req.headers['X-API-Key'] || '') as string;
    const expected = process.env.BOT_BACKEND_SECRET || '';
    if (!safeEqual(apiKey, expected)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { telegramId, itemKey, starCount, successfulPayment } = req.body || {};
    if (!telegramId) {
      res.status(400).json({ error: 'telegramId is required' });
      return;
    }

    // Логгер (best effort)
    try {
      logger.info('stars_payment_success', {
        type: 'stars_payment_success',
        telegramId,
        itemKey,
        starCount,
        hasPayload: Boolean(successfulPayment)
      });
    } catch {}

    const result = await MonetizationService.activatePremiumByTelegramId(telegramId);
    if (!result.success) {
      res.status(400).json({ success: false, error: result.message || 'Failed to activate premium' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('stars_payment_success_error', { error: (error as Error)?.message });
    res.status(500).json({ error: 'Internal error' });
  }
};

/**
 * Проверить возможность поиска
 */
export const checkSearchAvailability = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.token;
    if (!token) {
      res.status(401).json({ error: 'Пользователь не авторизован' });
      return;
    }

    const decoded = jwt.decode(token) as { userId: string };
    const userId = decoded?.userId;
    
    if (!userId) {
      res.status(401).json({ error: 'Некорректный токен' });
      return;
    }

    const result = await MonetizationService.canUserSearch(userId);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Ошибка проверки доступности поиска:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Получить только лимиты поиска пользователя
 */
export const getSearchLimits = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.token;
    if (!token) {
      res.status(401).json({ error: 'Пользователь не авторизован' });
      return;
    }

    const decoded = jwt.decode(token) as { userId: string };
    const userId = decoded?.userId;
    
    if (!userId) {
      res.status(401).json({ error: 'Некорректный токен' });
      return;
    }

    const limits = await MonetizationService.getSearchLimits(userId);
    
    res.json({
      success: true,
      data: limits
    });
  } catch (error) {
    console.error('Ошибка получения лимитов поиска:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Проверить возможность использования буста
 */
export const checkBoostAvailability = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.token;
    if (!token) {
      res.status(401).json({ error: 'Пользователь не авторизован' });
      return;
    }

    const decoded = jwt.decode(token) as { userId: string };
    const userId = decoded?.userId;
    
    if (!userId) {
      res.status(401).json({ error: 'Некорректный токен' });
      return;
    }

    const result = await MonetizationService.canUseBoost(userId);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Ошибка проверки доступности буста:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Проверить возможность использования супер-лайка
 */
// Удалены супер-лайки и ежедневные пополнения как неиспользуемые в UI