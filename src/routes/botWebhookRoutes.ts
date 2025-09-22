import express from 'express';
import logger from '../utils/logger';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { botAuth } from '../middleware/botAuth';
import { getPrelaunchStats } from '../controllers/botController';

const router = express.Router();

// Telegram Bot webhook endpoint secured by header 'X-Telegram-Bot-Api-Secret-Token'
router.post('/webhook', async (req, res) => {
  try {
    const secretHeader = (req.headers['x-telegram-bot-api-secret-token'] || req.headers['X-Telegram-Bot-Api-Secret-Token'] || '') as string;
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET || '';
    if (!expected || !secretHeader || secretHeader !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const update = req.body || {};

    // Minimal extraction to link event with a user when possible
    const extractTelegramId = (): string | undefined => {
      try {
        if (update.message?.from?.id) return String(update.message.from.id);
        if (update.callback_query?.from?.id) return String(update.callback_query.from.id);
        if (update.chat_member?.from?.id) return String(update.chat_member.from.id);
        if (update.my_chat_member?.from?.id) return String(update.my_chat_member.from.id);
      } catch {}
      return undefined;
    };

    const tgId = extractTelegramId();
    const updateType = Object.keys(update)[0] || 'unknown';
    const command = typeof update.message?.text === 'string' && update.message.text.startsWith('/') ? update.message.text.split(' ')[0] : undefined;
    const hasWebAppData = Boolean(update.message?.web_app_data);

    logger.info('telegram_webhook_update', {
      type: 'telegram_webhook_update',
      updateType,
      hasWebAppData,
      command,
    });

    // Store generic analytics event (best-effort, non-blocking)
    try {
      await AnalyticsEvent.create({
        telegramId: tgId,
        name: 'bot_update',
        props: {
          updateType,
          command,
          hasWebAppData
        },
        userAgent: String(req.headers['user-agent'] || ''),
        ip: req.ip
      } as any);
    } catch {}

    // Always 200 quickly; bot service (Telegraf) должен отвечать пользователю отдельно
    res.json({ ok: true });
  } catch (e) {
    logger.error('telegram_webhook_error', { error: e instanceof Error ? e.message : String(e) });
    res.status(500).json({ error: 'Internal error' });
  }
});

// Bot prelaunch stats endpoint secured by BOT_BACKEND_SECRET
router.get('/prelaunch/stats', botAuth, getPrelaunchStats);

export { router as botWebhookRouter };


