import { Request, Response } from 'express';
import fs from 'fs';
import { VoiceService, VoiceError } from '../services/VoiceService';
import logger from '../utils/logger';

const isObjectId = (id: string) => /^[a-f\d]{24}$/i.test(id);
// UUID v4 или иной клиентский идентификатор до 64 символов (буквы/цифры/дефис)
const isClientId = (id: string) => /^[a-zA-Z0-9-]{8,64}$/.test(id);

/** POST /api/media/voice — загрузка голосового (multipart, поле file) */
export const uploadVoice = async (req: Request, res: Response): Promise<void> => {
  const tmpPath = (req as Request & { file?: { path: string } }).file?.path;
  // Любой выход до VoiceService.handleUpload обязан удалить tmp-файл multer'а,
  // иначе невалидные запросы (до 2МБ каждый) копятся в /tmp контейнера
  const dropTmp = () => {
    if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
  };
  try {
    const userId = req.user?.userId;
    if (!userId) {
      dropTmp();
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!tmpPath) {
      res.status(400).json({ error: 'No audio file' });
      return;
    }
    const chatId = String(req.body.chatId || '');
    const clientId = String(req.body.clientId || '');
    if (!isObjectId(chatId) || !isClientId(clientId)) {
      dropTmp();
      res.status(400).json({ error: 'Invalid chatId or clientId' });
      return;
    }
    const voiceChanged = String(req.body.voiceChanged) !== 'false'; // default true
    let waveform: number[] = [];
    try {
      const parsed = JSON.parse(String(req.body.waveform || '[]'));
      if (Array.isArray(parsed)) waveform = parsed;
    } catch { /* пустая волноформа допустима */ }

    const { message, created } = await VoiceService.handleUpload({
      tmpPath, userId, chatId, clientId, voiceChanged, waveform,
    });
    res.status(created ? 201 : 200).json({ message });
  } catch (error) {
    dropTmp();
    if (error instanceof VoiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logger.error('voice_upload_failed', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to upload voice message' });
  }
};

/** GET /api/media/voice/:messageId — отдача mp3 участнику чата (с Range) */
export const getVoice = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const messageId = String(req.params.messageId || '');
    if (!isObjectId(messageId)) {
      res.status(400).json({ error: 'Invalid messageId' });
      return;
    }
    const filePath = await VoiceService.resolveFileForUser(messageId, userId);
    const { size } = await fs.promises.stat(filePath);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = m && m[1] ? parseInt(m[1], 10) : 0;
      const end = m && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (!m || start > end || start >= size) {
        res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(size));
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error instanceof VoiceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logger.error('voice_get_failed', { error: (error as Error).message });
    res.status(500).json({ error: 'Failed to load voice message' });
  }
};
