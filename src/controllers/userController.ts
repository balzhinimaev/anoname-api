import { Request, Response } from 'express';
import User from '../models/User';
import { BlockService } from '../services/BlockService';
import { ReferralService } from '../services/ReferralService';
import { MonetizationService } from "../services/MonetizationService";

// Поля, доступные для просмотра другими пользователями (публичный профиль)
const PUBLIC_USER_PROJECTION = {
	telegramId: 1,
	username: 1,
	firstName: 1,
	gender: 1,
	age: 1,
	photos: 1,
	profilePhoto: 1,
	rating: 1,
	isOnline: 1,
	lastActive: 1,
	cohort: 1,
	_id: 0,
} as const;

const toPublicUser = (user: any) => ({
	telegramId: user.telegramId,
	username: user.username,
	firstName: user.firstName,
	gender: user.gender,
	age: user.age,
	photos: user.photos,
	profilePhoto: user.profilePhoto,
	rating: user.rating,
	isOnline: user.isOnline,
	lastActive: user.lastActive,
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
    const preferences = req.body;
    
    const user = await User.findOneAndUpdate(
      { telegramId },
      { $set: { preferences } },
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

export const uploadPhotos = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.params;
    const { photos } = req.body;

    const user = await User.findOneAndUpdate(
      { telegramId },
      { $push: { photos: { $each: photos } } },
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