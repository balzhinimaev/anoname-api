import Prelaunch from '../models/Prelaunch';
import User from '../models/User';
import { wsManager } from '../server';
import logger from '../utils/logger';
import { metricsCollector } from '../utils/metrics';

export class PrelaunchService {
  static async getCount(): Promise<number> {
    const count = await Prelaunch.countDocuments();
    logger.debug('prelaunch_count_fetched', { count });
    return count;
  }

  static async broadcastCount() {
    try {
      const count = await this.getCount();
      wsManager.io.to('prelaunch_room').emit('prelaunch:stats', { count });
      metricsCollector.prelaunchBroadcast(true);
      logger.info('prelaunch_broadcast_success', { count });
      return count;
    } catch (error) {
      metricsCollector.prelaunchBroadcast(false);
      logger.error('prelaunch_broadcast_error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  static async join(userId: string): Promise<{ joined: boolean; count: number }> {
    try {
      const user = await User.findById(userId).select('telegramId');
      if (!user) {
        metricsCollector.prelaunchJoin(false);
        logger.warn('prelaunch_join_user_not_found', { userId });
        return { joined: false, count: await this.getCount() };
      }
      await Prelaunch.updateOne(
        { userId },
        { $setOnInsert: { userId, telegramId: String(user.telegramId), joinedAt: new Date() } },
        { upsert: true }
      );
      const count = await this.broadcastCount();
      metricsCollector.prelaunchJoin(true);
      logger.info('prelaunch_join_success', { userId, telegramId: user.telegramId, count });
      return { joined: true, count };
    } catch (error) {
      metricsCollector.prelaunchJoin(false);
      logger.error('prelaunch_join_error', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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


