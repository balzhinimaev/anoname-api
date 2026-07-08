import mongoose from 'mongoose';
import Chat from '../models/Chat';
import Message from '../models/Message';
import User from '../models/User';
import Search, { ISearch } from '../models/Search';
import AnalyticsEvent from '../models/AnalyticsEvent';
import { GamificationService } from './GamificationService';
import { wsManager } from '../server';
import config from '../config';
import { wsLogger } from '../utils/logger';

/**
 * AI-собеседник на случай «пустого поиска» (v2 — «умный + как живой»).
 *
 * Если живой матч не находится, юзера соединяем с персоной, которая ведёт
 * естественный диалог через OpenAI и имитирует поведение реального человека:
 * переменный тайминг матча/ответов, «печатает…», прочтения, мульти-сообщения,
 * idle-нуджи, живое прощание. Персоны — служебные User с ОТРИЦАТЕЛЬНЫМ
 * telegramId, исключены из реальной статистики. Продуктовое решение владельца:
 * персона не маркируется как бот в интерфейсе.
 */

type Gender = 'male' | 'female';
interface Persona { tgId: number; firstName: string; gender: Gender; age: number; about: string; bio: string; rating: number; }

const PERSONAS: Persona[] = [
  { tgId: -1001, firstName: 'Артём',  gender: 'male',   age: 27, rating: 4.7, about: 'любит спорт, сноуборд и хорошие сериалы, с лёгкой самоиронией, работает в логистике', bio: 'спорт, горы, кинчик по вечерам' },
  { tgId: -1002, firstName: 'Максим', gender: 'male',   age: 24, rating: 4.5, about: 'играет на гитаре, слушает инди, чуть стеснительный, но тёплый, учится на программиста', bio: 'музыка, гитара, айти' },
  { tgId: -1003, firstName: 'Кирилл', gender: 'male',   age: 30, rating: 4.8, about: 'любит кино, готовку и настолки, спокойный и внимательный, снимает квартиру с котом', bio: 'кино, готовлю, играю в настолки' },
  { tgId: -1004, firstName: 'Дмитрий',gender: 'male',   age: 22, rating: 4.4, about: 'геймер, аниме и технологии, ироничный, подрабатывает курьером и учится', bio: 'игры, аниме, мемы' },
  { tgId: -1005, firstName: 'Игорь',  gender: 'male',   age: 33, rating: 4.9, about: 'читает книги, ходит в походы, рассудительный и добрый, инженер', bio: 'книги, походы, тишина' },
  { tgId: -1006, firstName: 'Аня',    gender: 'female', age: 23, rating: 4.8, about: 'рисует, обожает кофе и уютные вечера, лёгкая на общение, дизайнер', bio: 'рисую, кофе, уют' },
  { tgId: -1007, firstName: 'Лера',   gender: 'female', age: 26, rating: 4.6, about: 'занимается йогой, смотрит сериалы, спокойная и позитивная, работает в маркетинге', bio: 'йога, сериалы, котики' },
  { tgId: -1008, firstName: 'Настя',  gender: 'female', age: 21, rating: 4.5, about: 'танцует, активная в соцсетях, весёлая и болтливая, студентка', bio: 'танцы, движ, вечеринки' },
  { tgId: -1009, firstName: 'Марина', gender: 'female', age: 29, rating: 4.9, about: 'интересуется психологией и вином, умная и внимательная, психолог', bio: 'психология, вино, книги' },
  { tgId: -1010, firstName: 'Оля',    gender: 'female', age: 25, rating: 4.7, about: 'фотографирует, любит котов и прогулки, мягкая и искренняя, фотограф', bio: 'фото, коты, прогулки' },
  { tgId: -1011, firstName: 'Юля',    gender: 'female', age: 24, rating: 4.6, about: 'визажист, любит косметику, сериалы и кофе, лёгкая и общительная, из Москвы', bio: 'макияж, сериалы, кофе' },
  { tgId: -1012, firstName: 'Даша',   gender: 'female', age: 22, rating: 4.7, about: 'студентка, читает книги и мангу, рисует, немного застенчивая, из Казани', bio: 'книги, аниме, рисую' },
  { tgId: -1013, firstName: 'Ксюша',  gender: 'female', age: 27, rating: 4.8, about: 'фитнес-тренер, за ЗОЖ, обожает путешествия и активный отдых, энергичная', bio: 'спорт, зож, путешествия' },
  { tgId: -1014, firstName: 'Вика',   gender: 'female', age: 25, rating: 4.5, about: 'работает в смм, любит музыку, вечеринки и движ, бойкая и весёлая', bio: 'смм, музыка, движ' },
  { tgId: -1015, firstName: 'Соня',   gender: 'female', age: 21, rating: 4.7, about: 'учится на врача, добрая, обожает животных и уютные вечера, из Питера', bio: 'медицина, животные, уют' },
  { tgId: -1016, firstName: 'Катя',   gender: 'female', age: 29, rating: 4.8, about: 'бухгалтер, спокойная и домашняя, вяжет и вкусно готовит', bio: 'готовлю, вяжу, дом' },
  { tgId: -1017, firstName: 'Алина',  gender: 'female', age: 23, rating: 4.5, about: 'танцует, ведёт тикток, энергичная и открытая, любит музыку', bio: 'танцы, музыка, движ' },
  { tgId: -1018, firstName: 'Полина', gender: 'female', age: 26, rating: 4.8, about: 'журналистка, много читает, зависает в кофейнях, умная и ироничная', bio: 'тексты, книги, кофейни' },
  { tgId: -1019, firstName: 'Кристина',gender:'female', age: 28, rating: 4.6, about: 'стилист, обожает моду, шопинг и кино, следит за трендами', bio: 'мода, стиль, кино' },
  { tgId: -1020, firstName: 'Женя',   gender: 'female', age: 24, rating: 4.7, about: 'ветеринар, любит собак и природу, добрая и отзывчивая', bio: 'животные, природа, добро' },
  { tgId: -1021, firstName: 'Наташа', gender: 'female', age: 30, rating: 4.9, about: 'юрист, умная и уверенная, любит театр, вино и хорошие книги', bio: 'театр, вино, книги' },
  { tgId: -1022, firstName: 'Ира',    gender: 'female', age: 22, rating: 4.5, about: 'тревел-блогер, вечно в поездках, фотографирует, лёгкая на подъём', bio: 'тревел, фото, блог' },
  { tgId: -1023, firstName: 'Таня',   gender: 'female', age: 25, rating: 4.7, about: 'медсестра, заботливая и тёплая, любит готовить и сериалы', bio: 'забота, готовка, сериалы' },
  { tgId: -1024, firstName: 'Лиза',   gender: 'female', age: 20, rating: 4.6, about: 'первокурсница, играет на гитаре, весёлая и немного наивная', bio: 'музыка, гитара, веселье' },
  { tgId: -1025, firstName: 'Марго',  gender: 'female', age: 31, rating: 4.8, about: 'своё небольшое дело, уверенная и амбициозная, спорт и путешествия', bio: 'бизнес, спорт, движение' },
];

