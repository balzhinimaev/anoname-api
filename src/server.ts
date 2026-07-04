/**
 * Основной файл сервера приложения для анонимного чата.
 * @module server
 */

import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import { router as userRouter } from './routes/userRoutes';
import { router as chatRouter } from './routes/chatRoutes';
import { router as authRouter } from './routes/authRoutes';
import { router as searchRouter } from './routes/searchRoutes';
import monetizationRouter from './routes/monetizationRoutes';
import { monitoringRouter } from './routes/monitoringRoutes';
import { router as adminRouter } from './routes/adminRoutes';
import { router as analyticsRouter } from './routes/analyticsRoutes';
import { router as mediaRouter } from './routes/mediaRoutes';
import { botWebhookRouter } from './routes/botWebhookRoutes';
import { botAnalyticsRouter } from './routes/botAnalyticsRoutes';
import { authMiddleware } from './middleware/authMiddleware';
import mongoose from 'mongoose';
import config from './config';
import { WebSocketManager } from './websocket/WebSocketManager';
import prelaunchRouter from './routes/prelaunchRoutes';
import { router as leadRouter } from './routes/leadRoutes';
import User from './models/User';
import Token from './models/Token';
import logger from './utils/logger';
import { metricsCollector } from './utils/metrics';
import { basicAuth } from './middleware/basicAuth';

dotenv.config();

const app = express();
// Доверяем заголовкам прокси (X-Forwarded-*) для корректной работы HTTPS/CORS/куки за обратным прокси
app.set('trust proxy', 1);
const httpServer = createServer(app);
const port = process.env.PORT || 3001;

/**
 * Базовые защитные миддлвары и парсеры
 */
// Безопасные заголовки. Отключаем CSP для корректной работы Swagger UI и статических ассетов
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // HSTS: форсируем HTTPS на год (nginx тоже выставит — defense-in-depth)
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true }
}));

// CORS: белый список и regex-паттерны из окружения. Разрешаем также запросы без Origin (curl, моб. WebView)
const isCorsAllowed = (origin?: string | null): boolean => {
  if (!origin) return true;
  if (origin === config.clientUrl) return true;
  if (config.corsWhitelist.includes(origin)) return true;
  if (config.corsRegexps.some((re) => re.test(origin))) return true;
  return false;
};

app.use(cors({
  origin(origin, callback) {
    if (isCorsAllowed(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Защита от HTTP Parameter Pollution
app.use(hpp());

// Парсеры тела с лимитами. JSON — сохраняем сырой буфер для проверки подписи вебхуков
app.use(express.json({
  limit: '256kb',
  verify: (req: any, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));
app.use(express.urlencoded({ limit: '256kb', extended: true }));

// Rate limiting
// Примеры лимитеров (готовы к применению на чувствительные маршруты)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
});

// Строгий лимитер на создание аккаунтов (анти-спам БД + Telegram-канала уведомлений).
// НЕ применяем к /api/auth/vk — это и логин (вызывается на каждый открытие апп).
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
});

/**
 * Swagger UI: в проде закрываем. Если заданы SWAGGER_USER/PASSWORD — требуем basic auth.
 * В dev/test — открыто без ограничения.
 */
if (config.env === 'production') {
  if (config.swagger.user && config.swagger.password) {
    app.use('/api-docs', basicAuth(config.swagger.user, config.swagger.password), swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'API Документация | Анонимный чат',
    }));
    app.get('/api-docs.json', basicAuth(config.swagger.user, config.swagger.password), (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(swaggerSpec);
    });
  } else {
    app.get(['/api-docs', '/api-docs.json'], (_req, res) => {
      res.status(404).send('Not found');
    });
  }
} else {
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'API Документация | Анонимный чат',
  }));
  app.get('/api-docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerSpec);
  });
}

/**
 * Инициализация WebSocket менеджера для обработки реал-тайм соединений
 */
export const wsManager = new WebSocketManager(httpServer);

// Публичные маршруты (не требуют аутентификации)
// Строгий лимитер именно на регистрацию (до общего authLimiter).
app.use(['/api/auth/register', '/api/auth/web/register'], registerLimiter);
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/monitoring', monitoringRouter);
app.use('/api/admin', adminRouter);
app.use('/api/analytics', apiLimiter, analyticsRouter);
app.use('/api/media', mediaRouter);
app.use('/api/prelaunch', apiLimiter, prelaunchRouter);
app.use('/api/leads', apiLimiter, leadRouter);
app.use('/api/telegram', botWebhookRouter);
app.use('/api/analytics', botAnalyticsRouter);
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'OK' });
});

