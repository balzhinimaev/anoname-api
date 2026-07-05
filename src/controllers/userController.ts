import { Request, Response } from 'express';
import User from '../models/User';
import { BlockService } from '../services/BlockService';
import { ReferralService } from '../services/ReferralService';
import { MonetizationService } from "../services/MonetizationService";

// Поля, доступные для просмотра другими пользователями (публичный профиль).
// Идентифицирующие поля (telegramId/username/lastActive) исключены намеренно:
// их выдача любому по предсказуемому telegramId ломает анонимность (деанон/перебор).
const PUBLIC_USER_PROJECTION = {
	firstName: 1,
	gender: 1,
	age: 1,
	photos: 1,
	profilePhoto: 1,
	rating: 1,
	isOnline: 1,
	cohort: 1,
	_id: 0,
} as const;

const toPublicUser = (user: any) => ({
	firstName: user.firstName,
	gender: user.gender,
	age: user.age,
	photos: user.photos,
	profilePhoto: user.profilePhoto,
	rating: user.rating,
	isOnline: user.isOnline,
	cohort: user.cohort,
});

export const canSearch = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.params;
    if (!telegramId) {
      res.status(400).json({ error: "telegramId обязателен" });
      return;
    }

    const user = await User.findOne({ telegramId }).select("_id");
    if (!user?._id) {
      res.status(404).json({ error: "Пользователь не найден" });
      return;
    }

    const result = await MonetizationService.canUserSearch(String(user._id));
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: "Ошибка при проверке возможности поиска" });
  }
};

export const getSearchLimits = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { telegramId } = req.params;
    if (!telegramId) {
      res.status(400).json({ error: "telegramId обязателен" });
      return;
    }

    const user = await User.findOne({ telegramId }).select("_id");
    if (!user?._id) {
      res.status(404).json({ error: "Пользователь не найден" });
      return;
    }

    const limits = await MonetizationService.getSearchLimits(String(user._id));
    if (!limits) {
      res.status(500).json({ error: "Не удалось получить лимиты" });
      return;
    }

    res.status(200).json(limits);
  } catch (error) {
    res.status(500).json({ error: "Ошибка при получении лимитов поиска" });
  }
};


export const createOrUpdateUser = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user?.telegramId) { res.status(401).json({ error: 'Не авторизован' }); return; }

    const body = req.body || {};
    // Разрешаем обновлять только безопасные поля профиля
    const allowedFields = ['username', 'firstName', 'lastName', 'bio', 'gender', 'age'] as const;
    const update: Record<string, unknown> = {};
    for (const key of allowedFields) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        update[key] = body[key];
      }
    }

    // Telegram ID принудительно из токена
    const telegramId = Number(req.user.telegramId);

    const user = await User.findOneAndUpdate(
      { telegramId },
      { $set: { ...update, telegramId } },
      { new: true, upsert: true }
    );
    // Гарантируем реферальный код, если его нет
    try { if (user?._id) await ReferralService.ensureReferralCode(user._id.toString()); } catch {}
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при создании/обновлении пользователя' });
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user?.userId) { res.status(401).json({ error: 'Не авторизован' }); return; }
    const user = await User.findById(req.user.userId);
    if (!user) { res.status(404).json({ error: 'Пользователь не найден' }); return; }
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении профиля' });
  }
};

export const getUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.params;
    const isOwner = req.user?.telegramId && String(req.user.telegramId) === String(telegramId);
    const isAdmin = req.user?.isAdmin === true;

    const query = { telegramId } as any;

    const user = isOwner || isAdmin
      ? await User.findOne(query)
      : await User.findOne(query).select(PUBLIC_USER_PROJECTION).lean();

    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }
    res.status(200).json(isOwner || isAdmin ? user : toPublicUser(user));
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при получении пользователя' });
  }
};

