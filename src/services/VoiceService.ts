import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import Chat from '../models/Chat';
import Message, { IMessage } from '../models/Message';
import User from '../models/User';
import Report from '../models/Report';
import { BlockService } from './BlockService';
import { wsManager } from '../server';
import config from '../config';
import { wsLogger } from '../utils/logger';

/**
 * Голосовые сообщения: транскод/анонимизация через ffmpeg, хранение на volume,
 * доставка обычным пайплайном chat:message (type='voice').
 *
 * Приватность: оригинал записи НЕ сохраняется (транскод → сразу unlink),
 * метаданные записи отрезаются перекодированием, файлы чата удаляются
 * по расписанию после завершения чата (см. sweep).
 */

const FFMPEG_TIMEOUT_MS = 20_000;
const FFMPEG_MAX_CONCURRENT = 2;
const MAX_WAVEFORM_POINTS = 64;
// Pitch-shift ≈ +3 полутона (2^(3/12) ≈ 1.19) с сохранением темпа.
// Фиксированно ВВЕРХ у всех: одинаково анонимно, без «демона» на низких голосах.
const PITCH_RATIO = 1.19;
// Сроки жизни файлов после завершения чата
const GRACE_AFTER_END_MS = 24 * 3600 * 1000;      // без жалоб
const REPORTED_RETENTION_MS = 30 * 24 * 3600 * 1000; // при жалобе / безусловный максимум
const SWEEP_INTERVAL_MS = 3600 * 1000;

export class VoiceError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

class VoiceServiceImpl {
  // Простой семафор на параллельные ffmpeg-процессы
  private ffmpegActive = 0;
  private ffmpegQueue: Array<() => void> = [];
  // Анти-флуд: последняя отправка голосового по userId
  private lastVoiceAt = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;

  private get voiceRoot(): string {
    return path.join(config.voice.mediaDir, 'voice');
  }

  filePathFor(chatId: string, messageId: string): string {
    return path.join(this.voiceRoot, chatId, `${messageId}.mp3`);
  }

