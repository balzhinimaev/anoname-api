import { Request, Response } from 'express';
import dnsPromises from 'dns/promises';
import net from 'net';
import logger from '../utils/logger';

// Прокси картинок собеседника: сервер сам тянет изображение и отдаёт клиенту,
// чтобы просмотр НЕ раскрывал IP пользователя серверу картинок собеседника
// (деанонимизация в «анонимном» чате). Публичный, но захардненный:
// https-only, блок приватных адресов (SSRF), без редиректов, только image/*,
// лимит размера и таймаут. Абьюз ограничен rate-limit'ом на роуте.

const MAX_BYTES = 5 * 1024 * 1024; // 5 МБ
const FETCH_TIMEOUT_MS = 8000;

// Блокируем приватные/loopback/link-local/reserved адреса (защита от SSRF).
const isBlockedIp = (ip: string): boolean => {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;       // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                      // multicast/reserved
    return false;
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true; // link-local / ULA
  if (low.startsWith('::ffff:')) return isBlockedIp(low.slice('::ffff:'.length)); // IPv4-mapped
  return false;
};

export const proxyMedia = async (req: Request, res: Response): Promise<void> => {
  try {
    const url = String(req.query.url || '');
    if (url.length > 1024 || !/^https:\/\//i.test(url)) {
      res.status(400).json({ error: 'Invalid url' });
      return;
    }
    let parsed: URL;
    try { parsed = new URL(url); } catch { res.status(400).json({ error: 'Invalid url' }); return; }
    if (parsed.protocol !== 'https:') { res.status(400).json({ error: 'https only' }); return; }

    // SSRF: резолвим хост и запрещаем приватные адреса
    let addrs: Array<{ address: string }> = [];
    try { addrs = await dnsPromises.lookup(parsed.hostname, { all: true }); }
    catch { res.status(400).json({ error: 'DNS resolve failed' }); return; }
    if (addrs.length === 0 || addrs.some((a) => isBlockedIp(a.address))) {
      res.status(400).json({ error: 'Blocked host' });
      return;
    }

    // Фетчим без follow-редиректов (редирект мог бы увести на внутренний адрес)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'anoname-media-proxy' },
      });
    } finally {
      clearTimeout(timer);
    }

    if (upstream.status >= 300 && upstream.status < 400) { res.status(400).json({ error: 'Redirects not allowed' }); return; }
    if (!upstream.ok) { res.status(502).json({ error: 'Upstream error' }); return; }

    const ct = upstream.headers.get('content-type') || '';
    if (!/^image\//i.test(ct)) { res.status(415).json({ error: 'Not an image' }); return; }
    const declaredLen = Number(upstream.headers.get('content-length') || 0);
    if (declaredLen && declaredLen > MAX_BYTES) { res.status(413).json({ error: 'Too large' }); return; }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) { res.status(413).json({ error: 'Too large' }); return; }

    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buf);
  } catch (e) {
    logger.warn('media proxy error', { error: e instanceof Error ? e.message : String(e) });
    if (!res.headersSent) res.status(502).json({ error: 'Proxy failed' });
  }
};
