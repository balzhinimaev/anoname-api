import dotenv from 'dotenv';

dotenv.config();

const parsePositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
};

export default {
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/telegram-dating',
  jwtSecret: (() => {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is not set');
    }
    return secret;
  })(),
  jwtExpiration: process.env.JWT_EXPIRATION || '24h',
  // Срок жизни токенов, выдаваемых по сервисному API-ключу
  jwtApiExpiration: process.env.JWT_API_EXPIRATION || process.env.API_TOKEN_EXPIRATION || '365d',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  // Telegram Bot API
  botToken: process.env.BOT_TOKEN || '',
  botUsername: process.env.BOT_USERNAME || '',
  botBackendSecret: process.env.BOT_BACKEND_SECRET || '',
  adminBackendSecret: process.env.ADMIN_BACKEND_SECRET || '',
  // Требовать initData на бэке (аналог фронтового VITE_REQUIRE_TG_INITDATA)
  requireTgInitData: (process.env.REQUIRE_TG_INITDATA || 'false').toLowerCase() === 'true',
  // Максимальный возраст initData в секундах
  tgInitDataMaxAgeSec: Number(process.env.TG_INITDATA_MAX_AGE_SEC || process.env.TG_INITDATA_TTL_SEC || 300),
  // VK Mini Apps (отдельный фронт anoname-vk-miniapp)
  vkAppId: process.env.VK_APP_ID || '',
  // Защищённый ключ VK-приложения — проверка подписи launch-параметров (sign)
  vkSecureKey: process.env.VK_SECURE_KEY || '',
  // Требовать валидную подпись VK launch-параметров на бэке
  requireVkSign: (process.env.REQUIRE_VK_SIGN || 'false').toLowerCase() === 'true',
  // Максимальный возраст VK launch-параметров (vk_ts) в секундах; 0 = не проверять
  vkSignMaxAgeSec: Number(process.env.VK_SIGN_MAX_AGE_SEC || 0),
  // A/B и Redis (опционально)
  redisUrl: process.env.REDIS_URL || '',
  abSplitA: Math.min(100, Math.max(0, Number(process.env.AB_SPLIT_A || 50))),
  // Текущее окружение
  env: process.env.NODE_ENV || 'development',
  // CORS: белый список и regex-паттерны из окружения
  corsWhitelist: (() => {
    const raw = process.env.CORS_WHITELIST || '';
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  })(),
  corsRegexps: (() => {
    const raw = process.env.CORS_REGEXES || process.env.CORS_REGEX || '';
    const patterns = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const result: RegExp[] = [];
    for (const pattern of patterns) {
      try {
        result.push(new RegExp(pattern));
      } catch {
        // игнорируем некорректные паттерны
      }
    }
    return result;
  })(),
  // Swagger basic auth в проде (если заданы креды)
  swagger: {
    user: process.env.SWAGGER_USER || '',
    password: process.env.SWAGGER_PASSWORD || ''
  },
  // Администраторы — список Telegram ID, разделённых запятой
  adminTelegramIds: (() => {
    const raw = process.env.ADMIN_TELEGRAM_IDS || '';
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return new Set(ids);
  })(),
  // Утилита: проверить, является ли Telegram ID админом
  isAdminTelegramId(id: string | number): boolean {
    const normalized = String(id);
    return this.adminTelegramIds.has(normalized);
  },
  // Сервисные API-ключи (для технической аутентификации)
  serviceApiKeys: (() => {
    const raw = process.env.SERVICE_API_KEYS || process.env.API_KEYS || process.env.API_KEY || '';
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    );
  })(),
  // Проверка сервисного ключа
  isServiceApiKey(key: string | undefined | null): boolean {
    if (!key) return false;
    return this.serviceApiKeys.has(String(key));
  },
  leadBroadcast: {
    queueName: process.env.LEAD_BROADCAST_QUEUE_NAME || 'lead-broadcast',
    redisUrl: process.env.LEAD_BROADCAST_REDIS_URL || process.env.REDIS_URL || '',
    redisKeyPrefix: process.env.LEAD_BROADCAST_REDIS_KEY_PREFIX || 'lead_broadcast',
    limits: {
      perSecond: parsePositiveInt(process.env.LEAD_BROADCAST_LIMIT_PER_SECOND, 1),
      perMinute: parsePositiveInt(process.env.LEAD_BROADCAST_LIMIT_PER_MINUTE, 20),
      perHour: parsePositiveInt(process.env.LEAD_BROADCAST_LIMIT_PER_HOUR, 500),
      perDay: parsePositiveInt(process.env.LEAD_BROADCAST_LIMIT_PER_DAY, 5000),
    },
    retryDelayMs: parsePositiveInt(process.env.LEAD_BROADCAST_RETRY_DELAY_MS, 15_000),
    maxAttempts: Math.max(1, parsePositiveInt(process.env.LEAD_BROADCAST_MAX_ATTEMPTS, 3)),
    maxDeferrals: Math.max(1, parsePositiveInt(process.env.LEAD_BROADCAST_MAX_DEFERRALS, 10)),
  },
  yookassa: {
    mode: process.env.YOOKASSA_MODE || 'test',
    shopIdTest: process.env.YOOKASSA_SHOP_ID_TEST || '',
    shopIdProd: process.env.YOOKASSA_SHOP_ID_PROD || '',
    secretKeyTest: process.env.YOOKASSA_SECRET_KEY_TEST || '',
    secretKeyProd: process.env.YOOKASSA_SECRET_KEY_PROD || '',
    webhookUser: process.env.YOOKASSA_WEBHOOK_USER || '',
    webhookPassword: process.env.YOOKASSA_WEBHOOK_PASSWORD || ''
  }
};
