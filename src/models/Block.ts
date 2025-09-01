import mongoose from 'mongoose';

export interface IBlock {
  blockerUserId: mongoose.Types.ObjectId;
  blockedUserId: mongoose.Types.ObjectId;
  reason?: string;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const blockSchema = new mongoose.Schema<IBlock>({
  blockerUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  blockedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  reason: { type: String },
  expiresAt: { type: Date }
}, {
  timestamps: true
});

// Гарантируем уникальность направления блокировки
blockSchema.index({ blockerUserId: 1, blockedUserId: 1 }, { unique: true });

// Для быстрых проверок «есть ли блок между двумя пользователями»
blockSchema.index({ blockedUserId: 1, blockerUserId: 1 });

export default mongoose.model<IBlock>('Block', blockSchema);


