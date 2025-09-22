import Lead from '../models/Lead';
import User from '../models/User';
import { TelegramNotificationService } from './TelegramNotificationService';

export class LeadService {
  static async addLead(telegramId: string): Promise<{ added: boolean; isNew: boolean }> {
    try {
      const existingLead = await Lead.findOne({ telegramId });
      
      if (existingLead) {
        return { added: false, isNew: false };
      }

      // Check if user already exists in User collection
      const existingUser = await User.findOne({ telegramId: Number(telegramId) });
      const isRegistered = !!existingUser;

      const lead = await Lead.create({
        telegramId,
        createdAt: new Date(),
        isRegistered
      });

      // Send notification to Telegram channel
      try {
        await TelegramNotificationService.sendLeadNotification({
          telegramId,
          isRegistered,
          createdAt: lead.createdAt
        });
      } catch (notificationError) {
        // Log error but don't fail the lead creation
        console.error('Failed to send lead notification:', notificationError);
      }

      return { added: true, isNew: true };
    } catch (error) {
      throw new Error('Failed to add lead');
    }
  }

  static async getCount(): Promise<number> {
    const count = await Lead.countDocuments();
    return count;
  }

  static async getStats(): Promise<{
    total: number;
    registered: number;
    unregistered: number;
  }> {
    const [total, registered] = await Promise.all([
      Lead.countDocuments(),
      Lead.countDocuments({ isRegistered: true })
    ]);

    return {
      total,
      registered,
      unregistered: total - registered
    };
  }

  static async markAsRegistered(telegramId: string): Promise<boolean> {
    try {
      const result = await Lead.updateOne(
        { telegramId },
        { $set: { isRegistered: true } }
      );
      return result.modifiedCount > 0;
    } catch (error) {
      return false;
    }
  }
}
