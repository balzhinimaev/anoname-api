import express from 'express';
import rateLimit from 'express-rate-limit';
import { proxyMedia } from '../controllers/mediaController';

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