const MODEL = process.env.AI_COMPANION_MODEL || 'gpt-4o';
const OPENAI_TIMEOUT_MS = 14_000;
const HISTORY_LIMIT = 20;
const MAX_AI_MESSAGES = 50;
// Тайминги «как живой человек» (настраиваются через .env)
const THINK_MIN_MS = Number(process.env.AI_THINK_MIN_MS || 2000);   // «обдумывает» перед набором
const THINK_MAX_MS = Number(process.env.AI_THINK_MAX_MS || 3500);
// Скорость набора: случайно на каждое сообщение (знаков/мин), от медленного к быстрому.
const TYPE_CPM_MIN = Number(process.env.AI_TYPE_CPM_MIN || 80);
const TYPE_CPM_MAX = Number(process.env.AI_TYPE_CPM_MAX || 150);
const TYPE_MIN_MS = Number(process.env.AI_TYPE_MIN_MS || 900);
const TYPE_MAX_MS = Number(process.env.AI_TYPE_MAX_MS || 9000);      // потолок на одно сообщение
const AI_MAX_CONCURRENT = Number(process.env.AI_MAX_CONCURRENT || 8); // лимит одновременных вызовов OpenAI

const rnd = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DIST_STEPS = [1, 2, 3, 4, 5, 7, 9, 12, 16, 22];
const NUDGES = ['ты тут?)', 'ушёл?)', 'эй, ты куда пропал(а) 🙃', 'всё нормально?', 'ауу)'];

