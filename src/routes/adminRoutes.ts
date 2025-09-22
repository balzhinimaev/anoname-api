import express from 'express';
import { authMiddleware, requireAdmin } from '../middleware/authMiddleware';
import { searchUsers, getUserById, getPrelaunchStats, getPrelaunchList, exportPrelaunchCsv, getLeadStats, getLeadList, exportLeadCsv } from '../controllers/adminController';

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

// Лиды
router.get('/leads/stats', getLeadStats as any);
router.get('/leads/list', getLeadList as any);
router.get('/leads/export.csv', exportLeadCsv as any);

export default router;


