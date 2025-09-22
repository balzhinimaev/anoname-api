import express from 'express';
import { botAuth } from '../middleware/botAuth';
import { addLead, getStats } from '../controllers/leadController';

export const router = express.Router();

// Все маршруты требуют проверку BOT_BACKEND_SECRET
router.use(botAuth);

// Добавить лида
router.post('/add', addLead);

// Получить статистику лидов
router.get('/stats', getStats);

export default router;
