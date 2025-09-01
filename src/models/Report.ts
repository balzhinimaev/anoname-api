import mongoose from 'mongoose';

export interface IReport {
  reporterUserId: mongoose.Types.ObjectId;
  reportedUserId: mongoose.Types.ObjectId;
  chatId: mongoose.Types.ObjectId;
  reason: 'spam' | 'insult' | 'scam' | 'sexual' | 'illegal' | 'other';
  comment?: string;
  status: 'open' | 'actioned' | 'dismissed';
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new mongoose.Schema<IReport>({
  reporterUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  reportedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  chatId: { type: mongoose.Schema.Types.ObjectId, ref: 'Chat', required: true, index: true },
  reason: { type: String, enum: ['spam', 'insult', 'scam', 'sexual', 'illegal', 'other'], required: true },
  comment: { type: String },
  status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open', index: true }
}, {
  timestamps: true
});

reportSchema.index({ reporterUserId: 1, chatId: 1, reason: 1 });

export default mongoose.model<IReport>('Report', reportSchema);


