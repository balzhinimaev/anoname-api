# Telegram уведомления

## Обзор

Система автоматически отправляет уведомления в Telegram канал при регистрации новых пользователей.

## Настройка

### 1. Переменные окружения

Убедитесь, что в `.env` файле настроен `BOT_TOKEN`:

```env
BOT_TOKEN=your-telegram-bot-token-here
```

### 2. ID канала

Канал для уведомлений: `-1002281903962`

## Формат уведомлений

### Уведомление о регистрации

Каждое уведомление содержит:

- **Хэштеги**: `#регистрация #anoname`
- **Основная информация**:
  - Telegram ID
  - Имя и фамилия
  - Username
  - Пол (с эмодзи)
  - Возраст
- **Дополнительные данные**:
  - Платформа (Telegram WebApp/API)
  - Когорта A/B тестирования
  - Кампания
  - Реферальный код
- **Техническая информация**:
  - IP адрес
  - User Agent
  - Время регистрации (МСК)
- **Опционально**:
  - Описание профиля
  - Фото профиля

### Пример уведомления

```
#регистрация #anoname

🆕 Новый пользователь зарегистрирован!

👤 Основная информация:
• ID: 7987208623
• Имя: R 2
• Username: @aphhhxhi
• Пол: 👨 Мужской
• Возраст: 25 лет

📊 Дополнительные данные:
• Платформа: 📱 Telegram WebApp
• Когорта: 🅰️ Группа A
• Кампания: test_campaign
• Реферальный код: REF123

🌐 Техническая информация:
• IP: 192.168.1.1
• User Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)...

⏰ Время регистрации (МСК):
2025-01-19 15:30:45

📝 Описание:
Это тестовый пользователь

🖼️ Фото профиля: Посмотреть
```

## Тестирование

### Запуск тестов

```bash
# Тест отправки уведомлений
npm run test-telegram-notifications
```

### Ручное тестирование

```javascript
import { TelegramNotificationService } from './src/services/TelegramNotificationService';

// Тестовое уведомление
await TelegramNotificationService.sendTestNotification();

// Уведомление о регистрации
await TelegramNotificationService.sendUserRegistrationNotification({
  telegramId: 123456789,
  username: 'testuser',
  firstName: 'Тест',
  lastName: 'Пользователь',
  platform: 'telegram',
  registrationDate: new Date()
});
```

## Обработка ошибок

Система автоматически обрабатывает ошибки:

- Если `BOT_TOKEN` не настроен - уведомления не отправляются (только логирование)
- Ошибки отправки логируются в систему логирования
- Ошибки не прерывают процесс регистрации

## Логирование

Все события уведомлений логируются:

- `telegram_notification_sent` - успешная отправка
- `telegram_notification_error` - ошибка отправки

## Настройка канала

### Добавление бота в канал

1. Добавьте бота в канал как администратора
2. Дайте боту права на отправку сообщений
3. Убедитесь, что ID канала правильный: `-1002281903962`

### Проверка прав бота

```bash
# Проверка информации о боте
curl "https://api.telegram.org/bot<BOT_TOKEN>/getMe"

# Проверка информации о канале
curl "https://api.telegram.org/bot<BOT_TOKEN>/getChat?chat_id=-1002281903962"
```

## Расширение функциональности

### Добавление новых типов уведомлений

1. Создайте новый метод в `TelegramNotificationService`
2. Добавьте соответствующий интерфейс данных
3. Интегрируйте в нужный контроллер

### Пример добавления уведомления о входе

```typescript
static async sendUserLoginNotification(userData: UserLoginData): Promise<void> {
  const message = `
#вход #anoname

🔐 <b>Пользователь вошел в систему</b>
• ID: <code>${userData.telegramId}</code>
• Время: <code>${this.formatMoscowDateTime(userData.loginDate)}</code>
  `.trim();

  await this.sendMessage(message);
}
```
