/**
 * Маршруты аутентификации и управления сессиями
 * @module routes/auth
 */

import express from 'express';
import { body } from 'express-validator';
import * as authController from '../controllers/authController';
import { validateRequest } from '../middleware/validateRequest';
import { authMiddleware } from '../middleware/authMiddleware';

export const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       required:
 *         - telegramId
 *       properties:
 *         telegramId:
 *           type: number
 *           description: Уникальный идентификатор пользователя в Telegram
 *         username:
 *           type: string
 *           description: Имя пользователя в Telegram
 *         firstName:
 *           type: string
 *           description: Имя пользователя
 *         lastName:
 *           type: string
 *           description: Фамилия пользователя
 *         bio:
 *           type: string
 *           description: Описание профиля
 *         gender:
 *           type: string
 *           enum: [male, female, other]
 *           description: Пол пользователя
 *         age:
 *           type: number
 *           minimum: 18
 *           description: Возраст пользователя
 *     AuthResponse:
 *       type: object
 *       properties:
 *         token:
 *           type: string
 *           description: JWT токен для аутентификации
 *         user:
 *           $ref: '#/components/schemas/User'
 */

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     tags: [Аутентификация]
 *     summary: Регистрация нового пользователя
 *     description: Создает новый аккаунт пользователя в системе
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/User'
 *     responses:
 *       201:
 *         description: Пользователь успешно зарегистрирован
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         description: Ошибка валидации данных
 *       409:
 *         description: Пользователь уже существует
 */
router.post(
  '/register',
  [
    body('telegramId').isNumeric().withMessage('Неверный формат Telegram ID'),
    body('platform').equals('telegram').withMessage('platform должен быть "telegram"'),
    body('initData').isString().notEmpty().withMessage('initData обязателен'),
    body('exp').optional().isIn(['A','B']).withMessage('exp должен быть A или B'),
    body('referralCode').optional().isString(),
    body('campaign').optional().isString(),
    body('profilePhoto').optional().isString(),
  ],
  validateRequest as express.RequestHandler,
  authController.register as express.RequestHandler
);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     tags: [Аутентификация]
 *     summary: Аутентификация пользователя
 *     description: Аутентифицирует существующего пользователя и возвращает JWT токен. Поддерживает аутентификацию через Telegram initData или сервисный API-ключ.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - telegramId
 *             properties:
 *               telegramId:
 *                 type: number
 *                 description: Telegram ID пользователя
 *                 example: 1272270574
 *               initData:
 *                 type: string
 *                 description: Telegram WebApp initData строка (обязательна если REQUIRE_TG_INITDATA=true)
 *                 example: "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Vladislav%22%2C%22last_name%22%3A%22Kibenko%22%2C%22username%22%3A%22vdkfrost%22%2C%22language_code%22%3A%22ru%22%7D&auth_date=1662771648&hash=c501b71e775f74ce10e377dea85a7ea24ecd640b223ea86dfe453e0eaed2e2b2"
 *               platform:
 *                 type: string
 *                 description: Платформа клиента
 *                 example: "telegram"
 *               exp:
 *                 type: string
 *                 enum: [A, B]
 *                 description: Экспериментальная группа для A/B тестирования
 *     parameters:
 *       - in: header
 *         name: X-API-Key
 *         schema:
 *           type: string
 *         description: Сервисный API-ключ для технической аутентификации (альтернатива initData)
 *     responses:
 *       200:
 *         description: Успешная аутентификация
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       401:
 *         description: Неверные учетные данные или неверная подпись initData
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Неверная подпись Telegram initData"
 *                 code:
 *                   type: string
 *                   example: "HASH_MISSING"
 *       404:
 *         description: Пользователь не найден
 */
router.post(
  '/login',
  [
    body('telegramId').isNumeric().withMessage('Неверный формат Telegram ID'),
  ],
  validateRequest as express.RequestHandler,
  authController.login as express.RequestHandler
);

/**
 * @swagger
 * /api/auth/logout:
 *   post:
 *     tags: [Аутентификация]
 *     summary: Выход из системы
 *     description: Завершает текущую сессию пользователя
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Успешный выход из системы
 *       401:
 *         description: Не авторизован
 */
router.post(
  '/logout',
  authMiddleware as express.RequestHandler,
  authController.logout as express.RequestHandler
);

/**
 * @swagger
 * /api/auth/logout-all:
 *   post:
 *     tags: [Аутентификация]
 *     summary: Выход из всех сессий
 *     description: Завершает все активные сессии пользователя
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Успешный выход из всех сессий
 *       401:
 *         description: Не авторизован
 */
router.post(
  '/logout-all',
  authMiddleware as express.RequestHandler,
  authController.logoutAll as express.RequestHandler
); 