export const getPotentialMatches = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.params;
    const user = await User.findOne({ telegramId });
    
    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    const query: any = {
      telegramId: { $ne: telegramId }
    };

    if (user.preferences?.gender && user.preferences.gender !== 'any') {
      query.gender = user.preferences.gender;
    }

    if (user.preferences?.ageRange) {
      query.age = {
        $gte: user.preferences.ageRange.min,
        $lte: user.preferences.ageRange.max
      };
    }

    let potentialMatches = await User.find(query)
      .select(PUBLIC_USER_PROJECTION)
      .lean()
      .limit(20);

    // Исключим заблокированных пользователем и тех, кто заблокировал пользователя
    try {
      const meId = (user as any)._id.toString();
      potentialMatches = await Promise.all(potentialMatches.filter(() => true).map(async (u: any) => {
        const blocked = await BlockService.anyBlockBetween(meId, String(u._id));
        return blocked ? null : u;
      }));
      potentialMatches = potentialMatches.filter(Boolean) as any[];
    } catch {}
    res.status(200).json(potentialMatches.map(toPublicUser));
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при поиске потенциальных партнеров' });
  }
};

export const updatePreferences = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.params;
    // Строгий allowlist — НЕ пишем сырой req.body (иначе schema-pollution / раздувание документа).
    // Dot-notation: обновляем только присланные поля, не затирая остальные настройки
    // (раньше $set: {preferences} перезаписывал объект целиком).
    const body = (req.body || {}) as Record<string, any>;
    const set: Record<string, unknown> = {};
    if (['male', 'female', 'any'].includes(body.gender)) {
      set['preferences.gender'] = body.gender;
    }
    if (body.ageRange && typeof body.ageRange === 'object') {
      const min = Number(body.ageRange.min);
      const max = Number(body.ageRange.max);
      const range: { min?: number; max?: number } = {};
      if (Number.isFinite(min)) range.min = Math.max(18, Math.min(100, Math.floor(min)));
      if (Number.isFinite(max)) range.max = Math.max(18, Math.min(100, Math.floor(max)));
      if (range.min !== undefined || range.max !== undefined) set['preferences.ageRange'] = range;
    }
    // Приватность: приём голосовых сообщений
    if (typeof body.acceptVoice === 'boolean') {
      set['preferences.acceptVoice'] = body.acceptVoice;
    }
    // Приватность: приглашения в мини-игры
    if (typeof body.acceptGames === 'boolean') {
      set['preferences.acceptGames'] = body.acceptGames;
    }

    const user = await User.findOneAndUpdate(
      { telegramId },
      Object.keys(set).length ? { $set: set } : {},
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при обновлении предпочтений' });
  }
};

const MAX_PHOTOS = 10;
const isHttpsUrl = (u: unknown): u is string => {
  if (typeof u !== 'string' || u.length > 1024 || !/^https:\/\//i.test(u)) return false;
  try { new URL(u); return true; } catch { return false; }
};

export const uploadPhotos = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.params;
    const { photos } = req.body as { photos?: unknown };

    // Валидация: только массив корректных https-URL; хард-кап общего числа фото.
    if (!Array.isArray(photos) || photos.length === 0) {
      res.status(400).json({ error: 'photos должен быть непустым массивом' });
      return;
    }
    const clean = photos.filter(isHttpsUrl).slice(0, MAX_PHOTOS);
    if (clean.length === 0) {
      res.status(400).json({ error: 'Нет валидных https-ссылок на фото' });
      return;
    }

    const user = await User.findOneAndUpdate(
      { telegramId },
      { $push: { photos: { $each: clean, $slice: -MAX_PHOTOS } } },
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при загрузке фотографий' });
  }
};

export const deletePhoto = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId, photoId } = req.params;

    const user = await User.findOneAndUpdate(
      { telegramId },
      { $pull: { photos: photoId } },
      { new: true }
    );

    if (!user) {
      res.status(404).json({ error: 'Пользователь не найден' });
      return;
    }

    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ error: 'Ошибка при удалении фотографии' });
  }
}; 