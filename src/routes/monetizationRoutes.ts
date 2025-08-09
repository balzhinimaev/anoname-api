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
  yookassaWebhook
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
 *               - paymentData
 *             properties:
 *               itemKey:
 *                 type: string
 *                 example: "boosts_1"
 *               paymentData:
 *                 type: object
 *                 example: { "payment_id": "12345", "amount": 59 }
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