// Защищенные маршруты (требуют аутентификации)
app.use('/api/users', apiLimiter, authMiddleware, userRouter);
app.use('/api/chats', apiLimiter, authMiddleware, chatRouter);
app.use('/api/search', apiLimiter, searchRouter);
// Маршруты монетизации: вебхук должен быть публичным, остальные защищаем внутри самого роутера
app.use('/api/monetization', monetizationRouter);

// Error handling middleware
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Необработанная ошибка:', {
    error: {
      message: err.message,
      stack: err.stack
    }
  });
  metricsCollector.errorOccurred(err);
  res.status(500).json({ error: 'Что-то пошло не так!' });
});

/**
 * Настройка автоматической очистки устаревших токенов
 * @function setupTokenCleanup
 */
const setupTokenCleanup = () => {
  const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 часа
  setInterval(async () => {
    try {
      const deletedCount = await Token.cleanupExpiredTokens();
      logger.info(`[Токены] Удалено ${deletedCount} устаревших токенов`);
    } catch (error) {
      logger.error('[Токены] Ошибка при очистке:', error);
      if (error instanceof Error) {
        metricsCollector.errorOccurred(error);
      }
    }
  }, CLEANUP_INTERVAL);
};

/**
 * Запуск сервера и инициализация всех необходимых компонентов
 * @async
 * @function startServer
 * @throws {Error} Ошибка подключения к MongoDB или запуска сервера
 */
const startServer = async () => {
  try {
    // Подключение к MongoDB
    await mongoose.connect(config.mongoUri, {
      dbName: "anoname"
    });
    logger.info('Connected to MongoDB');
    
    // Сбрасываем онлайн-статусы при старте, чтобы удалить "зависших" онлайнов
    try {
      const result = await User.updateMany({}, { $set: { isOnline: false } });
      logger.info(`Reset isOnline for all users on startup`, {
        matched: (result as any).matchedCount ?? undefined,
        modified: (result as any).modifiedCount ?? undefined
      });
    } catch (e) {
      logger.warn('Failed to reset isOnline on startup');
    }
    
    // Запуск очистки токенов
    setupTokenCleanup();
    
    // Запуск сервера
    httpServer.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
    });

    // Грейсфул-шатдаун: при завершении процесса помечаем всех оффлайн
    const handleShutdown = async (signal: string) => {
      try {
        logger.info(`[${signal}] Shutting down, resetting online statuses`);
        await User.updateMany({}, { $set: { isOnline: false } });
      } catch (e) {
        logger.warn('Failed to reset isOnline on shutdown');
      } finally {
        httpServer.close(() => process.exit(0));
        // На случай зависания
        setTimeout(() => process.exit(0), 3000).unref();
      }
    };
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('uncaughtException', async (err) => {
      logger.error('Uncaught exception', { error: err instanceof Error ? { message: err.message, stack: err.stack } : err });
      await handleShutdown('UNCAUGHT_EXCEPTION');
    });
    // ВАЖНО: unhandledRejection НЕ роняет сервер — один пропущенный .catch
    // в fire-and-forget промисе не должен обрывать все WS-чаты и in-memory игры.
    // Логируем и продолжаем; критичные ошибки всплывут в метриках/логах.
    process.on('unhandledRejection', (reason: any) => {
      logger.error('Unhandled rejection (продолжаем работу)', { reason });
      if (reason instanceof Error) metricsCollector.errorOccurred(reason);
    });

    // Периодическая валидация онлайн-статуса по lastActive (TTL 60с)
    const ONLINE_TTL_MS = Number(process.env.ONLINE_TTL_MS || 60_000);
    setInterval(async () => {
      try {
        const threshold = new Date(Date.now() - ONLINE_TTL_MS);
        await User.updateMany({ lastActive: { $lte: threshold } }, { $set: { isOnline: false } });
      } catch (err) {
        logger.warn('Online TTL cleanup failed', err);
      }
    }, Math.max(ONLINE_TTL_MS / 2, 10_000));
  } catch (error) {
    logger.error('Ошибка при запуске сервера:', error);
    if (error instanceof Error) {
      metricsCollector.errorOccurred(error);
    }
    process.exit(1);
  }
};

startServer(); 