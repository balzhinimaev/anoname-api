import mongoose from 'mongoose';
import Block from '../models/Block';

export class BlockService {
  static async blockUser(blockerUserId: string, blockedUserId: string, reason?: string, expiresAt?: Date) {
    if (blockerUserId === blockedUserId) {
      throw new Error('Cannot block self');
    }
    const doc = await Block.findOneAndUpdate(
      {
        blockerUserId: new mongoose.Types.ObjectId(blockerUserId),
        blockedUserId: new mongoose.Types.ObjectId(blockedUserId)
      },
      {
        $set: {
          reason,
          expiresAt
        }
      },
      { upsert: true, new: true }
    );
    return doc;
  }

  static async unblockUser(blockerUserId: string, blockedUserId: string) {
    await Block.deleteOne({
      blockerUserId: new mongoose.Types.ObjectId(blockerUserId),
      blockedUserId: new mongoose.Types.ObjectId(blockedUserId)
    });
  }

  static async isBlocked(aUserId: string, bUserId: string): Promise<boolean> {
    // Блок считается активным, если не истёк expiresAt или он без срока
    const now = new Date();
    const existing = await Block.findOne({
      blockerUserId: new mongoose.Types.ObjectId(aUserId),
      blockedUserId: new mongoose.Types.ObjectId(bUserId),
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: now } }
      ]
    }).select('_id');
    return !!existing;
  }

  static async anyBlockBetween(aUserId: string, bUserId: string): Promise<boolean> {
    const now = new Date();
    const existing = await Block.findOne({
      $and: [
        {
          $or: [
            { blockerUserId: new mongoose.Types.ObjectId(aUserId), blockedUserId: new mongoose.Types.ObjectId(bUserId) },
            { blockerUserId: new mongoose.Types.ObjectId(bUserId), blockedUserId: new mongoose.Types.ObjectId(aUserId) }
          ]
        },
        {
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: { $gt: now } }
          ]
        }
      ]
    }).select('_id');
    return !!existing;
  }

  static async listBlockedUsers(blockerUserId: string) {
    const now = new Date();
    const docs = await Block.find({
      blockerUserId: new mongoose.Types.ObjectId(blockerUserId),
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: now } }
      ]
    }).select('blockedUserId reason expiresAt createdAt');
    return docs;
  }

  static async listUsersWhoBlockedMe(blockedUserId: string) {
    const now = new Date();
    const docs = await Block.find({
      blockedUserId: new mongoose.Types.ObjectId(blockedUserId),
      $or: [
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: now } }
      ]
    }).select('blockerUserId reason expiresAt createdAt');
    return docs;
  }

  static async getActiveBlocksForUser(userId: string): Promise<{ blockedByMeIds: Set<string>; blockedMeIds: Set<string> }> {
    const now = new Date();
    const rows = await Block.find({
      $and: [
        {
          $or: [
            { blockerUserId: new mongoose.Types.ObjectId(userId) },
            { blockedUserId: new mongoose.Types.ObjectId(userId) }
          ]
        },
        {
          $or: [
            { expiresAt: { $exists: false } },
            { expiresAt: { $gt: now } }
          ]
        }
      ]
    }).select('blockerUserId blockedUserId');
    const blockedByMeIds = new Set<string>();
    const blockedMeIds = new Set<string>();
    for (const r of rows) {
      const blocker = (r as any).blockerUserId?.toString?.() || String((r as any).blockerUserId);
      const blocked = (r as any).blockedUserId?.toString?.() || String((r as any).blockedUserId);
      if (blocker === userId) {
        blockedByMeIds.add(blocked);
      }
      if (blocked === userId) {
        blockedMeIds.add(blocker);
      }
    }
    return { blockedByMeIds, blockedMeIds };
  }
}


