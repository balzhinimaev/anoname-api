/**
 * Маршруты для монетизации
 * @module routes/monetizationRoutes
 */

import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { 
  getUserStatus,
  getSubscriptionTiers, 
  getPurchaseItems,
  makePurchase,
  checkSearchAvailability,
  getSearchLimits,
  checkBoostAvailability,
  yookassaWebhook,
  starsPaymentSuccess
} from '../controllers/monetizationController';

const router = Router();

/**
 * @swagger
 * /api/monetization/status:
 *   get:
 *     summary: Получить статус пользователя
 *     tags: [Monetization]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Статус пользователя
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     subscription:
 *                       type: object
 *                     currency:
 *                       type: object
 *                     limits:
 *                       type: object
 *                     analytics:
 *                       type: object
 */
router.get('/status', authMiddleware as any, getUserStatus as any);

/**
 * @swagger
 * /api/monetization/tiers:
 *   get:
 *     summary: Получить доступные тарифы подписки
 *     tags: [Monetization]
 *     responses:
 *       200:
 *         description: Список тарифов
 */
router.get('/tiers', getSubscriptionTiers);

/**
 * @swagger
 * /api/monetization/items:
 *   get:
 *     summary: Получить доступные товары для покупки
 *     tags: [Monetization]
 *     responses:
 *       200:
 *         description: Список товаров
 */
router.get('/items', getPurchaseItems);

/**
 * @swagger
 * /api/monetization/purchase:
 *   post:
 *     summary: Совершить покупку
 *     tags: [Monetization]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - itemKey
 *             properties:
 *               itemKey:
 *                 type: string
 *                 enum: ["premium_1day", "premium_7days", "premium_forever", "boosts_1", "boosts_5"]
 *                 example: "premium_1day"
 *                 description: "Ключ товара для покупки"
 *     responses:
 *       200:
 *         description: Покупка успешна
 */
router.post('/purchase', authMiddleware as any, makePurchase as any);

/**
 * @swagger
 * /api/monetization/webhook/yookassa:
 *   post:
 *     summary: Вебхук от YooKassa
 *     tags: [Monetization]
 *     description: Обработка уведомлений о платеже
 *     responses:
 *       200:
 *         description: Вебхук обработан
 */
router.post('/webhook/yookassa', yookassaWebhook);

/**
 * @swagger
 * /api/monetization/stars/success:
 *   post:
 *     summary: Уведомление от бота об успешной оплате через Telegram Stars
 *     tags: [Monetization]
 *     description: Бекенд бота вызывает этот эндпоинт после получения successful_payment. Требуется заголовок X-API-Key.
 *     parameters:
 *       - in: header
 *         name: X-API-Key
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               telegramId:
 *                 type: string
 *               itemKey:
 *                 type: string
 *               starCount:
 *                 type: number
 *               successfulPayment:
 *                 type: object
 *     responses:
 *       200:
 *         description: Подписка активирована
 */
router.post('/stars/success', starsPaymentSuccess as any);

/**
 * @swagger
 * /api/monetization/check/search:
 *   get:
 *     summary: Проверить возможность поиска
 *     tags: [Monetization]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Информация о возможности поиска
 */
router.get('/check/search', authMiddleware as any, checkSearchAvailability as any);

/**
 * @swagger
 * /api/monetization/limits/search:
 *   get:
 *     summary: Получить лимиты поиска пользователя
 *     tags: [Monetization]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Детальная информация о лимитах поиска
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     searchesToday:
 *                       type: number
 *                     maxSearches:
 *                       type: number
 *                     unlimited:
 *                       type: boolean
 *                     remaining:
 *                       type: number
 *                     resetsAt:
 *                       type: string
 *                     subscriptionType:
 *                       type: string
 */
router.get('/limits/search', authMiddleware as any, getSearchLimits as any);

/**
 * @swagger
 * /api/monetization/check/boost:
 *   get:
 *     summary: Проверить возможность использования буста
 *     tags: [Monetization]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Информация о возможности использования буста
 */
router.get('/check/boost', authMiddleware as any, checkBoostAvailability as any);

// Удалены эндпоинты супер-лайков и ежедневного пополнения

export default router; 