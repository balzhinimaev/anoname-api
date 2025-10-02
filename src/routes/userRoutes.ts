/**
 * Маршруты для управления пользователями
 * @module routes/users
 */

import express, { Request } from 'express';
import { body } from 'express-validator';
import * as userController from '../controllers/userController';
import User from '../models/User';
import { validateRequest } from '../middleware/validateRequest';
import { authMiddleware } from '../middleware/authMiddleware';
import { ensureOwnerOrAdminByParam } from '../middleware/ownership';
import { ReferralService } from '../services/ReferralService';
import { BlockService } from '../services/BlockService';

export const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     UserPreferences:
 *       type: object
 *       properties:
 *         gender:
 *           type: string
 *           enum: [male, female, any]
 *           description: Предпочитаемый пол для поиска
 *         ageRange:
 *           type: object
 *           properties:
 *             min:
 *               type: integer
 *               minimum: 18
 *               description: Минимальный возраст
 *             max:
 *               type: integer
 *               maximum: 100
 *               description: Максимальный возраст
 *     PhotoResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           description: Уникальный идентификатор фотографии
 *         url:
 *           type: string
 *           description: URL фотографии
 *         uploadedAt:
 *           type: string
 *           format: date-time
 *           description: Время загрузки фотографии
 */

/**
 * @swagger
 * /api/users:
 *   post:
 *     tags: [Пользователи]
 *     summary: Создание или обновление пользователя
 *     description: Создает нового пользователя или обновляет существующего
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/User'
 *     responses:
 *       200:
 *         description: Пользователь успешно создан/обновлен
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Ошибка валидации данных
 *       401:
 *         description: Не авторизован
 */
router.post(
	'/',
	[
		body('username').optional(),
		body('firstName').optional(),
		body('lastName').optional(),
		body('bio').optional(),
		body('gender').optional().isIn(['male', 'female', 'other']),
		body('age').optional().isInt({ min: 18 }),
	],
	validateRequest as express.RequestHandler,
	userController.createOrUpdateUser as express.RequestHandler
);

/**
 * Получить/сгенерировать реферальный код текущего пользователя
 */
