import mongoose, { Document, Schema } from 'mongoose';

export interface IMessage extends Document {
  chatId: mongoose.Schema.Types.ObjectId;
  sender: mongoose.Schema.Types.ObjectId;
  content: string;
  timestamp: Date;
  isRead: boolean;
  readBy: mongoose.Schema.Types.ObjectId[];
  replyTo?: mongoose.Schema.Types.ObjectId;  // ID сообщения, на которое отвечаем
}

const MessageSchema: Schema = new Schema({
  chatId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Chat',
    required: true,
    index: true,
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  content: {
    type: String,
    required: true,
    trim: true,
  },
  timestamp: {
    type: Date,
    default: Date.now,
    required: true,
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  readBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  replyTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    required: false,
  }
});

// Индексы для эффективной пагинации истории сообщений
MessageSchema.index({ chatId: 1, timestamp: -1 });
MessageSchema.index({ chatId: 1, _id: -1 });

export default mongoose.model<IMessage>('Message', MessageSchema); 