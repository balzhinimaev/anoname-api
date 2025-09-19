import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import User from '../models/User';
import Token from '../models/Token';

// Расширяем интерфейс Request
declare module 'express' {
  interface Request {
    user?: {
      telegramId: string;
      userId: string;
      isAdmin?: boolean;
    };
    token?: string;
  }
}

export const authMiddleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      res.status(401).json({ error: 'Отсутствует токен авторизации' });
      return;
    }

    const token = authHeader.split(' ')[1]; // Bearer <token>
    
    if (!token) {
      res.status(401).json({ error: 'Неверный формат токена' });
      return;
    }

    // Проверяем токен в базе данных
    const tokenDoc = await Token.findOne({ token, isValid: true });
    if (!tokenDoc) {
      res.status(401).json({ error: 'Токен недействителен или отозван' });
      return;
    }

    // Проверяем срок действия токена
    if (tokenDoc.expiresAt < new Date()) {
      await Token.findOneAndUpdate({ token }, { isValid: false });
      res.status(401).json({ error: 'Срок действия токена истек' });
      return;
    }

    // Верифицируем JWT
    const decoded = jwt.verify(token, config.jwtSecret) as {
      telegramId: string;
      userId: string;
      isAdmin?: boolean;
    };

    // Обновляем время последнего использования
    await Token.findOneAndUpdate(
      { token },
      { lastUsedAt: new Date() }
    );

    // Дополнительно проверим роль в БД, чтобы не полагаться на токен
    let isAdmin = false;
    try {
      const dbUser = await User.findById(decoded.userId).select('role telegramId');
      if (dbUser) {
        isAdmin = dbUser.role === 'admin' || config.isAdminTelegramId(dbUser.telegramId);
      } else if (decoded.telegramId) {
        isAdmin = config.isAdminTelegramId(decoded.telegramId);
      }
    } catch {
      isAdmin = decoded.isAdmin === true;
    }

    req.user = {
      telegramId: decoded.telegramId,
      userId: decoded.userId,
      isAdmin
    };
    req.token = token;
    // enrichment для аналитики: deviceId/platform из JWT и cohort из БД
    try {
      (req as any).deviceId = (decoded as any).deviceId;
      (req as any).platform = (decoded as any).platform;
      const dbUser = await User.findById(decoded.userId).select('cohort');
      (req as any).userCohort = (dbUser as any)?.cohort;
    } catch {}
    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({ error: 'Недействительный токен' });
      return;
    }
    res.status(500).json({ error: 'Ошибка при проверке токена' });
  }
}; 

export const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ error: 'Не авторизован' });
    return;
  }
  if (!req.user.isAdmin) {
    res.status(403).json({ error: 'Доступ запрещён' });
    return;
  }
  next();
};