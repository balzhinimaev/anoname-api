import { Request, Response } from 'express';
import User from '../models/User';
import config from '../config';
import logger from '../utils/logger';
import { createAndSaveToken } from './authController';
import { allocateSyntheticTelegramId } from '../utils/identity';
import { verifyVkLaunchParams, isVkLaunchFresh } from '../utils/vk';
import { ReferralService } from '../services/ReferralService';
import { TelegramNotificationService } from '../services/TelegramNotificationService';

const PLATFORM = 'vk';

const publicUser = (user: any, referralCode?: string) => ({
  id: String(user._id),
  telegramId: user.telegramId,
  vkId: user.vkId,
  username: user.username,
  authProvider: user.authProvider || 'vk',
  rating: user.rating || 0,
  createdAt: user.createdAt,
  referralCode: referralCode ?? user.referralCode,
});

/**
 * POST /api/auth/vk
 * Авторизация VK Mini App по подписанным launch-параметрам (vk_* + sign).
 * Один эндпойнт: при первом входе создаёт аккаунт, далее — логинит.
 *
 * Тело: { params: string } — строка launch-параметров (window.location.search),
 * c ведущим '?' или без. Подпись проверяется секретом config.vkSecureKey.
 */
export const authVk = async (req: Request, res: Response): Promise<void> => {
  try {
    const params = typeof req.body?.params === 'string' ? req.body.params : '';

    if (!params) {
      res.status(400).json({ error: 'Отсутствуют launch-параметры VK', code: 'PARAMS_REQUIRED' });
      return;
    }

    const verification = verifyVkLaunchParams(params, config.vkSecureKey);
    logger.info('vk_auth_verification', {
      type: 'vk_auth_verification',
      ok: verification.ok,
      reason: verification.reason,
      vkUserId: verification.vkUserId,
      vkAppId: verification.vkAppId,
    });

    // Если требование подписи включено — отклоняем невалидные.
    if (config.requireVkSign && !verification.ok) {
      res.status(401).json({ error: 'Неверная подпись VK', code: verification.reason });
      return;
    }
    // Даже при выключенном требовании нам нужен идентификатор пользователя.
    if (!verification.vkUserId || !Number.isFinite(verification.vkUserId)) {
      res.status(401).json({ error: 'Не удалось определить пользователя VK', code: verification.reason || 'NO_VK_USER' });
      return;
    }

    // Опциональная проверка соответствия приложения (если VK_APP_ID задан).
    if (config.vkAppId && verification.vkAppId && String(verification.vkAppId) !== String(config.vkAppId)) {
      logger.warn('vk_auth_app_mismatch', { expected: config.vkAppId, got: verification.vkAppId });
      res.status(401).json({ error: 'Параметры VK от другого приложения', code: 'VK_APP_MISMATCH' });
      return;
    }

    // Проверка свежести (если VK_SIGN_MAX_AGE_SEC > 0).
    if (config.requireVkSign && !isVkLaunchFresh(verification.vkTs, config.vkSignMaxAgeSec)) {
      res.status(401).json({ error: 'Параметры VK устарели', code: 'VK_TS_EXPIRED' });
      return;
    }

    const vkId = verification.vkUserId;

    // Find-or-create по vkId
    let user = await User.findOne({ vkId });
    let isNew = false;
    if (!user) {
      const telegramId = await allocateSyntheticTelegramId();
      user = new User({
        telegramId,
        authProvider: PLATFORM,
        vkId,
        username: `vk${vkId}`,
        role: 'user',
      });
      try {
        await user.save();
        isNew = true;
      } catch (e: any) {
        // Гонка по уникальному vkId — перечитываем существующего
        if (e && e.code === 11000) {
          user = await User.findOne({ vkId });
        } else {
          throw e;
        }
      }
      if (!user) {
        res.status(500).json({ error: 'Ошибка при создании аккаунта VK' });
        return;
      }
    }

    let referralCode: string | undefined;
    try {
      referralCode = await ReferralService.ensureReferralCode(String(user._id));
    } catch {}

    const token = await createAndSaveToken(user, req, PLATFORM);

    logger.info('vk_auth_success', { userId: String(user._id), vkId, isNew });

    // Уведомление в Telegram-канал — только при первой регистрации (не на каждый вход)
    if (isNew) {
      void TelegramNotificationService.sendUserRegistrationNotification({
        telegramId: user.telegramId,
        username: user.username,
        gender: (user as { gender?: 'male' | 'female' | 'other' }).gender,
        age: (user as { age?: number }).age,
        cohort: (user as { cohort?: 'A' | 'B' }).cohort,
        referralCode,
        platform: PLATFORM,
        userAgent: String(req.headers['user-agent'] || ''),
        ip: req.ip,
        registrationDate: new Date(),
      }).catch((e) => logger.error('vk_register_notify_failed', { message: (e as Error)?.message }));
    }

    res.status(isNew ? 201 : 200).json({ token, user: publicUser(user, referralCode) });
  } catch (error) {
    logger.error('vk_auth_exception', { message: (error as Error)?.message });
    res.status(500).json({ error: 'Ошибка авторизации VK' });
  }
};
