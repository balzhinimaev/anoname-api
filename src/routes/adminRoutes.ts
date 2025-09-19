import express from 'express';
import { authMiddleware, requireAdmin } from '../middleware/authMiddleware';
import { searchUsers, getUserById, getPrelaunchStats, getPrelaunchList, exportPrelaunchCsv } from '../controllers/adminController';

export const router = express.Router();

// Все маршруты требуют аутентификацию и права администратора
router.use(authMiddleware, requireAdmin);

// Поиск пользователей
router.get('/users', searchUsers as any);

// Профиль пользователя (по ObjectId или по telegramId)
router.get('/users/:id', getUserById as any);

// Предстартовая очередь
router.get('/prelaunch/stats', getPrelaunchStats as any);
router.get('/prelaunch/list', getPrelaunchList as any);
router.get('/prelaunch/export.csv', exportPrelaunchCsv as any);

export default router;