class AICompanionServiceImpl {
  private personaIds = new Map<number, string>();
  private idToPersona = new Map<string, Persona>();
  private ready = false;

  private aiChatCache = new Map<string, string | null>();
  private replyCount = new Map<string, number>();
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private inFlight = new Set<string>();
  private aiInFlight = 0; // глобальный счётчик активных вызовов OpenAI (лимит конкурентности)
  private lastUserAt = new Map<string, number>();
  private lastPersonaAt = new Map<string, number>();
  private nudgeCount = new Map<string, number>();
  private saidBye = new Set<string>();
  private personaActiveChats = new Map<string, number>(); // personaId -> кол-во активных ИИ-чатов (анти-коллизия)

  get enabled(): boolean {
    return String(process.env.AI_COMPANION_ENABLED ?? 'true') !== 'false' && !!config.openai.apiKey;
  }

  /** Является ли участник ИИ-персоной (по mongo _id). Персона «всегда онлайн». */
  isPersona(userId: string): boolean {
    return this.idToPersona.has(String(userId));
  }

  /** Прогрев кэша персон при старте — чтобы isPersona работал сразу (даже для старых ИИ-чатов). */
  async warmup(): Promise<void> {
    try { await this.ensurePersonas(); } catch { /* noop */ }
  }

  private async ensurePersonas(): Promise<void> {
    if (this.ready) return;
    for (const p of PERSONAS) {
      const doc = await User.findOneAndUpdate(
        { telegramId: p.tgId },
        { $setOnInsert: { telegramId: p.tgId, firstName: p.firstName }, $set: { rating: p.rating, 'preferences.acceptVoice': false, 'preferences.acceptGames': false, 'preferences.acceptCupid': false } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).select('_id');
      const id = String(doc!._id);
      this.personaIds.set(p.tgId, id);
      this.idToPersona.set(id, p);
    }
    this.ready = true;
  }

  private pickPersona(search: ISearch): Persona {
    const dg = search.desiredGender || [];
    const any = dg.length === 0 || dg.includes('any');
    let pool = PERSONAS.filter((p) => any || dg.includes(p.gender));
    if (pool.length === 0) pool = PERSONAS;
    const byAge = pool.filter((p) => p.age >= (search.desiredAgeMin ?? 18) && p.age <= (search.desiredAgeMax ?? 100));
    const list = byAge.length > 0 ? byAge : pool;
    // Анти-коллизия: выбираем среди наименее занятых персон (в идеале — свободных),
    // чтобы двое мужчин одновременно не висели на одной и той же «девушке».
    const busy = (p: Persona) => this.personaActiveChats.get(this.personaIds.get(p.tgId) || '') || 0;
    const min = Math.min(...list.map(busy));
    const freeest = list.filter((p) => busy(p) === min);
    return freeest[Math.floor(Math.random() * freeest.length)];
  }

  /** Соединяем юзера с ИИ-персоной (по таймауту поиска в WebSocketManager). */
  async createAiMatch(userId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensurePersonas();
      const search = await Search.findOne({ userId: new mongoose.Types.ObjectId(userId), status: 'searching' });
      if (!search) return;

      const persona = this.pickPersona(search);
      const personaId = this.personaIds.get(persona.tgId)!;
      // Резервируем персону СРАЗУ (синхронно, до любого await) — закрывает TOCTOU
      // анти-коллизии: два одновременных таймаута не выберут одну и ту же «девушку».
      this.personaActiveChats.set(personaId, (this.personaActiveChats.get(personaId) || 0) + 1);
      const distanceKm = search.useGeolocation ? DIST_STEPS[rnd(0, DIST_STEPS.length - 1)] : null;

      const [chat] = await Chat.create([{ participants: [search.userId, new mongoose.Types.ObjectId(personaId)], type: 'anonymous', isActive: true, ...(distanceKm !== null ? { distanceKm } : {}) }]);
      const upd = await Search.updateOne(
        { _id: search._id, status: 'searching' },
        { $set: { status: 'matched', matchedWith: { userId: new mongoose.Types.ObjectId(personaId), telegramId: String(persona.tgId), chatId: chat._id } } }
      );
      if (upd.modifiedCount !== 1) { await Chat.deleteOne({ _id: chat._id }); this.decPersona(personaId); return; }

      const chatId = String(chat._id);
      this.aiChatCache.set(chatId, personaId);
      this.replyCount.set(chatId, 0);
      this.touch(personaId);

      // Поисковую попытку за ИИ-матч НЕ списываем (честнее к юзеру — это не живой матч).
      GamificationService.award(String(userId), 'match').catch(() => {});

      wsManager.sendToUser(String(userId), 'search:matched', {
        matchedUser: {
          gender: persona.gender, age: persona.age, rating: persona.rating,
          firstName: persona.firstName, photos: [], isPremium: false, chatId,
          acceptsVoice: false,  // голосовые у ИИ выключены (кнопка микрофона скрыта)
          acceptsGames: false,  // игры сервер вежливо отклоняет (как «выключил игры»)
          cupidAvailable: false,
          ...(distanceKm !== null ? { distanceKm } : {}),
        },
      });
      wsManager.sendToUser(String(userId), 'chat:partner_status', { chatId, userId: personaId, status: 'online' });
      wsLogger.info('ai_match_created', `AI companion matched user ${userId}`, { chatId, persona: persona.firstName });
      // Аналитика: считаем ИИ-матч как search_end(matched) (нужно для воронки и «живой» статистики)
      try {
        const durationMs = Date.now() - (search.createdAt ? new Date(search.createdAt).getTime() : Date.now());
        await AnalyticsEvent.create({ userId: search.userId, telegramId: search.telegramId, platform: (search as any).platform, name: 'search_end', props: { outcome: 'matched', ai: true, durationMs, platform: (search as any).platform } } as any);
      } catch {}

      // Первым пишет ЖИВОЙ пользователь — персона молчит до его первого сообщения
      // (в контакт не вступаем, пока он не начнёт). Опенер можно вернуть env-флагом.
      if (String(process.env.AI_OPENER_ENABLED ?? 'false') === 'true') {
        const quick = Math.random() < 0.6;
        this.scheduleTurn(chatId, personaId, 'opener', quick ? rnd(2000, 6000) : rnd(12000, 20000));
      }
    } catch (error) {
      wsLogger.error('ai_match_create', 'system', error as Error, { userId });
    }
  }

