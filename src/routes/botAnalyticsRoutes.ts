import express from 'express';
import AnalyticsEvent from '../models/AnalyticsEvent';
import logger from '../utils/logger';

const router = express.Router();

// Bot → Backend REST analytics endpoint secured by X-API-Key
router.post('/bot-event', async (req, res) => {
  try {
    const apiKey = (req.headers['x-api-key'] || req.headers['X-API-Key'] || '') as string;
    const expected = process.env.BOT_BACKEND_SECRET || '';
    if (!expected || !apiKey || apiKey !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { name, props, telegramId } = req.body || {};
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Invalid event name' });
      return;
    }

    logger.info('bot_event_received', { type: 'bot_event', name, telegramId, hasProps: Boolean(props) });

    try {
      await AnalyticsEvent.create({
        telegramId: telegramId ? String(telegramId) : undefined,
        name,
        props: props && typeof props === 'object' ? props : undefined,
        userAgent: String(req.headers['user-agent'] || ''),
        ip: req.ip
      } as any);
    } catch (e) {
      logger.warn('bot_event_persist_fail', { error: e instanceof Error ? e.message : String(e) });
    }

    res.json({ ok: true });
  } catch (e) {
    logger.error('bot_event_error', { error: e instanceof Error ? e.message : String(e) });
    res.status(500).json({ error: 'Internal error' });
  }
});

export { router as botAnalyticsRouter };


