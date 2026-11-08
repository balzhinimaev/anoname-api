import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Chat from '../models/Chat';
import User from '../models/User';
import Rating from '../models/Rating';
import { BlockService } from '../services/BlockService';

// A chat-scoped view, not a searchable public directory. Never accept a target
// user identifier from the client or return account/contact/internal fields.
export const getPartnerProfile = async (req: Request, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const viewerId = req.user?.userId;
    if (!viewerId) { res.status(401).json({ error: 'Не авторизован' }); return; }
    const { chatId } = req.params;
    if (!/^[a-f\d]{24}$/i.test(chatId || '')) {
      res.status(400).json({ error: 'Неверный чат' }); return;
    }
    const chat = await Chat.findOne({ _id: chatId, participants: viewerId, isActive: true })
      .select('participants').lean();
    if (!chat || chat.participants.length !== 2) {
      res.status(404).json({ error: 'Анкета доступна только в текущем чате' }); return;
    }
    const partnerId = chat.participants.map(String).find(id => id !== viewerId);
    if (!partnerId || await BlockService.anyBlockBetween(viewerId, partnerId)) {
      res.status(404).json({ error: 'Анкета недоступна' }); return;
    }
    const partner = await User.findById(partnerId)
      .select('firstName age gender profilePhoto photos bio lookingFor interests').lean();
    if (!partner) { res.status(404).json({ error: 'Анкета недоступна' }); return; }
    const stats = await Rating.calculateAverageRating(new mongoose.Types.ObjectId(partnerId));
    res.status(200).json({
      firstName: partner.firstName || 'Собеседник',
      age: partner.age,
      gender: partner.gender,
      profilePhoto: partner.profilePhoto,
      photos: (partner.photos || []).slice(0, 6),
      bio: partner.bio || '',
      lookingFor: partner.lookingFor || '',
      interests: partner.interests || [],
      rating: stats.averageRating,
      ratingsCount: stats.totalRatings,
    });
  } catch {
    res.status(500).json({ error: 'Не удалось загрузить анкету' });
  }
};
