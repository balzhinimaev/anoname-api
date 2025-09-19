import Prelaunch from '../models/Prelaunch';
import User from '../models/User';
import { wsManager } from '../server';

export class PrelaunchService {
  static async getCount(): Promise<number> {
    const count = await Prelaunch.countDocuments();
    return count;
  }

  static async broadcastCount() {
    const count = await this.getCount();
    wsManager.io.to('prelaunch_room').emit('prelaunch:stats', { count });
    return count;
  }

  static async join(userId: string): Promise<{ joined: boolean; count: number }> {
    const user = await User.findById(userId).select('telegramId');
    if (!user) {
      return { joined: false, count: await this.getCount() };
    }
    await Prelaunch.updateOne(
      { userId },
      { $setOnInsert: { userId, telegramId: String(user.telegramId), joinedAt: new Date() } },
      { upsert: true }
    );
    const count = await this.broadcastCount();
    return { joined: true, count };
  }

  // Get user's position in prelaunch queue
  static async getUserPosition(userId: string): Promise<{ position: number; isInQueue: boolean; joinedAt?: Date }> {
    const prelaunchEntry = await Prelaunch.findOne({ userId }).select('joinedAt');
    
    if (!prelaunchEntry) {
      return { position: 0, isInQueue: false };
    }

    // Count how many users joined before this user (position in queue)
    const position = await Prelaunch.countDocuments({
      joinedAt: { $lt: prelaunchEntry.joinedAt }
    }) + 1;

    return {
      position,
      isInQueue: true,
      joinedAt: prelaunchEntry.joinedAt
    };
  }

  // Get extended stats including user's position
  static async getStatsWithUserInfo(userId: string): Promise<{
    totalCount: number;
    userPosition: number;
    isInQueue: boolean;
    joinedAt?: Date;
  }> {
    const totalCount = await this.getCount();
    const userInfo = await this.getUserPosition(userId);
    
    return {
      totalCount,
      userPosition: userInfo.position,
      isInQueue: userInfo.isInQueue,
      joinedAt: userInfo.joinedAt
    };
  }
}