router.get('/me/referral-code', authMiddleware as express.RequestHandler, async (req: Request, res) => {
  try {
    if (!req.user?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const code = await ReferralService.ensureReferralCode(req.user.userId);
    res.json({ code });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get referral code' });
  }
});

/**
 * Список приглашённых мной пользователей (рефералы)
 * Поддерживает пагинацию через query params: page (>=1), limit (1..100)
 */
router.get('/me/referrals', authMiddleware as express.RequestHandler, async (req: Request, res: express.Response) => {
  try {
    if (!req.user?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const pageRaw: string | undefined = Array.isArray(req.query.page) ? String(req.query.page[0]) : (req.query.page as string | undefined);
    const limitRaw: string | undefined = Array.isArray(req.query.limit) ? String(req.query.limit[0]) : (req.query.limit as string | undefined);
    const page = Math.max(1, Number.parseInt(pageRaw || '1', 10));
    const limit = Math.min(100, Math.max(1, Number.parseInt(limitRaw || '20', 10)));
    const skip = (page - 1) * limit;

    const [referredUsers, total] = await Promise.all([
      User.find({ referredBy: req.user.userId })
        .select('telegramId username firstName lastName createdAt cohort profilePhoto campaign')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      User.countDocuments({ referredBy: req.user.userId })
    ]);

    res.json({
      users: referredUsers.map(u => ({
        telegramId: u.telegramId,
        username: u.username,
        firstName: u.firstName,
        lastName: u.lastName,
        cohort: (u as any).cohort,
        profilePhoto: (u as any).profilePhoto,
        campaign: (u as any).campaign,
        createdAt: (u as any).createdAt
      })),
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch referrals' });
  }
});

/**
 * @swagger
 * /api/users/me:
 *   get:
 *     tags: [Пользователи]
 *     summary: Профиль текущего пользователя
 *     description: Возвращает полный профиль текущего пользователя (владельца токена)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Профиль пользователя
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Не авторизован
 */
router.get('/me', userController.getMe as express.RequestHandler);

/**
 * @swagger
 * /api/users/{telegramId}:
 *   get:
 *     tags: [Пользователи]
 *     summary: Получение профиля пользователя
 *     description: Возвращает профиль пользователя по его Telegram ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: telegramId
 *         required: true
 *         schema:
 *           type: number
 *         description: Telegram ID пользователя
 *     responses:
 *       200:
 *         description: Профиль пользователя
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       404:
 *         description: Пользователь не найден
 *       401:
 *         description: Не авторизован
 */
router.get('/:telegramId', userController.getUser as express.RequestHandler);

// Устаревший маршрут, оставлен для обратной совместимости (можно удалить позже)
// router.get('/me/profile', userController.getMe as express.RequestHandler);

/**
 * @swagger
 * /api/users/{telegramId}/matches:
 *   get:
 *     tags: [Пользователи]
 *     summary: Получение потенциальных партнеров
 *     description: Возвращает список потенциальных партнеров согласно предпочтениям пользователя
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: telegramId
 *         required: true
 *         schema:
 *           type: number
 *         description: Telegram ID пользователя
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 20
 *         description: Количество результатов на странице
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Номер страницы
 *     responses:
 *       200:
 *         description: Список потенциальных партнеров
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/User'
 *                 total:
 *                   type: integer
 *                   description: Общее количество найденных пользователей
 *                 pages:
 *                   type: integer
 *                   description: Общее количество страниц
 *       401:
 *         description: Не авторизован
 */
router.get('/:telegramId/matches', ensureOwnerOrAdminByParam as express.RequestHandler, userController.getPotentialMatches as express.RequestHandler);

/**
 * @swagger
 * /api/users/{telegramId}/preferences:
 *   put:
 *     tags: [Пользователи]
 *     summary: Обновление предпочтений пользователя
 *     description: Обновляет предпочтения пользователя для поиска партнеров
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: telegramId
 *         required: true
 *         schema:
 *           type: number
 *         description: Telegram ID пользователя
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UserPreferences'
 *     responses:
 *       200:
 *         description: Предпочтения успешно обновлены
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Ошибка валидации данных
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Пользователь не найден
 */
router.put(
	'/:telegramId/preferences',
	[
		body('gender').optional().isIn(['male', 'female', 'any']),
		body('ageRange.min').optional().isInt({ min: 18 }),
		body('ageRange.max').optional().isInt({ max: 100 }),
	],
	validateRequest as express.RequestHandler,
	ensureOwnerOrAdminByParam as express.RequestHandler,
	userController.updatePreferences as express.RequestHandler
);

/**
 * @swagger
 * /api/users/{telegramId}/photos:
 *   post:
 *     tags: [Пользователи]
 *     summary: Загрузка фотографий
 *     description: Загружает новые фотографии в профиль пользователя
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: telegramId
 *         required: true
 *         schema:
 *           type: number
 *         description: Telegram ID пользователя
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               photos:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: Файлы фотографий (максимум 5)
 *     responses:
 *       200:
 *         description: Фотографии успешно загружены
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PhotoResponse'
 *       400:
 *         description: Ошибка валидации или превышен лимит фотографий
 *       401:
 *         description: Не авторизован
 *       413:
 *         description: Размер файла превышает лимит
 */
router.post('/:telegramId/photos', ensureOwnerOrAdminByParam as express.RequestHandler, userController.uploadPhotos as express.RequestHandler);

/**
 * @swagger
 * /api/users/{telegramId}/photos/{photoId}:
 *   delete:
 *     tags: [Пользователи]
 *     summary: Удаление фотографии
 *     description: Удаляет фотографию из профиля пользователя
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: telegramId
 *         required: true
 *         schema:
 *           type: number
 *         description: Telegram ID пользователя
 *       - in: path
 *         name: photoId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID фотографии
 *     responses:
 *       200:
 *         description: Фотография успешно удалена
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Фотография не найдена
 */
router.delete('/:telegramId/photos/:photoId', ensureOwnerOrAdminByParam as express.RequestHandler, userController.deletePhoto as express.RequestHandler);

/**
 * Блокировка пользователя (по userId в теле запроса)
 */
router.post('/me/block', authMiddleware as express.RequestHandler, [
  body('userId').isString().isLength({ min: 24, max: 24 }),
  body('reason').optional().isString().isLength({ max: 500 }),
  body('expiresAt').optional().isISO8601()
], validateRequest as express.RequestHandler, async (req: Request, res: express.Response) => {
  try {
    if (!req.user?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const { userId, reason, expiresAt } = req.body as { userId: string; reason?: string; expiresAt?: string };
    const block = await BlockService.blockUser(req.user.userId, userId, reason, expiresAt ? new Date(expiresAt) : undefined);
    res.json({ ok: true, blockId: block._id });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * Разблокировка пользователя
 */
router.post('/me/unblock', authMiddleware as express.RequestHandler, [
  body('userId').isString().isLength({ min: 24, max: 24 })
], validateRequest as express.RequestHandler, async (req: Request, res: express.Response) => {
  try {
    if (!req.user?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const { userId } = req.body as { userId: string };
    await BlockService.unblockUser(req.user.userId, userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * Список заблокированных мной пользователей
 */
router.get('/me/blocked', authMiddleware as express.RequestHandler, async (req: Request, res: express.Response) => {
  try {
    if (!req.user?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const withProfilesRaw: string | undefined = Array.isArray(req.query.withProfiles) ? String(req.query.withProfiles[0]) : (req.query.withProfiles as string | undefined);
    const withProfiles = withProfilesRaw === '1' || withProfilesRaw === 'true';

    const list = await BlockService.listBlockedUsers(req.user.userId);
    if (!withProfiles) {
      res.json({ users: list.map(d => ({ userId: d.blockedUserId, reason: (d as any).reason, expiresAt: (d as any).expiresAt })) });
      return;
    }
    const userIds = list.map((d: any) => d.blockedUserId);
    const profiles = await User.find({ _id: { $in: userIds } }).select('telegramId username firstName lastName profilePhoto');
    const profileById = new Map<string, any>(profiles.map((u: any) => [String(u._id), u]));
    res.json({ users: list.map((d: any) => ({
      userId: d.blockedUserId,
      reason: d.reason,
      expiresAt: d.expiresAt,
      profile: profileById.get(String(d.blockedUserId)) || null
    })) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch blocked users' });
  }
});

/**
 * Список пользователей, которые заблокировали меня
 */
router.get('/me/blocked-by', authMiddleware as express.RequestHandler, async (req: Request, res: express.Response) => {
  try {
    if (!req.user?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const withProfilesRaw: string | undefined = Array.isArray(req.query.withProfiles) ? String(req.query.withProfiles[0]) : (req.query.withProfiles as string | undefined);
    const withProfiles = withProfilesRaw === '1' || withProfilesRaw === 'true';

    const list = await BlockService.listUsersWhoBlockedMe(req.user.userId);
    if (!withProfiles) {
      res.json({ users: list.map(d => ({ userId: (d as any).blockerUserId, reason: (d as any).reason, expiresAt: (d as any).expiresAt })) });
      return;
    }
    const userIds = list.map((d: any) => d.blockerUserId);
    const profiles = await User.find({ _id: { $in: userIds } }).select('telegramId username firstName lastName profilePhoto');
    const profileById = new Map<string, any>(profiles.map((u: any) => [String(u._id), u]));
    res.json({ users: list.map((d: any) => ({
      userId: d.blockerUserId,
      reason: d.reason,
      expiresAt: d.expiresAt,
      profile: profileById.get(String(d.blockerUserId)) || null
    })) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch users who blocked me' });
  }
});

/**
 * Обновить фото профиля текущего пользователя
 */
router.put('/me/profile-photo', authMiddleware as express.RequestHandler, [
  body('url').isString().isLength({ min: 1 }).withMessage('url обязателен')
], validateRequest as express.RequestHandler, async (req: Request, res: express.Response) => {
  try {
    if (!req.user?.userId) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const { url } = req.body as { url: string };
    const updated = await User.findByIdAndUpdate(req.user.userId, { $set: { profilePhoto: url } }, { new: true }).select('telegramId username profilePhoto');
    if (!updated) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
    res.json({ profilePhoto: (updated as any).profilePhoto });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update profile photo' });
  }
});

router.get(
  "/:telegramId/can-search",
  ensureOwnerOrAdminByParam as express.RequestHandler,
  userController.canSearch as express.RequestHandler
);

router.get(
  "/:telegramId/search-limits",
  ensureOwnerOrAdminByParam as express.RequestHandler,
  userController.getSearchLimits as express.RequestHandler
);
