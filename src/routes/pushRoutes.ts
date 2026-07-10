/**
 * Web Push: подписка/отписка браузера и публичный VAPID-ключ
 * @module routes/pushRoutes
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { authMiddleware } from '../middleware/authMiddleware';
import WebPushService from '../services/WebPushService';

const router = Router();

const userIdFromReq = (req: Request): string | null => {
  const token = req.token;
  if (!token) return null;
  const decoded = jwt.decode(token) as { userId?: string } | null;
  return decoded?.userId || null;
};

/**
 * @swagger
 * /api/push/vapid-public-key:
 *   get:
 *     summary: Публичный VAPID-ключ для подписки браузера
 *     tags: [Push]
 *     responses:
 *       200:
 *         description: Ключ (пустой, если Web Push не сконфигурирован)
 */
router.get('/vapid-public-key', (_req: Request, res: Response) => {
  res.json({ success: true, data: { publicKey: WebPushService.publicKey, enabled: WebPushService.enabled } });
});

/**
 * @swagger
 * /api/push/subscribe:
 *   post:
 *     summary: Сохранить Web Push подписку браузера
 *     tags: [Push]
 *     security:
 *       - bearerAuth: []
 */
router.post('/subscribe', authMiddleware as any, (async (req: Request, res: Response) => {
  try {
    const userId = userIdFromReq(req);
    if (!userId) { res.status(401).json({ error: 'Пользователь не авторизован' }); return; }
    const { subscription } = req.body || {};
    const ok = await WebPushService.subscribe(userId, subscription, req.headers['user-agent'] as string);
    if (!ok) { res.status(400).json({ success: false, error: 'Некорректная подписка' }); return; }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}) as any);

/**
 * @swagger
 * /api/push/unsubscribe:
 *   post:
 *     summary: Удалить Web Push подписку браузера
 *     tags: [Push]
 *     security:
 *       - bearerAuth: []
 */
router.post('/unsubscribe', authMiddleware as any, (async (req: Request, res: Response) => {
  try {
    const userId = userIdFromReq(req);
    if (!userId) { res.status(401).json({ error: 'Пользователь не авторизован' }); return; }
    const { endpoint } = req.body || {};
    await WebPushService.unsubscribe(userId, String(endpoint || ''));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}) as any);

export default router;
