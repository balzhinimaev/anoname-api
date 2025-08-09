/**
 * Основной файл сервера приложения для анонимного чата.
 * @module server
 */

import express from 'express';
import { createServer } from 'http';
// import cors from 'cors';
import dotenv from 'dotenv';
import swaggerUi from 'swagger-ui-express';
import { swaggerSpec } from './config/swagger';
import { router as userRouter } from './routes/userRoutes';
import { router as chatRouter } from './routes/chatRoutes';
import { router as authRouter } from './routes/authRoutes';
import { router as searchRouter } from './routes/searchRoutes';
import monetizationRouter from './routes/monetizationRoutes';
import { monitoringRouter } from './routes/monitoringRoutes';
import { authMiddleware } from './middleware/authMiddleware';
import mongoose from 'mongoose';
import config from './config';
import { WebSocketManager } from './websocket/WebSocketManager';
import Token from './models/Token';
import logger from './utils/logger';
import { metricsCollector } from './utils/metrics';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const port = process.env.PORT || 3001;

/**
 * Настройка CORS для безопасного взаимодействия с клиентом
 */
// app.use(cors({
//   origin: process.env.CLIENT_URL || 'http://localhost:3001',
//   methods: ['GET', 'POST', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization'],
//   credentials: true
// }));
// Парсим JSON и одновременно сохраняем сырой буфер тела запроса для проверки сигнатур вебхуков
app.use(express.json({
  verify: (req: any, _res, buf) => {
    req.rawBody = Buffer.from(buf);
  }
}));

/**
 * Инициализация Swagger UI
 */
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'API Документация | Анонимный чат',
}));

// Эндпоинт для получения спецификации OpenAPI в формате JSON
app.get('/api-docs.json', (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

/**
 * Инициализация WebSocket менеджера для обработки реал-тайм соединений
 */
export const wsManager = new WebSocketManager(httpServer);

// Публичные маршруты (не требуют аутентификации)
app.use('/api/auth', authRouter);
app.use('/api/monitoring', monitoringRouter);
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'OK' });
});

// Защищенные маршруты (требуют аутентификации)
app.use('/api/users', authMiddleware, userRouter);
app.use('/api/chats', authMiddleware, chatRouter);
app.use('/api/search', searchRouter);
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
    
    // Запуск очистки токенов
    setupTokenCleanup();
    
    // Запуск сервера
    httpServer.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
    });
  } catch (error) {
    logger.error('Ошибка при запуске сервера:', error);
    if (error instanceof Error) {
      metricsCollector.errorOccurred(error);
    }
    process.exit(1);
  }
};

startServer(); 