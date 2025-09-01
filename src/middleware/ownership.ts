import { Request, Response, NextFunction } from 'express';

/**
 * Проверяет, что текущий пользователь является владельцем ресурса (по `req.params.telegramId`) или администратором
 */
export const ensureOwnerOrAdminByParam = (req: Request, res: Response, next: NextFunction): void => {
	const paramTelegramId = req.params.telegramId;
	if (!req.user) { res.status(401).json({ error: 'Не авторизован' }); return; }
	const isOwner = String(req.user.telegramId) === String(paramTelegramId);
	if (!isOwner && !req.user.isAdmin) { res.status(403).json({ error: 'Доступ запрещён' }); return; }
	next();
};


