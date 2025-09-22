import { Request, Response, NextFunction } from 'express';
import config from '../config';

export const botAuth = (req: Request, res: Response, next: NextFunction): void => {
  console.log(req.headers);
  const secret = req.headers['x-bot-secret'] as string;
  
  if (!secret || secret !== config.botBackendSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  
  next();
};
