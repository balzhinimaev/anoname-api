import express from 'express';
import os from 'os';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { proxyMedia } from '../controllers/mediaController';
import { uploadVoice, getVoice } from '../controllers/voiceController';
import { authMiddleware } from '../middleware/authMiddleware';
import config from '../config';

export const router = express.Router();

// Прокси публичный (чтобы работать в <img src> без заголовка авторизации),
// поэтому отдельный, более щедрый по картинкам, но ограниченный rate-limit.
const mediaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @swagger
 * /api/media/proxy:
 *   get:
 *     summary: Прокси изображения (скрывает IP зрителя от чужого сервера картинок)
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: image/* }
 */
router.get('/proxy', mediaLimiter, proxyMedia as express.RequestHandler);

// ===== Голосовые сообщения =====

// Оригинал записи кладётся во временный файл и удаляется в VoiceService сразу
// после транскода — на диске остаётся только обезличенный mp3.
const voiceUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: config.voice.maxUploadBytes, files: 1 },
});

const voiceSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const voiceGetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * @swagger
 * /api/media/voice:
 *   post:
 *     summary: Загрузка голосового сообщения (multipart, поле file; идемпотентно по clientId)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: создано (параллельно рассылается chat:message) }
 *       200: { description: повтор — уже существовало }
 */
router.post(
  '/voice',
  voiceSendLimiter,
  authMiddleware as express.RequestHandler,
  voiceUpload.single('file'),
  uploadVoice as express.RequestHandler
);

/**
 * @swagger
 * /api/media/voice/{messageId}:
 *   get:
 *     summary: Аудиофайл голосового (только участник чата)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: audio/mpeg }
 */
router.get(
  '/voice/:messageId',
  voiceGetLimiter,
  authMiddleware as express.RequestHandler,
  getVoice as express.RequestHandler
);

// Ошибки multer (например, превышение размера) — внятный код вместо общего 500
router.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({
      error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой (максимум 2 МБ)' : 'Некорректная загрузка',
    });
    return;
  }
  next(err);
});
