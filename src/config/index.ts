import dotenv from 'dotenv';

dotenv.config();

export default {
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/telegram-dating',
  jwtSecret: process.env.JWT_SECRET || 'your-secret-key',
  jwtExpiration: process.env.JWT_EXPIRATION || '24h',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:3000',
  yookassa: {
    mode: process.env.YOOKASSA_MODE || 'test',
    shopIdTest: process.env.YOOKASSA_SHOP_ID_TEST || '',
    shopIdProd: process.env.YOOKASSA_SHOP_ID_PROD || '',
    secretKeyTest: process.env.YOOKASSA_SECRET_KEY_TEST || '',
    secretKeyProd: process.env.YOOKASSA_SECRET_KEY_PROD || '',
    webhookUser: process.env.YOOKASSA_WEBHOOK_USER || '',
    webhookPassword: process.env.YOOKASSA_WEBHOOK_PASSWORD || ''
  }
}; 