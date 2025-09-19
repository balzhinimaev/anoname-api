import { Request, Response, NextFunction } from 'express';

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function basicAuth(expectedUser: string, expectedPassword: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
      return res.status(401).send('Authentication required');
    }

    const base64 = header.slice('Basic '.length);
    let decoded = '';
    try {
      decoded = Buffer.from(base64, 'base64').toString('utf8');
    } catch {
      res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
      return res.status(401).send('Invalid authorization header');
    }

    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : '';
    const password = idx >= 0 ? decoded.slice(idx + 1) : '';

    const okUser = safeEqual(user, expectedUser);
    const okPass = safeEqual(password, expectedPassword);

    if (!okUser || !okPass) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Restricted"');
      return res.status(401).send('Invalid credentials');
    }

    return next();
  };
}


