import mongoose from 'mongoose';
import Chat from '../models/Chat';
import Message from '../models/Message';
import User from '../models/User';
import { wsManager } from '../server';
import config from '../config';
import { wsLogger } from '../utils/logger';

export type IcebreakerKind = 'start' | 'idle' | 'manual';

// Сервисный «пользователь»-отправитель айсбрейкеров. telegramId отрицательный,
// чтобы гарантированно не пересечься с реальными Telegram ID.
const SYSTEM_TG_ID = -1;
const SYSTEM_FIRST_NAME = 'Купидон';

const OPENAI_TIMEOUT_MS = 12_000;
const HISTORY_LIMIT = 10;
const MAX_ICEBREAKER_LEN = 300;

// Запасные айсбрейкеры на случай отсутствия ключа/ошибки OpenAI
const FALLBACK_ICEBREAKERS: string[] = [
  'Какая у тебя самая странная привычка, о которой мало кто знает? 😄',
  'Если бы можно было телепортироваться в любое место прямо сейчас — куда бы отправился(ась)?',
  'Что из последнего тебя по-настоящему рассмешило?',
  'Опиши свой идеальный выходной тремя словами 🎯',
  'Какой навык ты бы мгновенно освоил(а), если бы это было возможно?',
  'Пицца с ананасами — преступление или шедевр? 🍍',
  'Какая песня сейчас у тебя на повторе?',
  'Если бы твоя жизнь была фильмом — какой это был бы жанр?',
  'Что бы ты сделал(а), если бы завтра не нужно было работать/учиться?',
  'Сова или жаворонок? И как тебе живётся с этим? 🦉',
  'Какое место из тех, где ты был(а), впечатлило больше всего?',
  'Есть ли у тебя «guilty pleasure» — что-то, что любишь, но стесняешься признать? 😏',
  'Если бы животные умели говорить, кто был бы самым грубым?',
  'Чай, кофе или что-то покрепче... какао? ☕',
  'Какой самый спонтанный поступок ты совершал(а)?',
  'О чём ты можешь говорить часами без остановки?',
  'Какая суперспособность тебе нужнее всего в обычной жизни?',
  'Что для тебя идеальное первое свидание — кино, прогулка или что-то безумное? 💫',
  'Верю — не верю: расскажи два факта о себе, один из них выдуманный. Собеседник угадывает!',
  'Если бы тебе дали миллион, но потратить его нужно за сутки — на что?',
  'Какое блюдо ты готовишь лучше всего? 🍳',
  'Горы или море? И почему?',
  'Какая твоя самая большая мечта из детства? Сбылась?',
  'Задай собеседнику вопрос, который тебе самому(ой) никогда не задавали 😉',
];

class IcebreakerServiceImpl {
  private systemUserId: string | null = null;
  private inFlight = new Set<string>();
  // Последние подсказки по чату — чтобы не повторяться (и для промпта, и для fallback)
  private recentByChat = new Map<string, string[]>();

