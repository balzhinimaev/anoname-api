/**
 * Тест отправки уведомлений в Telegram канал
 * 
 * Запуск: npm run test-telegram-notifications
 * или: npx ts-node src/scripts/testTelegramNotifications.ts
 */

import { TelegramNotificationService } from '../services/TelegramNotificationService';
import config from '../config';

async function testTelegramNotifications() {
  console.log('🧪 Тестирование отправки уведомлений в Telegram канал...');
  
  if (!config.botToken) {
    console.error('❌ BOT_TOKEN не настроен в переменных окружения');
    process.exit(1);
  }

  try {
    // Тест 1: Отправка тестового уведомления
    console.log('\n1️⃣ Отправка тестового уведомления...');
    await TelegramNotificationService.sendTestNotification();
    console.log('✅ Тестовое уведомление отправлено');

    // Тест 2: Отправка уведомления о регистрации
    console.log('\n2️⃣ Отправка уведомления о регистрации...');
    await TelegramNotificationService.sendUserRegistrationNotification({
      telegramId: 123456789,
      username: 'testuser',
      firstName: 'Тест',
      lastName: 'Пользователь',
      bio: 'Это тестовый пользователь для проверки уведомлений',
      gender: 'male',
      age: 25,
      profilePhoto: 'https://via.placeholder.com/150',
      cohort: 'A',
      campaign: 'test_campaign',
      referralCode: 'TEST123',
      platform: 'telegram',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ip: '192.168.1.1',
      registrationDate: new Date()
    });
    console.log('✅ Уведомление о регистрации отправлено');

    // Тест 3: Отправка уведомления с минимальными данными
    console.log('\n3️⃣ Отправка уведомления с минимальными данными...');
    await TelegramNotificationService.sendUserRegistrationNotification({
      telegramId: 987654321,
      platform: 'api',
      registrationDate: new Date()
    });
    console.log('✅ Уведомление с минимальными данными отправлено');

    console.log('\n🎉 Все тесты завершены успешно!');
    console.log('📱 Проверьте канал -1002281903962 для просмотра уведомлений');

  } catch (error) {
    console.error('\n💥 Ошибка при тестировании уведомлений:', error);
    process.exit(1);
  }
}

// Запуск тестов
if (require.main === module) {
  testTelegramNotifications();
}

export { testTelegramNotifications };
