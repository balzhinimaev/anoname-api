/**
 * Маршруты для управления чатами и сообщениями
 * @module routes/chats
 */

import express from 'express';
import { body } from 'express-validator';
import * as chatController from '../controllers/chatController';
import { validateRequest } from '../middleware/validateRequest';

export const router = express.Router();

/**
 * @swagger
 * components:
 *   schemas:
 *     Message:
 *       type: object
 *       required:
 *         - content
 *         - sender
 *       properties:
 *         content:
 *           type: string
 *           description: Текст сообщения
 *         sender:
 *           type: string
 *           format: mongoId
 *           description: ID отправителя
 *         timestamp:
 *           type: string
 *           format: date-time
 *           description: Время отправки сообщения
 *         isRead:
 *           type: boolean
 *           description: Статус прочтения сообщения
 *     Chat:
 *       type: object
 *       required:
 *         - participants
 *       properties:
 *         participants:
 *           type: array
 *           items:
 *             type: string
 *             format: mongoId
 *           description: Массив ID участников чата
 *         messages:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Message'
 *         lastMessage:
 *           $ref: '#/components/schemas/Message'
 *         type:
 *           type: string
 *           enum: [anonymous, permanent]
 *           description: Тип чата
 *         isActive:
 *           type: boolean
 *           description: Статус активности чата
 *         expiresAt:
 *           type: string
 *           format: date-time
 *           description: Время истечения анонимного чата
 */

/**
 * @swagger
 * /api/chats:
 *   post:
 *     tags: [Чаты]
 *     summary: Создание нового чата
 *     description: Создает новый чат между пользователями
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - participants
 *             properties:
 *               participants:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: mongoId
 *                 minItems: 2
 *                 maxItems: 2
 *                 description: ID участников чата
 *               type:
 *                 type: string
 *                 enum: [anonymous, permanent]
 *                 default: anonymous
 *     responses:
 *       201:
 *         description: Чат успешно создан
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Chat'
 *       400:
 *         description: Ошибка валидации данных
 *       401:
 *         description: Не авторизован
 */
router.post(
  '/',
  [
    body('participants').isArray().withMessage('Participants должен быть массивом'),
    body('participants.*').isMongoId().withMessage('Неверный ID участника'),
  ],
  validateRequest as express.RequestHandler,
  chatController.createChat as express.RequestHandler
);

/**
 * @swagger
 * /api/chats/user/{userId}:
 *   get:
 *     tags: [Чаты]
 *     summary: Получение чатов пользователя
 *     description: Возвращает список всех активных чатов пользователя
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: mongoId
 *         description: ID пользователя
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [anonymous, permanent, all]
 *         description: Фильтр по типу чата
 *     responses:
 *       200:
 *         description: Список чатов
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Chat'
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Пользователь не найден
 */
router.get('/user/:userId', chatController.getUserChats as express.RequestHandler);

/**
 * @swagger
 * /api/chats/{chatId}/messages:
 *   get:
 *     tags: [Чаты]
 *     summary: Получение сообщений чата
 *     description: Возвращает историю сообщений чата
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *           format: mongoId
 *         description: ID чата
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *         description: Количество сообщений
 *       - in: query
 *         name: before
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Получить сообщения до указанной даты
 *     responses:
 *       200:
 *         description: История сообщений
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Message'
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Чат не найден
 */
router.get('/:chatId/messages', chatController.getChatMessages as express.RequestHandler);

/**
 * @swagger
 * /api/chats/{chatId}/messages:
 *   post:
 *     tags: [Чаты]
 *     summary: Отправка сообщения
 *     description: Отправляет новое сообщение в чат
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *           format: mongoId
 *         description: ID чата
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *               - sender
 *             properties:
 *               content:
 *                 type: string
 *                 description: Текст сообщения
 *               sender:
 *                 type: string
 *                 format: mongoId
 *                 description: ID отправителя
 *     responses:
 *       201:
 *         description: Сообщение успешно отправлено
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Message'
 *       400:
 *         description: Ошибка валидации данных
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Чат не найден
 */
router.post(
  '/:chatId/messages',
  [
    body('content').notEmpty().withMessage('Сообщение не может быть пустым'),
  ],
  validateRequest as express.RequestHandler,
  chatController.sendMessage as express.RequestHandler
);

/**
 * @swagger
 * /api/chats/{chatId}/messages/read:
 *   put:
 *     tags: [Чаты]
 *     summary: Отметить сообщения как прочитанные
 *     description: Отмечает все непрочитанные сообщения в чате как прочитанные
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *           format: mongoId
 *         description: ID чата
 *     responses:
 *       200:
 *         description: Сообщения отмечены как прочитанные
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Чат не найден
 */
router.put('/:chatId/messages/read', chatController.markMessagesAsRead as express.RequestHandler);

/**
 * @swagger
 * /api/chats/{chatId}:
 *   delete:
 *     tags: [Чаты]
 *     summary: Деактивация чата
 *     description: Деактивирует чат (мягкое удаление)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: chatId
 *         required: true
 *         schema:
 *           type: string
 *           format: mongoId
 *         description: ID чата
 *     responses:
 *       200:
 *         description: Чат успешно деактивирован
 *       401:
 *         description: Не авторизован
 *       404:
 *         description: Чат не найден
 */
router.delete('/:chatId', chatController.deactivateChat as express.RequestHandler); 

/**
 * Сохранить чат для текущего пользователя
 */
router.post('/:chatId/save', chatController.saveChat as express.RequestHandler);

/**
 * Удалить чат из сохранённых текущего пользователя
 */
router.post('/:chatId/unsave', chatController.unsaveChat as express.RequestHandler);

/**
 * Получить список сохранённых чатов текущего пользователя
 */
router.get('/saved/list', chatController.getSavedChats as express.RequestHandler);

/**
 * История всех чатов пользователя с агрегированной статистикой
 */
router.get('/history/all', chatController.getUserChatHistory as express.RequestHandler);