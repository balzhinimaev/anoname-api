import { Request, Response, NextFunction } from 'express';
import config from '../config';

const resolveSecret = (req: Request): string | undefined => {
  const adminSecret = req.headers['x-admin-secret'];
  if (typeof adminSecret === 'string' && adminSecret.length > 0) {
    return adminSecret;
  }
  const botSecret = req.headers['x-bot-secret'];
  if (typeof botSecret === 'string' && botSecret.length > 0) {
    return botSecret;
  }
  return undefined;
};

export const botAuth = (req: Request, res: Response, next: NextFunction): void => {
  const providedSecret = resolveSecret(req);
  const allowedSecrets = [config.botBackendSecret, config.adminBackendSecret].filter((value) => Boolean(value));

  if (allowedSecrets.length === 0) {
    res.status(500).json({ error: 'Bot backend secret is not configured' });
    return;
  }

  if (!providedSecret || !allowedSecrets.includes(providedSecret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
};
