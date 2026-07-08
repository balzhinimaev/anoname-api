import express, { Request } from 'express';
import logger from '../utils/logger';
import { authMiddleware, requireAdmin } from '../middleware/authMiddleware';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { getSummary, getTimeseries, getABConversion, getFunnel, getTimingSeries, getSearchReport, triggerSearchDigest } from '../controllers/analyticsController';

export const router = express.Router();

// Доступ к отчёту поиска: админ (JWT) ИЛИ статический ключ (для дашборда).
const ANALYTICS_KEY = process.env.ANALYTICS_ADMIN_TOKEN || '';
const keyOrAdmin: express.RequestHandler[] = [
  (req, _res, next) => { if (ANALYTICS_KEY && req.query.key === ANALYTICS_KEY) { (req as any)._keyOk = true; } next(); },
  (req, res, next) => (req as any)._keyOk ? next() : (authMiddleware as express.RequestHandler)(req, res, next),
  (req, res, next) => (req as any)._keyOk ? next() : (requireAdmin as express.RequestHandler)(req, res, next),
];
router.get('/search', ...keyOrAdmin, getSearchReport as express.RequestHandler);
router.post('/search/digest', ...keyOrAdmin, triggerSearchDigest as express.RequestHandler);

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


