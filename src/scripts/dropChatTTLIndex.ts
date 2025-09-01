import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/telegram-dating';
const DB_NAME = process.env.MONGODB_DBNAME || 'anoname';

async function dropTTLIndex() {
  try {
    await mongoose.connect(MONGODB_URI, { dbName: DB_NAME });
    const conn = mongoose.connection;
    const collection = conn.collection('chats');

    const indexes = await collection.indexes();
    const ttlIndex = indexes.find((idx) => idx.key && (idx as any).expireAfterSeconds != null && (idx.key as any)['expiresAt'] === 1);

    if (!ttlIndex) {
      console.log('TTL индекс по expiresAt не найден — ничего удалять не нужно');
    } else {
      const name = typeof ttlIndex.name === 'string' ? ttlIndex.name : 'expiresAt_1';
      try {
        await collection.dropIndex(name);
        console.log(`Удалён индекс: ${name}`);
      } catch (e) {
        console.warn(`Не удалось удалить индекс по имени '${name}', пробую по ключу { expiresAt: 1 }`);
        // Попробуем удалить по спецификации ключа
        await (collection as unknown as { dropIndex: (indexNameOrSpec: any) => Promise<any> }).dropIndex({ expiresAt: 1 });
        console.log('Удалён индекс по ключу { expiresAt: 1 }');
      }
    }
  } catch (err) {
    console.error('Ошибка при удалении TTL индекса:', err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

dropTTLIndex();


