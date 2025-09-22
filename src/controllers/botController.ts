import { Request, Response } from 'express';
import { PrelaunchService } from '../services/PrelaunchService';
import { LeadService } from '../services/LeadService';
import { TelegramNotificationService } from '../services/TelegramNotificationService';

export const getPrelaunchStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const { telegramId } = req.query;
    
    if (!telegramId) {
      res.status(400).json({ error: 'telegramId is required' });
      return;
    }

    // Get prelaunch stats
    const totalCount = await PrelaunchService.getCount();
    
    // Mark lead as viewed prelaunch stats for analytics
    try {
      await LeadService.markViewedPrelaunchStats(String(telegramId));
    } catch (leadError) {
      // Log error but don't fail the request
      console.error('Failed to update lead analytics:', leadError);
    }

    // Send notification to Telegram channel
    try {
      await TelegramNotificationService.sendCustomMessage(
        `#prelaunch_stats Bot requested prelaunch stats for telegramId: ${telegramId}. Total count: ${totalCount}`
      );
    } catch (notificationError) {
      // Log error but don't fail the request
      console.error('Failed to send notification:', notificationError);
    }

    const response = {
      totalCount,
      timestamp: new Date().toISOString()
    };

    res.json(response);
  } catch (error) {
    console.error('Error getting prelaunch stats for bot:', error);
    res.status(500).json({ error: 'Failed to get prelaunch stats' });
  }
};
