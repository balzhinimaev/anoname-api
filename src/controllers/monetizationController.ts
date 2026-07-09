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

    const { itemKey, email } = req.body;

    if (!itemKey) {
      res.status(400).json({ error: 'Необходимо указать товар' });
      return;
    }

    const result = await MonetizationService.makePurchase(userId, itemKey, typeof email === 'string' ? email : undefined);
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
 * Диапазоны IP, с которых YooKassa шлёт уведомления.
 * https://yookassa.ru/developers/using-api/webhooks (раздел «IP-адреса»).
 * Основной способ верификации: basic-auth из URL YooKassa не передаёт,
 * а уведомления по умолчанию не подписывает.
 */
const YOOKASSA_IP_CIDRS: Array<[string, number]> = [
  ['185.71.76.0', 27],
  ['185.71.77.0', 27],
  ['77.75.153.0', 25],
  ['77.75.154.128', 25],
  ['77.75.156.11', 32],
  ['77.75.156.35', 32],
];

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = ((n << 8) | o) >>> 0;
  }
  return n >>> 0;
};

const isYooKassaIp = (rawIp: string): boolean => {
  if (!rawIp) return false;
  let ip = rawIp.trim();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1] as string;
  // IPv6-диапазон YooKassa: 2a02:5180::/32
  if (ip.toLowerCase().startsWith('2a02:5180:')) return true;
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  return YOOKASSA_IP_CIDRS.some(([net, bits]) => {
    const netInt = ipv4ToInt(net);
    if (netInt === null) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (ipInt & mask) === (netInt & mask);
  });
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
    // Верификация вебхука. YooKassa НЕ передаёт basic-auth из URL и по умолчанию
    // не подписывает уведомления — поэтому основной способ — проверка IP-источника
    // (+ обязательная сверка платежа с API в confirmAndApplyPayment ниже).
    // 1) basic-auth — опционально: проверяем, только если заголовок реально прислан.
    let authVerified = false;
    if (config.yookassa.webhookUser && config.yookassa.webhookPassword) {
      const auth = req.headers['authorization'];
      if (auth && auth.startsWith('Basic ')) {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        const [user, pass] = decoded.split(':');
        if (user === config.yookassa.webhookUser && pass === config.yookassa.webhookPassword) {
          authVerified = true;
        } else {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
      }
    }

    // 2) Проверка подписи тела (если настроена передача сигнатуры через заголовок X-Content-SHA256)
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
    const signatureVerified = Boolean(signatureHeader);

    // 3) Проверка IP-источника (диапазоны YooKassa). За nginx реальный адрес — в X-Real-IP.
    const clientIp = String(
      (req.headers['x-real-ip'] as string) ||
      ((req.headers['x-forwarded-for'] as string) || '').split(',')[0] ||
      req.ip || ''
    ).trim();
    const ipVerified = isYooKassaIp(clientIp);

    // Fail-closed: в prod вебхук обязан быть подтверждён хотя бы одним способом
    // (IP YooKassa, basic-auth или подпись). Плюс покупка применяется только после
    // сверки платежа с API YooKassa в confirmAndApplyPayment — подделать нельзя.
    if (config.yookassa.mode === 'prod' && !ipVerified && !authVerified && !signatureVerified) {
      logger.warn('YooKassa webhook rejected: источник не верифицирован', {
        type: 'yookassa_webhook_unverified', clientIp
      });
      res.status(401).json({ error: 'Webhook verification required' });
      return;
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
    // Отмена — терминальное состояние: отвечаем 200, чтобы YooKassa не ретраила
    if (!result.success && result.status === 'canceled') {
      res.json({ success: true, message: 'Payment canceled' });
      return;
    }
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

    const result = await MonetizationService.activatePremiumByTelegramId(telegramId, itemKey, typeof starCount === 'number' ? starCount : Number(starCount) || undefined);
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
 * Статус платежа для клиентского поллинга (после возврата с YooKassa)
 */
export const getPaymentStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.token;
    const decoded = token ? (jwt.decode(token) as { userId: string }) : null;
    const userId = decoded?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Пользователь не авторизован' });
      return;
    }
    const paymentId = String(req.params.paymentId || '').trim();
    if (!paymentId || paymentId.length > 128) {
      res.status(400).json({ error: 'Некорректный paymentId' });
      return;
    }
    const result = await MonetizationService.getPaymentStatusForUser(userId, paymentId);
    if (!result.found) {
      res.status(404).json({ success: false, error: 'Платёж не найден' });
      return;
    }
    res.json({ success: true, data: { status: result.status, message: result.message } });
  } catch (error) {
    console.error('Ошибка получения статуса платежа:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Создать инвойс Telegram Stars (proxy к боту).
 * Цена в звёздах берётся из серверного прайса — клиентский starCount игнорируется.
 */
export const createStarsInvoice = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.token;
    const decoded = token ? (jwt.decode(token) as { userId: string }) : null;
    if (!decoded?.userId) {
      res.status(401).json({ error: 'Пользователь не авторизован' });
      return;
    }
    const { itemKey } = req.body || {};
    const { STARS_PRICES } = await import('../services/MonetizationService');
    const stars = STARS_PRICES[String(itemKey)];
    if (!stars) {
      res.status(400).json({ error: 'Неизвестный товар' });
      return;
    }
    const botUrl = (process.env.BOT_INTERNAL_URL || 'http://anoname-bot:7777').replace(/\/+$/, '');
    const secret = process.env.BOT_BACKEND_SECRET || '';
    if (!secret) {
      res.status(503).json({ error: 'Stars payments not configured' });
      return;
    }
    const response = await fetch(`${botUrl}/monetization/stars/invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': secret },
      body: JSON.stringify({ itemKey, starCount: stars })
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok || !data?.url) {
      logger.warn('stars_invoice_failed', { status: response.status, data });
      res.status(502).json({ error: 'Не удалось создать счёт. Попробуйте позже.' });
      return;
    }
    MonetizationService.trackPaymentEvent('payment_created', decoded.userId, { itemKey, stars, provider: 'stars' });
    res.json({ url: data.url });
  } catch (error) {
    logger.error('stars_invoice_error', { error: (error as Error)?.message });
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

/**
 * Активировать буст (приоритет в поиске на 30 минут, списывает 1 буст)
 */
export const useBoost = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.token;
    const decoded = token ? (jwt.decode(token) as { userId: string }) : null;
    if (!decoded?.userId) {
      res.status(401).json({ error: 'Пользователь не авторизован' });
      return;
    }
    const result = await MonetizationService.useBoost(decoded.userId);
    if (!result.success) {
      res.status(400).json({ success: false, error: result.message, data: { boostsLeft: result.boostsLeft, boostActiveUntil: result.boostActiveUntil } });
      return;
    }
    res.json({ success: true, data: { boostActiveUntil: result.boostActiveUntil, boostsLeft: result.boostsLeft } });
  } catch (error) {
    console.error('Ошибка активации буста:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
};

// Удалены супер-лайки и ежедневные пополнения как неиспользуемые в UI