import express from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { PrelaunchService } from '../services/PrelaunchService';

export const router = express.Router();

// Публичный эндпоинт: текущий счётчик
router.get('/stats', async (_req, res) => {
  try {
    const count = await PrelaunchService.getCount();
    res.json({ count });
  } catch {
    res.status(500).json({ error: 'Failed to get prelaunch stats' });
  }
});

// Защищенный эндпоинт: присоединиться (после получения JWT при регистрации/логине)
router.post('/join', authMiddleware as any, async (req: any, res) => {
  try {
    if (!req.user?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const result = await PrelaunchService.join(req.user.userId);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to join prelaunch' });
  }
});

export default router;


