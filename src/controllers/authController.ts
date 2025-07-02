import { Request, Response } from 'express';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import User from '../models/User';
import Token from '../models/Token';
import config from '../config';
import crypto from 'crypto';

const generateDeviceId = (telegramId: string, userAgent: string) => {
  return crypto
    .createHash('md5')
    .update(`${telegramId}-${userAgent}-${Date.now()}`)
    .digest('hex');
};

const createAndSaveToken = async (
  user: any,
  req: Request,
  platform = 'telegram'
): Promise<string> => {
  // Создаем уникальный идентификатор устройства
  const deviceId = generateDeviceId(user.telegramId.toString(), req.headers['user-agent'] || 'unknown');

  // Деактивируем старые токены для этой платформы
  await Token.deactivateOldTokens(user.telegramId.toString(), platform);

  // Создаем JWT токен с расширенной информацией
  const token = jwt.sign(
    { 
      userId: user._id,
      telegramId: user.telegramId,
      deviceId,
      platform
    },
    config.jwtSecret as Secret,
    { expiresIn: config.jwtExpiration } as SignOptions
  );

  // Получаем дату истечения токена
  const decoded = jwt.decode(token) as { exp: number };
  const expiresAt = new Date(decoded.exp * 1000);

  // Сохраняем токен в базу данных с расширенной информацией
  await Token.create({
    token,
    userId: user._id,
    telegramId: user.telegramId.toString(),
    expiresAt,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip,
    deviceId,
    platform,
    isValid: true
  });

  return token;
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const userData = req.body;
    const platform = req.body.platform || 'telegram';

    // Проверяем, существует ли пользователь
    const existingUser = await User.findOne({ telegramId: userData.telegramId });
    if (existingUser) {
      res.status(400).json({ error: 'Пользователь с таким Telegram ID уже существует' });
      return;
    }

    // Создаем нового пользователя
    const user = new User(userData);
    await user.save();

    // Создаем и сохраняем токен
    const token = await createAndSaveToken(user, req, platform);

    res.status(201).json({
      token,
      user: {
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        rating: user.rating || 0
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при регистрации пользователя' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.body;
    const platform = req.body.platform || 'telegram';

    // Проверяем существование пользователя
    const user = await User.findOne({ telegramId });
    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    // Проверяем наличие активного токена для данной платформы
    const existingToken = await Token.findOne({
      telegramId: telegramId.toString(),
      platform,
      isValid: true,
      expiresAt: { $gt: new Date() }
    });

    // Если есть активный токен и он не истек, возвращаем его
    if (existingToken) {
      res.status(200).json({
        token: existingToken.token,
        user: {
          telegramId: user.telegramId,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          rating: user.rating || 0
        }
      });
      return;
    }

    // Если нет активного токена, создаем новый
    const token = await createAndSaveToken(user, req, platform);

    res.status(200).json({
      token,
      user: {
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        rating: user.rating || 0
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка при аутентификации' });
  }
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  try {
    const token = req.token;
    if (!token) {
      res.status(401).json({ error: 'Отсутствует токен авторизации' });
      return;
    }

    // Инвалидируем токен
    await Token.findOneAndUpdate(
      { token },
      { 
        isValid: false,
        lastUsedAt: new Date()
      }
    );

    res.status(200).json({ message: 'Успешный выход из системы' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при выходе из системы' });
  }
};

export const logoutAll = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Пользователь не авторизован' });
      return;
    }
    
    const { telegramId } = req.user;

    // Инвалидируем все токены пользователя
    await Token.updateMany(
      { telegramId: telegramId.toString() },
      { 
        isValid: false,
        lastUsedAt: new Date()
      }
    );

    res.status(200).json({ message: 'Успешный выход из всех сессий' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при выходе из системы' });
  }
}; 