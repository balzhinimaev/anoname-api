# Примеры использования Telegram Dating API

## Регистрация и аутентификация

### Важно! Сначала регистрация, потом вход

В системе сначала нужно **зарегистрировать** пользователя через `/api/auth/register`, а затем он сможет **входить** через `/api/auth/login`.

## Регистрация нового пользователя

### 1. Через Telegram WebApp initData (рекомендуемый способ)

```javascript
// Получаем данные из Telegram WebApp
const initData = window.Telegram.WebApp.initData;
const userData = window.Telegram.WebApp.initDataUnsafe.user;

// Регистрируем пользователя
const response = await fetch('/api/auth/register', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    telegramId: userData.id,
    platform: 'telegram',
    initData: initData,
    username: userData.username,
    firstName: userData.first_name,
    lastName: userData.last_name,
    profilePhoto: userData.photo_url
  })
});

const authData = await response.json();
console.log('Токен:', authData.token);
```

### 2. Умная аутентификация (регистрация или вход)

```javascript
async function authenticateUser() {
  const telegramData = getTelegramUserData();
  
  try {
    // Сначала пробуем войти
    const loginData = await loginUser(telegramData.telegramId, telegramData.initData);
    return loginData;
  } catch (error) {
    // Если пользователь не найден, регистрируем
    if (error.message.includes('Пользователь не найден')) {
      const registerData = await registerUser(telegramData);
      return registerData;
    }
    throw error;
  }
}
```

## Аутентификация

### 1. Через Telegram WebApp initData (рекомендуемый способ)

```javascript
// Получаем initData из Telegram WebApp
const initData = window.Telegram.WebApp.initData;
const userId = window.Telegram.WebApp.initDataUnsafe.user.id;

// Отправляем запрос на аутентификацию
const response = await fetch('/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    telegramId: userId,
    initData: initData,
    platform: 'telegram'
  })
});

const authData = await response.json();
console.log('Токен:', authData.token);
```

### 2. Через сервисный API-ключ

```javascript
const response = await fetch('/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': 'your-service-api-key'
  },
  body: JSON.stringify({
    telegramId: 1272270574,
    platform: 'api'
  })
});
```

### 3. Без initData (если отключено требование)

```javascript
const response = await fetch('/api/auth/login', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    telegramId: 1272270574,
    platform: 'telegram'
  })
});
```

## Использование токена

После успешной аутентификации используйте полученный токен для всех последующих запросов:

```javascript
const token = authData.token;

// Пример запроса к API
const response = await fetch('/api/users/profile', {
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});
```

## Настройка сервера

### Переменные окружения

Создайте файл `.env` в корне проекта:

```env
# Обязательные настройки
MONGODB_URI=mongodb://localhost:27017/telegram-dating
JWT_SECRET=your-super-secret-jwt-key-here
BOT_TOKEN=your-telegram-bot-token

# Настройки аутентификации
REQUIRE_TG_INITDATA=false  # Установите true для обязательной проверки initData
TG_INITDATA_MAX_AGE_SEC=300

# Сервисные API-ключи (опционально)
SERVICE_API_KEYS=key1,key2,key3

# CORS настройки
CORS_WHITELIST=http://localhost:3000,https://yourdomain.com
```

### Запуск сервера

```bash
# Установка зависимостей
npm install

# Запуск в режиме разработки
npm run dev

# Или через Docker
docker-compose up
```

## Обработка ошибок

### Пользователь не найден (404)
Ошибка возникает, когда:
- Пользователь пытается войти, но еще не зарегистрирован
- `telegramId` не существует в базе данных

**Решение:**
- Сначала зарегистрируйте пользователя через `/api/auth/register`
- Используйте умную аутентификацию (см. пример выше)

### Пользователь уже существует (409)
Ошибка возникает при попытке повторной регистрации.

**Решение:**
- Используйте `/api/auth/login` вместо `/api/auth/register`
- Или используйте умную аутентификацию

### HASH_MISSING
Ошибка возникает, когда:
- `initData` передан, но не содержит поле `hash`
- `initData` пустой или невалидный

**Решение:**
- Убедитесь, что получаете `initData` из `window.Telegram.WebApp.initData`
- Проверьте, что приложение запущено в Telegram WebApp

### HASH_MISMATCH
Ошибка возникает, когда:
- Подпись `initData` неверная
- `BOT_TOKEN` не соответствует токену бота, который создал `initData`

**Решение:**
- Проверьте правильность `BOT_TOKEN` в настройках
- Убедитесь, что `initData` не был изменен

### AUTH_DATE_EXPIRED
Ошибка возникает, когда:
- `initData` устарел (по умолчанию 5 минут)

**Решение:**
- Получите новый `initData` из Telegram WebApp
- Увеличьте `TG_INITDATA_MAX_AGE_SEC` в настройках

## Тестирование

### Создание тестового пользователя

```bash
npm run create-test-user
```

### Тестирование WebSocket соединения

```bash
npm run test-websocket
```

## Telegram уведомления

Система автоматически отправляет уведомления в Telegram канал при регистрации новых пользователей.

### Настройка

1. Убедитесь, что в `.env` настроен `BOT_TOKEN`
2. Канал для уведомлений: `-1002281903962`

### Тестирование уведомлений

```bash
# Тест отправки уведомлений
npm run test-telegram-notifications

# Тест регистрации с уведомлениями
node examples/test-registration-with-notifications.js
```

### Формат уведомлений

Каждое уведомление содержит:
- Хэштеги: `#регистрация #anoname`
- Основную информацию о пользователе
- Технические данные (IP, User Agent)
- Время регистрации в МСК
- Дополнительные поля (описание, фото)

Подробнее см. `examples/telegram-notifications.md`

## Дополнительные примеры

Смотрите файлы в папке `examples/` для полных примеров клиентского кода.
