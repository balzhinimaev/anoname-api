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
}


