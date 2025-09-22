import { Request, Response } from 'express';
import jwt, { Secret, SignOptions } from 'jsonwebtoken';
import User from '../models/User';
import Token from '../models/Token';
import config from '../config';
import crypto from 'crypto';
import { isInitDataFresh, verifyTelegramWebAppInitData } from '../utils/telegram';
import { getCohortVariant } from '../utils/experiments';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { ReferralService } from '../services/ReferralService';
import { wsManager } from '../server';
import logger from '../utils/logger';
import { PrelaunchService } from '../services/PrelaunchService';
import { TelegramNotificationService } from '../services/TelegramNotificationService';

const generateDeviceId = (telegramId: string, userAgent: string) => {
  return crypto
    .createHash('md5')
    .update(`${telegramId}-${userAgent}-${Date.now()}`)
    .digest('hex');
};

const createAndSaveToken = async (
  user: any,
  req: Request,
  platform = 'telegram',
  expiresIn?: string
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
      // isAdmin — дублируем из БД/конфига, чтобы фронту было удобно; проверка прав идёт на бэке
      isAdmin: user.role === 'admin' || config.isAdminTelegramId(user.telegramId),
      deviceId,
      platform
    },
    config.jwtSecret as Secret,
    { expiresIn: expiresIn || config.jwtExpiration } as SignOptions
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
    const exp = (userData.exp as 'A' | 'B' | undefined) || undefined;
    // Нормализуем реф-код и извлекаем кампанию из формата CODE__CAMPAIGN
    const rawReferral = typeof userData.referralCode === 'string' ? userData.referralCode : undefined;
    const referralParts = rawReferral ? rawReferral.split('__') : undefined;
    let referralCode: string | undefined = referralParts?.[0] ? referralParts[0].trim().toUpperCase() : undefined;
    const campaignFromReferral = referralParts && referralParts.length > 1 ? referralParts.slice(1).join('__').trim() : undefined;
    let campaign: string | undefined = typeof userData.campaign === 'string' && userData.campaign.trim() !== ''
      ? userData.campaign.trim()
      : (campaignFromReferral || undefined);
    const userAgent = String(req.headers['user-agent'] || '');

    // Лог: попытка регистрации
    logger.info('auth_register_attempt', {
      type: 'auth_register_attempt',
      telegramId: userData?.telegramId,
      platform: userData?.platform,
      hasInitData: Boolean(userData?.initData),
      exp: exp || undefined,
      hasReferralCode: Boolean(referralCode),
      ip: req.ip,
      userAgent,
      hasCampaign: Boolean(campaign),
      campaign
    });
    // Telegram WebApp initData verification (обязательная, если включено требование или если initData передан)
    if (config.requireTgInitData || userData.initData) {
      const verification = verifyTelegramWebAppInitData(userData.initData || '', config.botToken);
      logger.info('auth_register_initdata_verification', {
        type: 'auth_register_initdata_verification',
        ok: verification.ok,
        reason: verification.reason,
        hasUser: Boolean(verification.user),
        auth_date: verification.auth_date
      });
      if (!verification.ok) {
        logger.warn('auth_register_initdata_failed', { reason: verification.reason });
        res.status(401).json({ error: 'Неверная подпись Telegram initData', code: verification.reason });
        return;
      }
      if (verification.user && String(verification.user.id) !== String(userData.telegramId)) {
        logger.warn('auth_register_initdata_mismatch', { initDataUserId: verification.user.id, telegramId: userData.telegramId });
        res.status(401).json({ error: 'telegramId не соответствует initData' });
        return;
      }
      // Проверяем свежесть
      const maxAgeSec = config.tgInitDataMaxAgeSec;
      if (!isInitDataFresh(verification.auth_date, maxAgeSec)) {
        logger.warn('auth_register_initdata_expired', { auth_date: verification.auth_date, maxAgeSec });
        res.status(401).json({ error: 'initData просрочен', code: 'AUTH_DATE_EXPIRED' });
        return;
      }
      // Fallback: извлекаем start_param из initData, если referralCode/campaign не пришли явно
      try {
        const startParamRaw = (verification as any)?.raw?.start_param as string | undefined;
        if ((!referralCode || !campaign) && startParamRaw) {
          const decoded = decodeURIComponent(startParamRaw);
          const parts = decoded.split('__');
          if (!referralCode && parts[0]) referralCode = parts[0].trim().toUpperCase();
          if (!campaign && parts.length > 1) campaign = parts.slice(1).join('__').trim();
        }
      } catch {}
    }

    // Главный источник кампании: самое раннее bot_start_shown с props.campaign
    try {
      const firstStart = await AnalyticsEvent.findOne({
        telegramId: String(userData.telegramId),
        name: 'bot_start_shown',
        'props.campaign': { $exists: true, $ne: '' }
      }).sort({ createdAt: 1 }).select({ props: 1, createdAt: 1 }).lean();
      const fromAnalytics = (firstStart as any)?.props?.campaign as string | undefined;
      if (fromAnalytics && typeof fromAnalytics === 'string') {
        campaign = fromAnalytics;
      }
    } catch {}
    const platform = req.body.platform || 'telegram';

    // Проверяем, существует ли пользователь
    const existingUser = await User.findOne({ telegramId: userData.telegramId });
    if (existingUser) {
      logger.info('auth_register_user_exists', { telegramId: userData.telegramId });
      res.status(409).json({ error: 'Пользователь с таким Telegram ID уже существует' });
      return;
    }

    // cohort: берем из exp или присваиваем детерминированно
    const cohort = exp || getCohortVariant(String(userData.telegramId));

    // Создаем нового пользователя: берём только разрешённые профильные поля (без exp/referralCode/initData/platform)
    const {
      telegramId,
      username,
      firstName,
      lastName,
      bio,
      gender,
      age,
      profilePhoto
    } = userData as Record<string, any>;
    const user = new User({
      telegramId,
      username,
      firstName,
      lastName,
      bio,
      gender,
      age,
      profilePhoto,
      cohort,
      campaign,
      role: config.isAdminTelegramId(userData.telegramId) ? 'admin' : 'user'
    });
    await user.save();

    // Рефералы: атрибуция по коду (если передан)
    try { await ReferralService.attributeReferral(String((user as unknown as { _id: string })._id), referralCode); } catch {}

    // Сразу выдаём собственный реферальный код новому пользователю (если ещё нет)
    let myReferralCode: string | undefined = undefined;
    try {
      myReferralCode = await ReferralService.ensureReferralCode(String((user as unknown as { _id: string })._id));
    } catch {}

    // Создаем и сохраняем токен
    const token = await createAndSaveToken(user, req, platform);

    // Аналитика: успешная регистрация
    try {
      await AnalyticsEvent.create({
        userId: user._id,
        telegramId: String(user.telegramId),
        cohort: user.cohort as any,
        name: 'register',
        props: { platform, campaign },
        userAgent: String(req.headers['user-agent'] || ''),
        ip: req.ip
      } as any);
    } catch {}

    logger.info('auth_register_success', {
      type: 'auth_register_success',
      userId: String((user as any)._id),
      telegramId: user.telegramId,
      hasReferralCode: Boolean(referralCode)
    });

    // Отправляем уведомление в Telegram канал о регистрации
    try {
      await TelegramNotificationService.sendUserRegistrationNotification({
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        bio: user.bio,
        gender: user.gender,
        age: user.age,
        profilePhoto: user.profilePhoto,
        cohort: user.cohort,
        campaign: campaign,
        referralCode: referralCode,
        platform: platform,
        userAgent: String(req.headers['user-agent'] || ''),
        ip: req.ip,
        registrationDate: new Date()
      });
    } catch (notificationError) {
      logger.error('Ошибка отправки уведомления о регистрации', {
        type: 'telegram_notification_error',
        userId: String((user as any)._id),
        telegramId: user.telegramId,
        error: notificationError instanceof Error ? notificationError.message : 'Unknown error'
      });
    }

    res.status(201).json({
      token,
      user: {
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePhoto: user.profilePhoto,
        rating: user.rating || 0,
        cohort: user.cohort,
        referralCode: myReferralCode
      }
    });
    // После успешной регистрации — автоматически помещаем в предстартовую очередь
    try { await PrelaunchService.join(String((user as any)._id)); } catch {}

    // Обновляем статус лида как зарегистрированного
    try { 
      const { LeadService } = await import('../services/LeadService');
      await LeadService.markAsRegistered(String(user.telegramId)); 
    } catch {}
  } catch (error) {
    logger.error('auth_register_exception', { message: (error as Error)?.message });
    res.status(500).json({ error: 'Ошибка при регистрации пользователя' });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId, initData } = req.body as { telegramId: number; initData?: string };
    const exp = (req.body?.exp as 'A' | 'B' | undefined) || undefined;
    logger.info('auth_login_attempt', {
      type: 'auth_login_attempt',
      telegramId,
      hasInitData: Boolean(initData),
      exp: exp || undefined,
      ip: req.ip,
      userAgent: String(req.headers['user-agent'] || '')
    });
    const apiKey = (req.headers['x-api-key'] || req.headers['x-api_token'] || req.headers['x-api-token'] || req.query.api_key) as string | undefined;

    // Если передан валидный сервисный API-ключ — разрешаем логин без initData и выдаём долгоживущий токен
    const isServiceLogin = config.isServiceApiKey(apiKey);

    // Telegram initData: обязателен в TMA режиме при включенном флаге, иначе допускается фолбэк (или сервисный ключ)
    if (!isServiceLogin && (config.requireTgInitData || initData)) {
      const verification = verifyTelegramWebAppInitData(initData || '', config.botToken);
      if (!verification.ok) {
        logger.warn('auth_login_initdata_failed', { reason: verification.reason });
        res.status(401).json({ error: 'Неверная подпись Telegram initData', code: verification.reason });
        return;
      }
      if (verification.user && String(verification.user.id) !== String(telegramId)) {
        logger.warn('auth_login_initdata_mismatch', { initDataUserId: verification.user.id, telegramId });
        res.status(401).json({ error: 'telegramId не соответствует initData' });
        return;
      }
      const maxAgeSec = config.tgInitDataMaxAgeSec;
      if (!isInitDataFresh(verification.auth_date, maxAgeSec)) {
        logger.warn('auth_login_initdata_expired', { auth_date: verification.auth_date, maxAgeSec });
        res.status(401).json({ error: 'initData просрочен', code: 'AUTH_DATE_EXPIRED' });
        return;
      }
    }
    const platform = isServiceLogin ? 'api' : (req.body.platform || 'telegram');

    // Проверяем существование пользователя
    const user = await User.findOne({ telegramId });
    if (!user) {
      logger.info('auth_login_user_not_found', { telegramId });
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    // Если cohort ещё не установлен (старые пользователи) — проставим (idempotent)
    if (!user.cohort) {
      try {
        const cohort = exp || getCohortVariant(String(telegramId));
        await User.updateOne({ _id: user._id }, { $set: { cohort } });
      } catch {}
    }

    // Проверяем наличие активного токена для данной платформы
    const existingToken = await Token.findOne({
      telegramId: telegramId.toString(),
      platform,
      isValid: true,
      expiresAt: { $gt: new Date() }
    });

    // Если есть активный токен — дополнительно проверим его подпись текущим секретом.
    // Если подпись невалидна (секрет менялся) — не переиспользуем, выпустим новый токен.
    if (existingToken) {
      try {
        jwt.verify(existingToken.token, config.jwtSecret as Secret);
        logger.info('auth_login_reuse_token', { telegramId });
        res.status(200).json({
          token: existingToken.token,
          user: {
            telegramId: user.telegramId,
            username: user.username,
            firstName: user.firstName,
            lastName: user.lastName,
            profilePhoto: (user as any).profilePhoto,
            rating: user.rating || 0
          }
        });
        return;
      } catch {
        logger.info('auth_login_token_signature_mismatch', { telegramId });
        try {
          await Token.updateOne({ _id: existingToken._id }, { isValid: false, lastUsedAt: new Date() });
        } catch {}
        // падаем ниже и выпускаем новый токен
      }
    }

    // Если нет активного токена, создаем новый
    const token = await createAndSaveToken(
      user,
      req,
      platform,
      isServiceLogin ? config.jwtApiExpiration : undefined
    );

    logger.info('auth_login_success', { telegramId });
    res.status(200).json({
      token,
      user: {
        telegramId: user.telegramId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePhoto: (user as any).profilePhoto,
        rating: user.rating || 0
      }
    });
  } catch (error) {
    logger.error('auth_login_exception', { message: (error as Error)?.message });
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

    // Находим токен для получения userId
    const tokenDoc = await Token.findOne({ token });
    // Инвалидируем токен
    await Token.findOneAndUpdate(
      { token },
      { 
        isValid: false,
        lastUsedAt: new Date()
      }
    );

    // Принудительно отключаем WS-сессию пользователя
    if (tokenDoc?.userId) {
      try { await wsManager.disconnectUser(tokenDoc.userId.toString()); } catch {}
    }

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

    // Отключаем WS-сессию пользователя
    try {
      const user = await User.findOne({ telegramId });
      if (user?._id) {
        await wsManager.disconnectUser(user._id.toString());
      }
    } catch {}

    res.status(200).json({ message: 'Успешный выход из всех сессий' });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при выходе из системы' });
  }
}; 