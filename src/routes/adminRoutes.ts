import express from 'express';
import { authMiddleware, requireAdmin } from '../middleware/authMiddleware';
import { botAuth } from '../middleware/botAuth';
import {
  searchUsers,
  getUserById,
  getPrelaunchStats,
  getPrelaunchList,
  exportPrelaunchCsv,
  getLeadStats,
  getLeadList,
  exportLeadCsv,
  listLeadCampaigns,
  createLeadCampaign,
  getLeadCampaignById,
  updateLeadCampaign,
  deleteLeadCampaign,
  previewLeadCampaign,
  launchLeadCampaign,
  getMonetizationStats,
} from '../controllers/adminController';

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

// Монетизация: выручка/платежи/конверсия
router.get('/monetization/stats', getMonetizationStats as any);

// Лиды
router.get('/leads/stats', getLeadStats as any);
router.get('/leads/list', getLeadList as any);
router.get('/leads/export.csv', exportLeadCsv as any);

// Лид-кампании
router.get('/leads/campaigns', listLeadCampaigns as any);
router.get('/leads/campaigns/:id', getLeadCampaignById as any);
router.get('/leads/campaigns/:id/preview', previewLeadCampaign as any);
router.post('/leads/campaigns', botAuth as any, createLeadCampaign as any);
router.put('/leads/campaigns/:id', botAuth as any, updateLeadCampaign as any);
router.delete('/leads/campaigns/:id', botAuth as any, deleteLeadCampaign as any);
router.post('/leads/campaigns/:id/launch', botAuth as any, launchLeadCampaign as any);

export default router;


