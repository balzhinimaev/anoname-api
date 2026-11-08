import { Request, Response } from 'express';
import User from '../models/User';
import { createAndSaveToken } from './authController';
import { getCohortVariant } from '../utils/experiments';

/** Called ONLY by the trusted bot, after Telegram webhook authentication.
 * Separate token platform deliberately leaves web/Mini App sessions untouched. */
export async function createBotSession(req: Request, res: Response): Promise<void> {
  const { telegramId } = req.body || {};
  if (!Number.isSafeInteger(telegramId) || telegramId <= 0) {
    res.status(400).json({ error: 'Invalid Telegram ID' });
    return;
  }
  try {
    const user = await User.findOneAndUpdate(
      { telegramId },
      { $setOnInsert: { telegramId, cohort: getCohortVariant(String(telegramId)), role: 'user' } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const token = await createAndSaveToken(user, req, 'telegram_bot');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ token, user: { id: String(user!._id), gender: user!.gender, age: user!.age } });
  } catch {
    res.status(503).json({ error: 'Bot session unavailable' });
  }
}
