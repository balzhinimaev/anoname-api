import { Request, Response } from 'express';
import { LeadService } from '../services/LeadService';

export const addLead = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.body;

    if (!telegramId || typeof telegramId !== 'string') {
      res.status(400).json({ error: 'telegramId is required' });
      return;
    }

    const result = await LeadService.addLead(telegramId);
    
    res.json({
      success: true,
      added: result.added,
      isNew: result.isNew
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add lead' });
  }
};

export const getStats = async (_req: Request, res: Response): Promise<void> => {
  try {
    const stats = await LeadService.getStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get lead stats' });
  }
};