  private async ensureSystemUser(): Promise<string> {
    if (this.systemUserId) return this.systemUserId;
    const doc = await User.findOneAndUpdate(
      { telegramId: SYSTEM_TG_ID },
      { $setOnInsert: { telegramId: SYSTEM_TG_ID, firstName: SYSTEM_FIRST_NAME } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).select('_id');
    this.systemUserId = String(doc!._id);
    return this.systemUserId;
  }

  /**
   * Генерирует и отправляет айсбрейкер в чат как системное сообщение (type='icebreaker').
   * Идёт обычным пайплайном chat:message — попадает в историю и на все платформы.
   */
  async sendIcebreaker(chatId: string, kind: IcebreakerKind): Promise<boolean> {
    if (this.inFlight.has(chatId)) return false;
    this.inFlight.add(chatId);
    try {
      const chat = await Chat.findById(chatId).select('participants isActive');
      if (!chat || !chat.isActive) return false;

      // Авто-подсказки (старт/тишина) — только если ОБА не выключили Купидона
      // в настройках (генерация использует текст переписки → это приватность).
      // Ручной запрос кнопкой 💡 работает всегда.
      if (kind !== 'manual') {
        const optedOut = await User.exists({
          _id: { $in: chat.participants },
          'preferences.cupidHints': false,
        });
        if (optedOut) return false;
      }

      const text = await this.generate(chatId, kind);
      if (!text) return false;

      // Повторная проверка: за время генерации чат мог завершиться
      const still = await Chat.findById(chatId).select('isActive');
      if (!still || !still.isActive) return false;

      const senderId = await this.ensureSystemUser();
      const message = await Message.create({
        chatId: new mongoose.Types.ObjectId(chatId),
        sender: new mongoose.Types.ObjectId(senderId),
        content: text,
        type: 'icebreaker',
      });
      await Chat.updateOne({ _id: chatId }, { $set: { lastMessage: message._id } });

      const populated = await message.populate({
        path: 'sender',
        select: 'telegramId firstName photos profilePhoto',
      });

      wsManager.io.to(`chat:${chatId}`).emit('chat:message', {
        chatId,
        message: populated,
      });

      const recent = this.recentByChat.get(chatId) || [];
      recent.push(text);
      this.recentByChat.set(chatId, recent.slice(-5));

      wsLogger.info('icebreaker_sent', `Icebreaker (${kind}) sent to chat ${chatId}`, { chatId, kind });
      return true;
    } catch (error) {
      wsLogger.error('icebreaker_send', 'system', error as Error, { chatId, kind });
      return false;
    } finally {
      this.inFlight.delete(chatId);
    }
  }

  /** Есть ли в чате хоть одно сообщение (для решения о стартовом айсбрейкере) */
  async chatHasMessages(chatId: string): Promise<boolean> {
    const exists = await Message.exists({ chatId: new mongoose.Types.ObjectId(chatId) });
    return !!exists;
  }

  /** Забыть состояние чата (вызывается при завершении чата) */
  forgetChat(chatId: string): void {
    this.recentByChat.delete(chatId);
  }

  private async generate(chatId: string, kind: IcebreakerKind): Promise<string> {
    if (config.openai.apiKey) {
      try {
        const text = await this.generateViaOpenAI(chatId, kind);
        if (text) return text;
      } catch (error) {
        wsLogger.warn('icebreaker_openai_failed', (error as Error).message, { chatId, kind });
      }
    }
    return this.pickFallback(chatId);
  }

  private pickFallback(chatId: string): string {
    const recent = this.recentByChat.get(chatId) || [];
    const pool = FALLBACK_ICEBREAKERS.filter((t) => !recent.includes(t));
    const list = pool.length > 0 ? pool : FALLBACK_ICEBREAKERS;
    return list[Math.floor(Math.random() * list.length)];
  }

  private async buildHistorySnippet(chatId: string): Promise<string> {
    const messages = await Message.find({ chatId: new mongoose.Types.ObjectId(chatId) })
      .sort({ timestamp: -1 })
      .limit(HISTORY_LIMIT)
      .select('sender content type')
      .lean();
    if (messages.length === 0) return '';

    // Анонимизация: участники → «Собеседник 1/2», наши подсказки → «Подсказка»
    const senderLabels = new Map<string, string>();
    const lines: string[] = [];
    for (const m of messages.reverse()) {
      let label: string;
      if (m.type === 'icebreaker') {
        label = 'Подсказка';
      } else {
        const key = String(m.sender);
        if (!senderLabels.has(key)) {
          senderLabels.set(key, `Собеседник ${senderLabels.size + 1}`);
        }
        label = senderLabels.get(key)!;
      }
      const content = String(m.content || '').replace(/\s+/g, ' ').slice(0, 150);
      lines.push(`${label}: ${content}`);
    }
    return lines.join('\n');
  }

  private async generateViaOpenAI(chatId: string, kind: IcebreakerKind): Promise<string> {
    const history = kind === 'start' ? '' : await this.buildHistorySnippet(chatId);
    const recent = this.recentByChat.get(chatId) || [];

    const system =
      'Ты — Купидон, ведущий анонимного чата-знакомства в формате «свидание вслепую». ' +
      'Твоя задача — оживлять диалог и помогать людям узнать друг друга. ' +
      'Сгенерируй ОДНУ короткую реплику: интересный, необычный вопрос или тему для обоих собеседников. ' +
      'Правила: пиши по-русски; максимум 180 символов; без приветствий, нумерации и кавычек; ' +
      'не проси и не упоминай личные данные (имена, телефоны, соцсети, адреса, место работы); ' +
      'без пошлости и грубости; тон лёгкий, игривый, дружелюбный; можно 1 эмодзи.';

    let user: string;
    if (kind === 'start') {
      user =
        'Диалог только начался, собеседники ещё ничего не написали друг другу. ' +
        'Предложи лёгкий необычный вопрос-айсбрейкер, с которого приятно начать знакомство.';
    } else if (kind === 'idle') {
      user =
        'В диалоге повисла пауза — никто не пишет. Последние сообщения:\n' +
        (history || '(сообщений пока нет)') +
        '\nПредложи новую тему или вопрос, который оживит разговор. Учитывай контекст и не повторяй уже обсуждённое.';
    } else {
      user =
        'Собеседники попросили подсказать тему для разговора. Последние сообщения:\n' +
        (history || '(сообщений пока нет)') +
        '\nПредложи неожиданный интересный вопрос или мини-игру в формате короткой реплики.';
    }
    if (recent.length > 0) {
      user += '\nРанее ты уже предлагал: ' + recent.map((t) => `«${t}»`).join('; ') + '. Не повторяйся.';
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openai.apiKey}`,
        },
        body: JSON.stringify({
          model: config.openai.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: 150,
          temperature: 1.0,
          presence_penalty: 0.6,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      let text = (json.choices?.[0]?.message?.content || '').trim();
      // Снимаем обрамляющие кавычки, если модель их всё же добавила
      text = text.replace(/^["«»']+|["«»']+$/g, '').trim();
      if (!text) return '';
      if (text.length > MAX_ICEBREAKER_LEN) text = text.slice(0, MAX_ICEBREAKER_LEN - 1) + '…';
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const IcebreakerService = new IcebreakerServiceImpl();