  /**
   * Полный цикл загрузки голосового: проверки → идемпотентность → ffmpeg →
   * Message → emit. tmpPath — файл из multer; удаляется здесь в любом случае.
   */
  async handleUpload(params: {
    tmpPath: string;
    userId: string;
    chatId: string;
    clientId: string;
    voiceChanged: boolean;
    waveform: number[];
  }): Promise<{ message: IMessage; created: boolean }> {
    const { tmpPath, userId, chatId, clientId, voiceChanged } = params;
    try {
      const chat = await Chat.findById(chatId).select('participants isActive');
      if (!chat) throw new VoiceError(404, 'Chat not found');
      if (!chat.isActive) throw new VoiceError(409, 'Chat is not active');
      if (!chat.participants.some((p) => p.toString() === userId)) {
        throw new VoiceError(403, 'Not a participant of this chat');
      }
      const otherUserId = chat.participants.map((p) => p.toString()).find((p) => p !== userId);
      if (otherUserId && (await BlockService.anyBlockBetween(userId, otherUserId))) {
        throw new VoiceError(403, 'Messaging blocked by user settings');
      }
      // Приватность получателя: запрет на приём голосовых (кнопка у отправителя
      // скрыта по acceptsVoice из матча, но сервер — источник истины)
      if (otherUserId) {
        const recipient = await User.findById(otherUserId).select('preferences.acceptVoice').lean();
        if ((recipient as { preferences?: { acceptVoice?: boolean } } | null)?.preferences?.acceptVoice === false) {
          throw new VoiceError(403, 'Собеседник отключил приём голосовых сообщений');
        }
      }

      // Идемпотентность: повтор с тем же clientId возвращает уже созданное сообщение
      const existing = await Message.findOne({ chatId, 'media.clientId': clientId })
        .populate({ path: 'sender', select: 'telegramId firstName photos profilePhoto' });
      if (existing) return { message: existing, created: false };

      // Анти-флуд. Метку времени ставим ПОСЛЕ успешного создания сообщения —
      // неудачный транскод (415) не должен сжигать кулдаун ретрая
      const now = Date.now();
      const last = this.lastVoiceAt.get(userId) || 0;
      if (now - last < config.voice.minIntervalMs) {
        throw new VoiceError(429, 'Too many voice messages, slow down');
      }
      const countInChat = await Message.countDocuments({ chatId, type: 'voice' });
      if (countInChat >= config.voice.maxPerChat) {
        throw new VoiceError(429, 'Voice message limit for this chat reached');
      }

      // Транскод (и одновременно санитайзер формата)
      const messageId = new mongoose.Types.ObjectId();
      const outPath = this.filePathFor(chatId, messageId.toString());
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      try {
        await this.transcode(tmpPath, outPath, voiceChanged);
      } catch (e) {
        await fs.unlink(outPath).catch(() => {});
        wsLogger.warn('voice_transcode_failed', (e as Error).message, { chatId, userId });
        throw new VoiceError(415, 'Could not decode audio');
      }

      const duration = await this.probeDuration(outPath);
      if (!duration || duration < 0.5) {
        await fs.unlink(outPath).catch(() => {});
        throw new VoiceError(400, 'Recording too short');
      }
      if (duration > config.voice.maxDurationSec + 1) {
        await fs.unlink(outPath).catch(() => {});
        throw new VoiceError(400, 'Recording too long');
      }
      const { size } = await fs.stat(outPath);

      let message: IMessage;
      try {
        message = await Message.create({
          _id: messageId,
          chatId: new mongoose.Types.ObjectId(chatId),
          sender: new mongoose.Types.ObjectId(userId),
          content: '🎤 Голосовое',
          type: 'voice',
          media: {
            kind: 'voice',
            duration: Math.round(duration * 10) / 10,
            size,
            waveform: this.sanitizeWaveform(params.waveform),
            clientId,
          },
        });
      } catch (e) {
        // Гонка двух ретраев с одним clientId: уникальный индекс — источник истины
        if ((e as { code?: number })?.code === 11000) {
          await fs.unlink(outPath).catch(() => {});
          const winner = await Message.findOne({ chatId, 'media.clientId': clientId })
            .populate({ path: 'sender', select: 'telegramId firstName photos profilePhoto' });
          if (winner) return { message: winner, created: false };
        }
        await fs.unlink(outPath).catch(() => {});
        throw e;
      }

      this.lastVoiceAt.set(userId, Date.now());
      await Chat.updateOne({ _id: chatId }, { $set: { lastMessage: message._id } });

      const populated = await message.populate({
        path: 'sender',
        select: 'telegramId firstName photos profilePhoto',
      });

      wsManager.io.to(`chat:${chatId}`).emit('chat:message', { chatId, message: populated });
      // Голосовое — живое сообщение: перезапускает таймер тишины Купидона
      wsManager.noteChatMessage(chatId, userId);
      wsLogger.info('voice_sent', `Voice message ${messageId} in chat ${chatId}`, {
        chatId, userId, duration, size, voiceChanged,
      });
      return { message: populated, created: true };
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }

  /** Проверка доступа к файлу голосового: участник чата этого сообщения */
  async resolveFileForUser(messageId: string, userId: string): Promise<string> {
    const message = await Message.findById(messageId).select('chatId type');
    if (!message || message.type !== 'voice') throw new VoiceError(404, 'Not found');
    const chat = await Chat.findById(message.chatId).select('participants');
    if (!chat || !chat.participants.some((p) => p.toString() === userId)) {
      throw new VoiceError(403, 'Forbidden');
    }
    const filePath = this.filePathFor(String(message.chatId), messageId);
    try {
      await fs.access(filePath);
    } catch {
      throw new VoiceError(404, 'File expired or not found');
    }
    return filePath;
  }

  private sanitizeWaveform(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .slice(0, MAX_WAVEFORM_POINTS)
      .map((v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        return Math.round(Math.min(1, Math.max(0, n)) * 100) / 100;
      });
  }

  private acquireFfmpegSlot(): Promise<void> {
    if (this.ffmpegActive < FFMPEG_MAX_CONCURRENT) {
      this.ffmpegActive++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.ffmpegQueue.push(() => {
        this.ffmpegActive++;
        resolve();
      });
    });
  }

  private releaseFfmpegSlot(): void {
    this.ffmpegActive--;
    const next = this.ffmpegQueue.shift();
    if (next) next();
  }

