import mongoose from 'mongoose';
import User from '../models/User';
import config from '../config';

const resetAllUsersToOffline = async () => {
  try {
    // Подключаемся к базе данных
    await mongoose.connect(config.mongoUri, {
      dbName: "anoname",
    });
    console.log('Successfully connected to the database.');

    // Выполняем обновление
    const result = await User.updateMany(
      {}, // Пустой фильтр означает "для всех пользователей"
      { $set: { isOnline: false } }
    );

    console.log(`Successfully updated users.`);
    console.log(`- Matched documents: ${result.matchedCount}`);
    console.log(`- Modified documents: ${result.modifiedCount}`);

  } catch (error) {
    console.error('An error occurred while resetting user statuses:', error);
  } finally {
    // Обязательно отключаемся от базы
    await mongoose.disconnect();
    console.log('Disconnected from the database.');
  }
};

// Запускаем функцию
resetAllUsersToOffline(); 