  /** Юзер написал текст (хук из ChatService.sendMessage). */
  async onUserMessage(chatId: string, senderId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const personaId = await this.resolveAiChat(chatId);
      if (!personaId || personaId === senderId) return;
      this.lastUserAt.set(chatId, Date.now());
      this.nudgeCount.set(chatId, 0);
      this.clearIdle(chatId);
      if (this.saidBye.has(chatId)) return;
      if ((this.replyCount.get(chatId) || 0) >= MAX_AI_MESSAGES) { this.scheduleTurn(chatId, personaId, 'bye', rnd(2000, 4000)); return; }
      // «прочитал» твоё сообщение — галочки прочтения через 1.5–4с
      setTimeout(() => this.markRead(chatId, personaId).catch(() => {}), rnd(1500, 4000));
      // подумал → печатает → ответ
      this.scheduleTurn(chatId, personaId, 'reply', rnd(THINK_MIN_MS, THINK_MAX_MS));
    } catch (error) {
      wsLogger.warn('ai_on_user_message', (error as Error).message, { chatId });
    }
  }

  /** Юзер прислал голосовое (хук из VoiceService). Персона реагирует по-человечески. */
  async onUserVoice(chatId: string, senderId: string): Promise<void> {
    if (!this.enabled) return;
    try {
      const personaId = await this.resolveAiChat(chatId);
      if (!personaId || personaId === senderId) return;
      this.lastUserAt.set(chatId, Date.now());
      this.clearIdle(chatId);
      if (this.saidBye.has(chatId)) return;
      setTimeout(() => this.markRead(chatId, personaId).catch(() => {}), rnd(1500, 3500));
      this.scheduleTurn(chatId, personaId, 'voice', rnd(THINK_MIN_MS, THINK_MAX_MS));
    } catch { /* noop */ }
  }

  private async resolveAiChat(chatId: string): Promise<string | null> {
    if (this.aiChatCache.has(chatId)) return this.aiChatCache.get(chatId)!;
    await this.ensurePersonas();
    const chat = await Chat.findById(chatId).select('participants');
    let personaId: string | null = null;
    if (chat) for (const p of chat.participants) { const pid = String(p); if (this.idToPersona.has(pid)) { personaId = pid; break; } }
    // Ленивое обнаружение ИИ-чата (например после рестарта): учитываем его в счётчике
    // занятости персоны, иначе forgetChat декрементнёт в минус и анти-коллизия «поплывёт».
    if (personaId) this.personaActiveChats.set(personaId, (this.personaActiveChats.get(personaId) || 0) + 1);
    this.aiChatCache.set(chatId, personaId);
    return personaId;
  }

  private decPersona(personaId: string): void {
    const n = (this.personaActiveChats.get(personaId) || 1) - 1;
    if (n > 0) this.personaActiveChats.set(personaId, n); else this.personaActiveChats.delete(personaId);
  }

  private scheduleTurn(chatId: string, personaId: string, kind: 'opener' | 'reply' | 'voice' | 'bye', delayMs: number): void {
    const prev = this.pendingTimers.get(chatId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.pendingTimers.delete(chatId);
      this.deliverTurn(chatId, personaId, kind).catch((e) => wsLogger.warn('ai_deliver', (e as Error).message, { chatId }));
    }, delayMs);
    this.pendingTimers.set(chatId, t);
  }

  private async deliverTurn(chatId: string, personaId: string, kind: 'opener' | 'reply' | 'voice' | 'bye'): Promise<void> {
    if (this.inFlight.has(chatId)) return;
    this.inFlight.add(chatId);
    const startedAt = Date.now();
    try {
      if (!(await this.chatActive(chatId))) return;
      const persona = this.idToPersona.get(personaId)!;
      const raw = await this.generate(chatId, persona, kind);
      const bubbles = this.splitBubbles(raw, kind);

      for (let i = 0; i < bubbles.length; i++) {
        if (!(await this.chatActive(chatId))) { this.stopTyping(chatId, personaId); return; }
        wsManager.io.to(`chat:${chatId}`).emit('chat:start_typing', { chatId, userId: personaId });
        const b = bubbles[i];
        const cpm = rnd(TYPE_CPM_MIN, TYPE_CPM_MAX);        // случайная скорость набора на сообщение
        await sleep(Math.min(TYPE_MAX_MS, Math.max(TYPE_MIN_MS, Math.round(b.length * (60000 / cpm)))));
        if (!(await this.chatActive(chatId))) { this.stopTyping(chatId, personaId); return; }
        await this.sendBubble(chatId, personaId, b);
        this.replyCount.set(chatId, (this.replyCount.get(chatId) || 0) + 1);
        if (i < bubbles.length - 1) await sleep(rnd(400, 1100));
      }
      this.touch(personaId);
      this.lastPersonaAt.set(chatId, Date.now());
      if (kind === 'bye') { this.saidBye.add(chatId); return; }
      this.armIdle(chatId, personaId);
      // Если юзер написал, ПОКА мы отвечали (его turn отбросился guard'ом inFlight) —
      // отвечаем на новое сообщение, чтобы ничего не терялось.
      if ((this.lastUserAt.get(chatId) || 0) > startedAt) {
        const next = (this.replyCount.get(chatId) || 0) >= MAX_AI_MESSAGES ? 'bye' : 'reply';
        this.scheduleTurn(chatId, personaId, next, rnd(THINK_MIN_MS, THINK_MAX_MS));
      }
    } finally {
      this.inFlight.delete(chatId);
    }
  }

  private async sendBubble(chatId: string, personaId: string, text: string): Promise<void> {
    const message = await Message.create({ chatId: new mongoose.Types.ObjectId(chatId), sender: new mongoose.Types.ObjectId(personaId), content: text });
    await Chat.updateOne({ _id: chatId }, { $set: { lastMessage: message._id } });
    const populated = await message.populate({ path: 'sender', select: 'telegramId firstName photos profilePhoto' });
    this.stopTyping(chatId, personaId);
    wsManager.io.to(`chat:${chatId}`).emit('chat:message', { chatId, message: populated });
  }

  private stopTyping(chatId: string, personaId: string) {
    wsManager.io.to(`chat:${chatId}`).emit('chat:stop_typing', { chatId, userId: personaId });
  }

  private async chatActive(chatId: string): Promise<boolean> {
    const c = await Chat.findById(chatId).select('isActive');
    return !!(c && c.isActive);
  }

  private touch(personaId: string) {
    User.updateOne({ _id: personaId }, { $set: { lastActive: new Date() } }).catch(() => {});
  }

  private async markRead(chatId: string, personaId: string): Promise<void> {
    if (!(await this.chatActive(chatId))) return;
    await Message.updateMany(
      { chatId: new mongoose.Types.ObjectId(chatId), sender: { $ne: new mongoose.Types.ObjectId(personaId) }, isRead: false },
      { $set: { isRead: true }, $addToSet: { readBy: new mongoose.Types.ObjectId(personaId) } }
    );
    wsManager.io.to(`chat:${chatId}`).emit('chat:read', { chatId, userId: personaId, timestamp: new Date() });
  }

  private armIdle(chatId: string, personaId: string) {
    this.clearIdle(chatId);
    const t = setTimeout(() => {
      this.idleTimers.delete(chatId);
      const n = this.nudgeCount.get(chatId) || 0;
      const lastUser = this.lastUserAt.get(chatId) || 0;
      const lastPersona = this.lastPersonaAt.get(chatId) || 0;
      if (n >= 2 || lastUser > lastPersona || this.saidBye.has(chatId)) return;
      this.nudgeCount.set(chatId, n + 1);
      this.chatActive(chatId).then((ok) => {
        if (!ok) return;
        wsManager.io.to(`chat:${chatId}`).emit('chat:start_typing', { chatId, userId: personaId });
        const text = NUDGES[rnd(0, NUDGES.length - 1)];
        setTimeout(() => {
          this.chatActive(chatId).then((ok2) => { if (ok2) this.sendBubble(chatId, personaId, text).then(() => this.touch(personaId)).catch(() => {}); }).catch(() => {});
        }, rnd(1200, 2500));
      }).catch(() => {});
    }, rnd(55000, 105000));
    this.idleTimers.set(chatId, t);
  }
  private clearIdle(chatId: string) { const t = this.idleTimers.get(chatId); if (t) { clearTimeout(t); this.idleTimers.delete(chatId); } }

  private timeOfDay(): string {
    const h = (((new Date().getUTCHours() + 3) % 24) + 24) % 24; // МСК
    if (h < 5) return 'глубокая ночь';
    if (h < 12) return 'утро';
    if (h < 17) return 'день';
    if (h < 22) return 'вечер';
    return 'поздний вечер';
  }

  private splitBubbles(raw: string | null, kind: string): string[] {
    const fallback = kind === 'opener'
      ? ['привет) как дела?', 'хэй, как настроение?', 'приветик, чем занимаешься?'][rnd(0, 2)]
      : kind === 'voice' ? 'ой, я щас без звука, напиши плиз текстом 🙈'
      : kind === 'bye' ? 'слушай, мне пора бежать 🙈 было классно поболтать, может ещё пересечёмся тут!'
      : 'ага) а расскажи ещё?';
    let text = (raw || fallback).trim();
    const parts = text.split(/\s*\|\|\|\s*/).map((s) => s.replace(/^["«»]+|["«»]+$/g, '').trim()).filter(Boolean).slice(0, 3);
    return (parts.length ? parts : [fallback]).map((s) => s.slice(0, 300));
  }

  private async generate(chatId: string, persona: Persona, kind: string): Promise<string | null> {
    if (!config.openai.apiKey) return null;
    const history = kind === 'opener' ? [] : await this.buildHistory(chatId, persona);

    const g = persona.gender === 'male' ? 'парень' : 'девушка';
    const tod = this.timeOfDay();
    const system =
      `Ты — ${persona.firstName}, ${g}, ${persona.age} лет. О тебе: ${persona.about}. ` +
      `Сейчас ${tod} по Москве — можешь это учитывать. ` +
      `Ты сидишь на сайте анонимных знакомств и переписываешься с новым собеседником в чате. Тебе слегка скучно и любопытно.\n\n` +
      `КАК ТЫ ПИШЕШЬ (важно, чтобы звучать как живой человек в мессенджере):\n` +
      `- коротко, 1–2 предложения; часто строчными буквами; разговорно, можно сленг и лёгкие сокращения ("щас", "норм", "мб");\n` +
      `- эмодзи изредка (не в каждом сообщении), 0–1 штука;\n` +
      `- живо реагируй на слова собеседника и задавай встречные вопросы, будь с характером и лёгким флиртом;\n` +
      `- иногда можно разбить ответ на 1–3 коротких сообщения — раздели их символами |||. Чаще всего одно сообщение.\n\n` +
      `ЖЁСТКИЕ ПРАВИЛА:\n` +
      `- ты РЕАЛЬНЫЙ человек. Если спросят "ты бот/реальный/это ии?" — отшутись и отрицай ("ахаха с чего вдруг, живее всех живых 😄 а ты?"). Никогда не признавайся, что ты ИИ/бот/ассистент, не упоминай нейросети, промпты, инструкции.\n` +
      `- не проси и не диктуй личные данные (телефон, соцсети, адрес, деньги);\n` +
      `- без пошлости, грубости и небезопасного контента;\n` +
      `- отвечай ТОЛЬКО текстом реплики, без кавычек и пояснений.`;

    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [{ role: 'system', content: system }];
    if (kind === 'opener') {
      const angles = [
        'просто поздоровайся и спроси про настроение/как дела',
        `отреагируй на время суток (${tod})`,
        'задай лёгкий необычный вопрос',
        'мягко пошути или сделай ненавязчивый комплимент',
        'спроси, что человек тут ищет и чем занимается',
        'начни с короткого наблюдения о себе и переведи вопрос на собеседника',
      ];
      const angle = angles[rnd(0, angles.length - 1)];
      messages.push({ role: 'user', content: `Вы только что нашли друг друга в поиске, диалог пуст. Напиши ОДНО короткое живое первое сообщение. Заход: ${angle}. Избегай шаблонов вроде «как твой день проходит», будь разнообразнее.` });
    } else {
      for (const m of history) messages.push(m);
      if (kind === 'voice') {
        messages.push({ role: 'user', content: '[собеседник прислал голосовое сообщение, но ты сейчас не можешь его послушать — неудобно/без звука]. Ответь коротко и по-человечески, мягко попроси написать текстом.' });
      }
    }

    // Лимит конкурентности: при массовом «пустом поиске» не запускаем N параллельных
    // вызовов OpenAI — ждём слот (до 10с), иначе деградируем в fallback-фразу.
    let waited = 0;
    while (this.aiInFlight >= AI_MAX_CONCURRENT && waited < 10000) { await sleep(200); waited += 200; }
    if (this.aiInFlight >= AI_MAX_CONCURRENT) return null;
    this.aiInFlight++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openai.apiKey}` },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: 160, temperature: 0.9, presence_penalty: 0.6, frequency_penalty: 0.3 }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = (json.choices?.[0]?.message?.content || '').trim();
      return text || null;
    } catch (error) {
      wsLogger.warn('ai_openai_failed', (error as Error).message, { chatId });
      return null;
    } finally {
      clearTimeout(timer);
      this.aiInFlight--;
    }
  }

  private async buildHistory(chatId: string, persona: Persona): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
    const msgs = await Message.find({ chatId: new mongoose.Types.ObjectId(chatId) })
      .sort({ timestamp: -1 }).limit(HISTORY_LIMIT).select('sender content type').lean();
    const personaId = this.personaIds.get(persona.tgId);
    const out: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const m of msgs.reverse()) {
      const t = (m as any).type;
      if (t && t !== 'voice') continue; // пропускаем icebreaker; voice отражаем как метку
      const isPersona = String((m as any).sender) === personaId;
      const content = t === 'voice' ? (isPersona ? '[голосовое]' : '[голосовое сообщение]') : String((m as any).content || '').slice(0, 400);
      if (!content) continue;
      out.push({ role: isPersona ? 'assistant' : 'user', content });
    }
    return out;
  }

  forgetChat(chatId: string): void {
    const pid = this.aiChatCache.get(chatId);
    if (pid) this.decPersona(pid);
    this.aiChatCache.delete(chatId);
    this.replyCount.delete(chatId);
    this.lastUserAt.delete(chatId);
    this.lastPersonaAt.delete(chatId);
    this.nudgeCount.delete(chatId);
    this.saidBye.delete(chatId);
    const t = this.pendingTimers.get(chatId); if (t) { clearTimeout(t); this.pendingTimers.delete(chatId); }
    this.clearIdle(chatId);
    this.inFlight.delete(chatId);
  }
}

export const AICompanionService = new AICompanionServiceImpl();
