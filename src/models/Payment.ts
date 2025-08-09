import mongoose from 'mongoose';

export interface IPaymentLog {
  paymentId: string;
  userId?: mongoose.Types.ObjectId;
  itemKey?: string;
  status: 'pending' | 'applied' | 'failed';
  payload?: any;
  createdAt: Date;
  updatedAt: Date;
}

const paymentLogSchema = new mongoose.Schema<IPaymentLog>({
  paymentId: { type: String, required: true, unique: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  itemKey: { type: String },
  status: { type: String, enum: ['pending', 'applied', 'failed'], default: 'pending' },
  payload: { type: Object }
}, {
  timestamps: true
});

export default mongoose.model<IPaymentLog>('PaymentLog', paymentLogSchema);


