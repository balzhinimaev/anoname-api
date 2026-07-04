import express, { Request } from 'express';
import logger from '../utils/logger';
import { authMiddleware, requireAdmin } from '../middleware/authMiddleware';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { getSummary, getTimeseries, getABConversion, getFunnel, getTimingSeries } from '../controllers/analyticsController';

export const router = express.Router();

/**
 * Простой приём событий аналитики от клиента (TMA)
 * Требует авторизации, чтобы связать с userId
 * body: { name: string; props?: object }
 */
router.post('/event', authMiddleware as express.RequestHandler, async (req: Request, res) => {
  try {
    const user = req.user;
    const { name, props } = req.body || {};
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Invalid event name' });
      return;
    }
    // Пишем в логи и сохраняем в БД
    const payload = {
      type: 'analytics_event',
      userId: user?.userId,
      telegramId: user?.telegramId,
      name,
      props: props && typeof props === 'object' ? props : undefined,
      ts: new Date().toISOString()
    };
    logger.info('analytics_event', payload);
    try {
      await AnalyticsEvent.create({
        userId: user?.userId ? (user?.userId as any) : undefined,
        telegramId: user?.telegramId,
        cohort: (req as any).userCohort,
        name,
        props: payload.props,
        deviceId: (req as any).deviceId,
        platform: (req as any).platform,
        userAgent: String(req.headers['user-agent'] || ''),
        ip: req.ip
      } as any);
    } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to log event' });
  }
});

// Агрегированные отчёты
router.get('/summary', authMiddleware as express.RequestHandler, requireAdmin as express.RequestHandler, getSummary as express.RequestHandler);
router.get('/timeseries', authMiddleware as express.RequestHandler, requireAdmin as express.RequestHandler, getTimeseries as express.RequestHandler);
router.get('/ab-conversion', authMiddleware as express.RequestHandler, requireAdmin as express.RequestHandler, getABConversion as express.RequestHandler);
router.post('/funnel', authMiddleware as express.RequestHandler, requireAdmin as express.RequestHandler, getFunnel as express.RequestHandler);
router.get('/timing-series', authMiddleware as express.RequestHandler, requireAdmin as express.RequestHandler, getTimingSeries as express.RequestHandler);


