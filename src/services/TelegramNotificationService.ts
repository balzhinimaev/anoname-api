/**
 * Сервис для отправки уведомлений в Telegram канал
 * @module services/TelegramNotificationService
 */

import config from '../config';
import logger from '../utils/logger';

export interface UserRegistrationData {
  telegramId: number;
  username?: string;
  firstName?: string;
  lastName?: string;
  bio?: string;
  gender?: 'male' | 'female' | 'other';
  age?: number;
  profilePhoto?: string;
  cohort?: 'A' | 'B';
  campaign?: string;
  campaignId?: string;
  referralCode?: string;
  platform: string;
  userAgent?: string;
  ip?: string;
  registrationDate: Date;
}

export interface LeadData {
  telegramId: string;
  isRegistered: boolean;
  createdAt: Date;
}

export class TelegramNotificationService {
  private static readonly CHANNEL_ID = '-1002281903962';
  private static readonly BOT_TOKEN = config.botToken;

  /**
   * Отправляет сообщение в Telegram канал
   */
  private static async sendMessage(text: string): Promise<void> {
    if (!this.BOT_TOKEN) {
      logger.warn('BOT_TOKEN не настроен, уведомление не отправлено');
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this.BOT_TOKEN}/sendMessage`;
      const payload = {
        chat_id: this.CHANNEL_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json() as {
        ok: boolean;
        description?: string;
        result?: {
          message_id: number;
        };
      };
      
      if (!data.ok) {
        throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
      }

      logger.info('Уведомление отправлено в канал', {
        type: 'telegram_notification_sent',
        channelId: this.CHANNEL_ID,
        messageId: data.result?.message_id
      });

    } catch (error) {
      logger.error('Ошибка отправки уведомления в канал', {
        type: 'telegram_notification_error',
        channelId: this.CHANNEL_ID,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  /**
   * Форматирует дату и время в московском часовом поясе
   */
  private static formatMoscowDateTime(date: Date): string {
    const moscowTime = new Date(date.toLocaleString("en-US", {timeZone: "Europe/Moscow"}));
    return moscowTime.toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  }

  /**
   * Форматирует пол пользователя для отображения
   */
  private static formatGender(gender?: string): string {
    switch (gender) {
      case 'male': return '👨 Мужской';
      case 'female': return '👩 Женский';
      case 'other': return '🏳️‍⚧️ Другой';
      default: return '❓ Не указан';
    }
  }

  /**
   * Форматирует возраст пользователя
   */
  private static formatAge(age?: number): string {
    return age ? `${age} лет` : 'Не указан';
  }

  /**
   * Форматирует username для отображения
   */
  private static formatUsername(username?: string): string {
    return username ? `@${username}` : 'Не указан';
  }

  /**
   * Форматирует имя пользователя
   */
  private static formatName(firstName?: string, lastName?: string): string {
    const parts = [firstName, lastName].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : 'Не указано';
  }

  /**
   * Форматирует платформу
   */
  private static formatPlatform(platform: string): string {
    switch (platform) {
      case 'telegram': return '📱 Telegram WebApp';
      case 'vk': return '🔵 ВКонтакте (VK Mini App)';
      case 'web': return '🌐 Веб (браузер)';
      case 'api': return '🔧 API';
      default: return `📱 ${platform}`;
    }
  }

  /**
   * Форматирует когорту A/B тестирования
   */
  private static formatCohort(cohort?: string): string {
    switch (cohort) {
      case 'A': return '🅰️ Группа A';
      case 'B': return '🅱️ Группа B';
      default: return '❓ Не определена';
    }
  }

  /**
   * Отправляет уведомление о регистрации пользователя
   */
  static async sendUserRegistrationNotification(userData: UserRegistrationData): Promise<void> {
    const moscowTime = this.formatMoscowDateTime(userData.registrationDate);
    const name = this.formatName(userData.firstName, userData.lastName);
    const username = this.formatUsername(userData.username);
    const gender = this.formatGender(userData.gender);
    const age = this.formatAge(userData.age);
    const platform = this.formatPlatform(userData.platform);
    const cohort = this.formatCohort(userData.cohort);

    const message = `
#регистрация #anoname

🆕 <b>Новый пользователь зарегистрирован!</b>

👤 <b>Основная информация:</b>
• ID: <code>${userData.telegramId}</code>
• Имя: ${name}
• Username: ${username}
• Пол: ${gender}
• Возраст: ${age}

📊 <b>Дополнительные данные:</b>
• Платформа: ${platform}
• Когорта: ${cohort}
• Кампания: ${userData.campaign || 'Не указана'}
• ID кампании: ${userData.campaignId || 'Не указан'}
• Реферальный код: ${userData.referralCode || 'Не указан'}

🌐 <b>Техническая информация:</b>
• IP: <code>${userData.ip || 'Не определен'}</code>
• User Agent: <code>${userData.userAgent || 'Не определен'}</code>

⏰ <b>Время регистрации (МСК):</b>
<code>${moscowTime}</code>

${userData.bio ? `\n📝 <b>Описание:</b>\n${userData.bio}` : ''}
${userData.profilePhoto ? `\n🖼️ <b>Фото профиля:</b> <a href="${userData.profilePhoto}">Посмотреть</a>` : ''}
    `.trim();

    await this.sendMessage(message);
  }

  /**
   * Отправляет уведомление о новом лиде
   */
  static async sendLeadNotification(leadData: LeadData): Promise<void> {
    const moscowTime = this.formatMoscowDateTime(leadData.createdAt);
    const status = leadData.isRegistered ? '✅ Зарегистрирован' : '⏳ Ожидает регистрации';

    const message = `
#лид #anoname

🆕 <b>Новый лид добавлен!</b>

👤 <b>Информация о лиде:</b>
• Telegram ID: <code>${leadData.telegramId}</code>
• Статус: ${status}

⏰ <b>Время добавления (МСК):</b>
<code>${moscowTime}</code>
    `.trim();

    await this.sendMessage(message);
  }

  /**
   * Отправляет тестовое уведомление
   */
  static async sendTestNotification(): Promise<void> {
    const message = `
#тест #anoname

🧪 <b>Тестовое уведомление</b>

Это тестовое сообщение для проверки работы системы уведомлений.

⏰ <b>Время отправки (МСК):</b>
<code>${this.formatMoscowDateTime(new Date())}</code>
    `.trim();

    await this.sendMessage(message);
  }

  /**
   * Отправляет произвольное сообщение в канал (публичный метод)
   */
  static async sendCustomMessage(text: string): Promise<void> {
    await this.sendMessage(text);
  }
}
