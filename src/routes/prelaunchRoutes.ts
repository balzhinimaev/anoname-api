import express from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { PrelaunchService } from '../services/PrelaunchService';

export const router = express.Router();

// Защищенный эндпоинт: статистика с информацией о пользователе (требует Bearer токен)
router.get('/stats', authMiddleware as any, async (req: any, res) => {
  try {
    if (!req.user?.userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const stats = await PrelaunchService.getStatsWithUserInfo(req.user.userId);
    res.json(stats);
  } catch (error) {
    console.error('Error getting prelaunch stats:', error);
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


