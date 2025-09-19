import mongoose, { Schema, Document } from 'mongoose';

export interface IPrelaunch extends Document {
  userId: mongoose.Types.ObjectId;
  telegramId: string;
  joinedAt: Date;
}

const PrelaunchSchema: Schema<IPrelaunch> = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  telegramId: { type: String, required: true, index: true },
  joinedAt: { type: Date, default: Date.now }
}, {
  timestamps: false
});

export default mongoose.model<IPrelaunch>('Prelaunch', PrelaunchSchema);


