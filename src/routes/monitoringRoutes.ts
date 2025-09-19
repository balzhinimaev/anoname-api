import express from 'express';
import { metricsCollector } from '../utils/metrics';
import { authMiddleware, requireAdmin } from '../middleware/authMiddleware';
import Report from '../models/Report';

const router = express.Router();

// Получение текущих метрик (защищенный маршрут)
router.get('/metrics', authMiddleware, requireAdmin, (_req, res) => {
  res.json(metricsCollector.getMetrics());
});

// Проверка здоровья системы (публичный маршрут)
router.get('/health', (_req, res) => {
  const metrics = metricsCollector.getMetrics();
  const status = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    services: {
      websocket: {
        status: metrics.connections.current >= 0 ? 'OK' : 'ERROR',
        activeConnections: metrics.connections.current
      },
      search: {
        status: metrics.searches.active >= 0 ? 'OK' : 'ERROR',
        activeSearches: metrics.searches.active
      }
    },
    performance: {
      messageLatency: `${metrics.latency.avg.toFixed(2)}ms`,
      messagesPerMinute: Math.round(metrics.messages.perMinute)
    },
    moderation: metrics.reports,
    errors: {
      count: metrics.errors.count,
      lastError: metrics.errors.lastError?.message
    }
  };

  const isHealthy = 
    status.services.websocket.status === 'OK' && 
    status.services.search.status === 'OK';

  res.status(isHealthy ? 200 : 503).json(status);
});

// Агрегированные метрики модерации: отчёт за 24 часа (защищенный маршрут)
router.get('/moderation/summary', authMiddleware, requireAdmin, async (_req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [total, byReason, open, actioned, ttaDocs] = await Promise.all([
      Report.countDocuments({ createdAt: { $gte: since } }),
      Report.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: '$reason', count: { $sum: 1 } } }
      ]),
      Report.countDocuments({ status: 'open' }),
      Report.countDocuments({ status: 'actioned', updatedAt: { $gte: since } }),
      Report.aggregate([
        { $match: { status: 'actioned', createdAt: { $gte: since } } },
        { $project: { ttaMs: { $subtract: ['$updatedAt', '$createdAt'] } } },
        { $sort: { ttaMs: 1 } }
      ])
    ]);

    // Рассчет p50/p90 по time-to-action (если есть данные)
    let p50: number | null = null;
    let p90: number | null = null;
    if (ttaDocs.length > 0) {
      const ms = ttaDocs.map((d: any) => d.ttaMs).filter((n: any) => typeof n === 'number');
      if (ms.length > 0) {
        const idx50 = Math.floor(0.5 * (ms.length - 1));
        const idx90 = Math.floor(0.9 * (ms.length - 1));
        p50 = ms[idx50];
        p90 = ms[idx90];
      }
    }

    res.json({
      since: since.toISOString(),
      total,
      byReason: Object.fromEntries(byReason.map((r: any) => [r._id, r.count])),
      open,
      actionedLast24h: actioned,
      ttaMs: { p50, p90 }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute moderation summary' });
  }
});

export { router as monitoringRouter }; 