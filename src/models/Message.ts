import mongoose, { Document, Schema } from 'mongoose';

export interface IMessage extends Document {
  chatId: mongoose.Schema.Types.ObjectId;
  sender: mongoose.Schema.Types.ObjectId;
  content: string;
  timestamp: Date;
  isRead: boolean;
  readBy: mongoose.Schema.Types.ObjectId[];
  replyTo?: mongoose.Schema.Types.ObjectId;  // ID сообщения, на которое отвечаем
  // icebreaker — системная подсказка от AI; voice — голосовое сообщение
  type?: 'icebreaker' | 'voice';
  media?: {
    kind: 'voice';
    duration: number;      // сек, фактическая (после ffmpeg)
    size: number;          // байт (итоговый mp3)
    waveform: number[];    // ≤64 пиков 0..1 (считает клиент-отправитель)
    clientId?: string;     // UUID клиента — идемпотентность повторной загрузки
  };
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
  },
  type: {
    type: String,
    enum: ['icebreaker', 'voice'],
    required: false,
  },
  media: {
    type: new Schema({
      kind: { type: String, enum: ['voice'], required: true },
      duration: { type: Number, required: true },
      size: { type: Number, required: true },
      waveform: { type: [Number], default: [] },
      clientId: { type: String, required: false },
    }, { _id: false }),
    required: false,
  }
});

// Индексы для эффективной пагинации истории сообщений
MessageSchema.index({ chatId: 1, timestamp: -1 });
MessageSchema.index({ chatId: 1, _id: -1 });
// Идемпотентность загрузки голосовых: повтор с тем же clientId не создаёт дубль
MessageSchema.index(
  { chatId: 1, 'media.clientId': 1 },
  { unique: true, partialFilterExpression: { 'media.clientId': { $exists: true } } }
);

export default mongoose.model<IMessage>('Message', MessageSchema); 