  private runProcess(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} timeout`));
      }, timeoutMs);
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d; });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`));
      });
    });
  }

  private async transcode(inPath: string, outPath: string, voiceChanged: boolean): Promise<void> {
    await this.acquireFfmpegSlot();
    try {
      // Конвейер очистки речи (порядок важен):
      //  1. highpass 80Гц — гул/рокот/тряска телефона (ниже речи ценного нет)
      //  2. lowpass 12кГц — шипение выше речевого диапазона
      //  3. afftdn — мягкий FFT-шумодав по стационарному фону (кондиционер, улица)
      //  4. (опция) pitch-shift анонимизации
      //  5. обрезка тишины в начале И в конце (хвост — через areverse)
      //  6. loudnorm — выравнивание громкости (EBU R128) ПОСЛЕ чистки и обрезки
      const filters: string[] = [
        'highpass=f=80',
        'lowpass=f=12000',
        'afftdn=nr=10:nf=-28',
      ];
      if (voiceChanged) {
        // asetrate поднимает и питч, и темп; atempo компенсирует темп обратно
        filters.push(`asetrate=44100*${PITCH_RATIO}`, 'aresample=44100', `atempo=${(1 / PITCH_RATIO).toFixed(4)}`);
      }
      const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.15';
      filters.push(trim);                       // тишина в начале (палец шёл к кнопке)
      filters.push('areverse', trim, 'areverse'); // тишина в конце (палец шёл к «стоп»)
      filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
      await this.runProcess('ffmpeg', [
        '-hide_banner', '-y',
        '-i', inPath,
        '-vn', '-sn', '-dn',           // только аудио (и санитайзер контейнера)
        '-t', String(config.voice.maxDurationSec + 2), // жёсткая отсечка по длине
        '-af', filters.join(','),
        '-ac', '1', '-ar', '44100',
        '-codec:a', 'libmp3lame', '-b:a', '64k',
        '-map_metadata', '-1',         // никаких метаданных записи
        outPath,
      ], FFMPEG_TIMEOUT_MS);
    } finally {
      this.releaseFfmpegSlot();
    }
  }

  private async probeDuration(filePath: string): Promise<number> {
    await this.acquireFfmpegSlot();
    try {
      return await this.probeDurationUnlocked(filePath);
    } finally {
      this.releaseFfmpegSlot();
    }
  }

  private async probeDurationUnlocked(filePath: string): Promise<number> {
    const out = await this.runProcess('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ], 10_000);
    const n = Number(out.trim());
    return Number.isFinite(n) ? n : 0;
  }

  // ===== Жизненный цикл файлов =====

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((e) => wsLogger.error('voice_sweep', 'system', e as Error));
    }, SWEEP_INTERVAL_MS);
    // Не держим процесс живым ради sweep
    this.sweepTimer.unref?.();
  }

  /**
   * Правила удаления каталога чата:
   *  - чата нет в БД → удалить;
   *  - чат завершён >24ч назад и нет жалоб по чату → удалить;
   *  - чат завершён >30 дней назад → удалить безусловно.
   * Активные чаты не трогаем.
   */
  async sweep(): Promise<void> {
    // Заодно чистим карту анти-флуда: записи старше часа бесполезны
    const staleBefore = Date.now() - 3600_000;
    for (const [uid, ts] of this.lastVoiceAt) {
      if (ts < staleBefore) this.lastVoiceAt.delete(uid);
    }
    let dirs: string[] = [];
    try {
      dirs = await fs.readdir(this.voiceRoot);
    } catch {
      return; // каталога ещё нет — нечего чистить
    }
    const now = Date.now();
    for (const dir of dirs) {
      if (!/^[a-f\d]{24}$/i.test(dir)) continue;
      try {
        const chat = await Chat.findById(dir).select('isActive endedAt');
        let remove = false;
        if (!chat) {
          remove = true;
        } else if (!chat.isActive) {
          const endedAt = chat.endedAt ? new Date(chat.endedAt).getTime() : 0;
          const age = now - endedAt;
          if (age > REPORTED_RETENTION_MS) {
            remove = true;
          } else if (age > GRACE_AFTER_END_MS) {
            const hasReport = await Report.exists({ chatId: new mongoose.Types.ObjectId(dir) });
            remove = !hasReport;
          }
        }
        if (remove) {
          await fs.rm(path.join(this.voiceRoot, dir), { recursive: true, force: true });
          wsLogger.info('voice_dir_removed', `Removed voice files for chat ${dir}`, { chatId: dir });
        }
      } catch (e) {
        wsLogger.warn('voice_sweep_dir', (e as Error).message, { chatId: dir });
      }
    }
  }
}

export const VoiceService = new VoiceServiceImpl();
