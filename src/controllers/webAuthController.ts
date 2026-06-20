import { Request, Response } from 'express';
import User from '../models/User';
import Token from '../models/Token';
import jwt, { Secret } from 'jsonwebtoken';
import config from '../config';
import logger from '../utils/logger';
import { createAndSaveToken } from './authController';
import { allocateSyntheticTelegramId } from '../utils/identity';
import {
  normalizeLogin,
  validateUsername,
  validatePassword,
  validatePasswordConfirm,
  hashPassword,
  verifyPassword,
  dummyVerify,
} from '../utils/webAuth';
import { ReferralService } from '../services/ReferralService';
import { TelegramNotificationService } from '../services/TelegramNotificationService';

const PLATFORM = 'web';

/** Публичное представление пользователя для веб-клиента. */
const publicUser = (user: any, referralCode?: string) => ({
  id: String(user._id),
  telegramId: user.telegramId,
  login: user.login,
  username: user.username || user.login,
  authProvider: user.authProvider || 'web',
  rating: user.rating || 0,
  createdAt: user.createdAt,
  referralCode: referralCode ?? user.referralCode,
});

/**
 * POST /api/auth/web/register
 * Регистрация веб-аккаунта по username + паролю (+ подтверждение).
 */
export const registerWeb = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password, confirmPassword } = req.body as {
      username?: string;
      password?: string;
      confirmPassword?: string;
    };

    const uCheck = validateUsername(username);
    if (!uCheck.ok) {
      res.status(400).json({ error: 'Некорректное имя пользователя', code: uCheck.reason });
      return;
    }
    const pCheck = validatePassword(password);
    if (!pCheck.ok) {
      res.status(400).json({ error: 'Некорректный пароль', code: pCheck.reason });
      return;
    }
    const cCheck = validatePasswordConfirm(password, confirmPassword);
    if (!cCheck.ok) {
      res.status(400).json({ error: 'Пароли не совпадают', code: cCheck.reason });
      return;
    }

    const login = normalizeLogin(username as string);

    // Уникальность логина
    const existing = await User.findOne({ login });
    if (existing) {
      logger.info('web_register_login_taken', { login });
      res.status(409).json({ error: 'Имя пользователя уже занято', code: 'LOGIN_TAKEN' });
      return;
    }

    const passwordHash = await hashPassword(password as string);
    const telegramId = await allocateSyntheticTelegramId();

    const user = new User({
      telegramId,
      authProvider: PLATFORM,
      login,
      username: (username as string).trim(),
      passwordHash,
      role: 'user',
    });

    try {
      await user.save();
    } catch (e: any) {
      // Гонка по уникальному индексу login
      if (e && e.code === 11000) {
        res.status(409).json({ error: 'Имя пользователя уже занято', code: 'LOGIN_TAKEN' });
        return;
      }
      throw e;
    }

    let referralCode: string | undefined;
    try {
      referralCode = await ReferralService.ensureReferralCode(String(user._id));
    } catch {}

    const token = await createAndSaveToken(user, req, PLATFORM);

    logger.info('web_register_success', { userId: String(user._id), login });

    // Уведомление в Telegram-канал о новой регистрации
    void TelegramNotificationService.sendUserRegistrationNotification({
      telegramId: user.telegramId,
      username: user.username || user.login,
      referralCode,
      platform: PLATFORM,
      userAgent: String(req.headers['user-agent'] || ''),
      ip: req.ip,
      registrationDate: new Date(),
    }).catch((e) => logger.error('web_register_notify_failed', { message: (e as Error)?.message }));

    res.status(201).json({ token, user: publicUser(user, referralCode) });
  } catch (error) {
    logger.error('web_register_exception', { message: (error as Error)?.message });
    res.status(500).json({ error: 'Ошибка при регистрации' });
  }
};

/**
 * POST /api/auth/web/login
 * Вход веб-аккаунта по username + паролю.
 */
export const loginWeb = async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body as { username?: string; password?: string };

    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      res.status(400).json({ error: 'Укажите имя пользователя и пароль', code: 'CREDENTIALS_REQUIRED' });
      return;
    }

    const login = normalizeLogin(username);
    const user = await User.findOne({ login });

    // Единое сообщение + тайминг-эквализация (холостой bcrypt), чтобы no-user и
    // bad-password ветки тратили сопоставимое время → нет enumeration-оракула.
    if (!user || !user.passwordHash) {
      await dummyVerify(password);
      logger.info('web_login_invalid', { login });
      res.status(401).json({ error: 'Неверное имя пользователя или пароль', code: 'INVALID_CREDENTIALS' });
      return;
    }

    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      logger.info('web_login_bad_password', { login });
      res.status(401).json({ error: 'Неверное имя пользователя или пароль', code: 'INVALID_CREDENTIALS' });
      return;
    }

    // Переиспользуем активный токен, если его подпись ещё валидна
    const existingToken = await Token.findOne({
      telegramId: user.telegramId.toString(),
      platform: PLATFORM,
      isValid: true,
      expiresAt: { $gt: new Date() },
    });
    if (existingToken) {
      try {
        jwt.verify(existingToken.token, config.jwtSecret as Secret, { algorithms: ['HS256'] });
        logger.info('web_login_reuse_token', { login });
        res.status(200).json({ token: existingToken.token, user: publicUser(user) });
        return;
      } catch {
        try {
          await Token.updateOne({ _id: existingToken._id }, { isValid: false, lastUsedAt: new Date() });
        } catch {}
      }
    }

    const token = await createAndSaveToken(user, req, PLATFORM);
    logger.info('web_login_success', { login });
    res.status(200).json({ token, user: publicUser(user) });
  } catch (error) {
    logger.error('web_login_exception', { message: (error as Error)?.message });
    res.status(500).json({ error: 'Ошибка при аутентификации' });
  }
};
