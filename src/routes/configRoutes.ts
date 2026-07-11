import express from 'express';
import { SettingsService } from '../services/SettingsService';

export const router = express.Router();

/**
 * Публичный конфиг для фронтендов (БЕЗ авторизации — читается до логина).
 * Только безобидные рантайм-флаги запуска; никаких секретов/внутренностей.
 * GET /api/config → { success, tmaPrelaunchEnabled }
 */
router.get('/', (_req, res) => {
  res.json({
    success: true,
    // «Закрытый клуб» TG мини-аппа (управляется из /admin/settings.html)
    tmaPrelaunchEnabled: SettingsService.flags.tmaPrelaunchEnabled,
  });
});

export default router;
