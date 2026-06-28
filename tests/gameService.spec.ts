import { describe, expect, it } from '@jest/globals';
import { GameManager } from '../src/services/GameService';

const CHAT = 'c1';
const A = 'userA';
const B = 'userB';
const PLAYERS: [string, string] = [A, B];

/** Заводит активную игру (A — стартующий/рисующий) и возвращает менеджер + слово рисующего. */
function startGame(): { gm: GameManager; word: string } {
  const gm = new GameManager();
  gm.invite(CHAT, A, 'draw-guess', PLAYERS);
  const out = gm.respond(CHAT, B, true);
  const startA = out.find((e) => e.toUserId === A && e.event === 'game:start') as any;
  return { gm, word: startA.data.word as string };
}

describe('GameManager.catalog', () => {
  it('содержит игру «Угадай рисунок»', () => {
    expect(GameManager.catalog()).toEqual(expect.arrayContaining([{ id: 'draw-guess', title: 'Угадай рисунок' }]));
  });
});

describe('invite / respond', () => {
  it('invite шлёт приглашение ТОЛЬКО сопернику', () => {
    const gm = new GameManager();
    const out = gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ toUserId: B, event: 'game:invite' });
    expect((out[0].data as any).by).toBe(A);
  });

  it('invite на несуществующую игру — ничего', () => {
    const gm = new GameManager();
    expect(gm.invite(CHAT, A, 'no-such', PLAYERS)).toEqual([]);
  });

  it('accept → game:start обоим: рисующий со словом, угадывающий без; счёт 0:0', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    const out = gm.respond(CHAT, B, true);
    const starts = out.filter((e) => e.event === 'game:start');
    expect(starts).toHaveLength(2);
    const a = starts.find((e) => e.toUserId === A)!.data as any;
    const b = starts.find((e) => e.toUserId === B)!.data as any;
    expect(a.role).toBe('drawer');
    expect(typeof a.word).toBe('string');
    expect(a.word.length).toBeGreaterThan(0);
    expect(b.role).toBe('guesser');
    expect(b.word).toBeUndefined();
    expect(a.myScore).toBe(0);
    expect(a.opponentScore).toBe(0);
    expect(a.round).toBe(1);
  });

  it('decline → game:end обоим, игра не активна', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    const out = gm.respond(CHAT, B, false);
    expect(out.every((e) => e.event === 'game:end')).toBe(true);
    expect(out.map((e) => e.toUserId).sort()).toEqual([A, B]);
    // после decline события игры игнорируются
    expect(gm.event(CHAT, A, 'draw', {})).toEqual([]);
  });

  it('пригласивший не может сам принять приглашение', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    expect(gm.respond(CHAT, A, true)).toEqual([]);
  });
});

describe('рисование (draw/clear)', () => {
  it('draw от рисующего → ретранслируется ТОЛЬКО угадывающему', () => {
    const { gm } = startGame();
    const out = gm.event(CHAT, A, 'draw', { x0: 0, y0: 0, x1: 1, y1: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ toUserId: B, event: 'game:event' });
    expect((out[0].data as any).type).toBe('draw');
  });

  it('draw от угадывающего игнорируется (рисует только drawer)', () => {
    const { gm } = startGame();
    expect(gm.event(CHAT, B, 'draw', { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual([]);
  });

  it('clear от рисующего → угадывающему', () => {
    const { gm } = startGame();
    const out = gm.event(CHAT, A, 'clear', {});
    expect(out).toHaveLength(1);
    expect((out[0].data as any).type).toBe('clear');
  });
});

describe('угадывание (guess)', () => {
  it('неверная догадка → показывается ТОЛЬКО рисующему', () => {
    const { gm } = startGame();
    const out = gm.event(CHAT, B, 'guess', { text: '___заведомо неверно___' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ toUserId: A, event: 'game:event' });
    expect((out[0].data as any).type).toBe('guess');
  });

  it('верная догадка → correct обоим + новый раунд: роли меняются, счёт угадавшему', () => {
    const { gm, word } = startGame();
    const out = gm.event(CHAT, B, 'guess', { text: word });

    const correct = out.filter((e) => (e.data as any).type === 'correct');
    expect(correct.map((e) => e.toUserId).sort()).toEqual([A, B]);
    expect((correct[0].data as any).payload.word).toBe(word);

    const starts = out.filter((e) => e.event === 'game:start');
    expect(starts).toHaveLength(2);
    const bStart = starts.find((e) => e.toUserId === B)!.data as any;
    const aStart = starts.find((e) => e.toUserId === A)!.data as any;
    // Угадавший (B) теперь рисующий, A — угадывающий
    expect(bStart.role).toBe('drawer');
    expect(aStart.role).toBe('guesser');
    // Счёт: у B 1, у A 0; раунд 2
    expect(bStart.myScore).toBe(1);
    expect(aStart.myScore).toBe(0);
    expect(bStart.round).toBe(2);
  });

  it('верная догадка нечувствительна к регистру/ё и пробелам', () => {
    const { gm, word } = startGame();
    const messy = ` ${word.toUpperCase().replace(/е/gi, 'Ё')} `;
    const out = gm.event(CHAT, B, 'guess', { text: messy });
    expect(out.some((e) => (e.data as any).type === 'correct')).toBe(true);
  });

  it('рисующий не может «угадать» своё слово', () => {
    const { gm, word } = startGame();
    expect(gm.event(CHAT, A, 'guess', { text: word })).toEqual([]);
  });
});

describe('skip и leave', () => {
  it('skip рисующим → новое слово (другое), событие skipped обоим', () => {
    const { gm, word } = startGame();
    const out = gm.event(CHAT, A, 'skip', {});
    expect(out.some((e) => (e.data as any).type === 'skipped')).toBe(true);
    const newStart = out.find((e) => e.toUserId === A && e.event === 'game:start')!.data as any;
    expect(newStart.role).toBe('drawer'); // роли НЕ меняются при skip
    expect(newStart.word).not.toBe(word);
  });

  it('leave → game:end обоим, дальнейшие события игнорируются', () => {
    const { gm } = startGame();
    const out = gm.leave(CHAT, A);
    expect(out.every((e) => e.event === 'game:end')).toBe(true);
    expect(gm.event(CHAT, A, 'draw', {})).toEqual([]);
  });
});

describe('авторизация участников', () => {
  it('событие от постороннего (не игрока) игнорируется', () => {
    const { gm } = startGame();
    expect(gm.event(CHAT, 'intruder', 'draw', { x0: 0, y0: 0, x1: 1, y1: 1 })).toEqual([]);
    expect(gm.event(CHAT, 'intruder', 'guess', { text: 'кот' })).toEqual([]);
  });

  it('события без активной игры — пусто', () => {
    const gm = new GameManager();
    expect(gm.event('nope', A, 'draw', {})).toEqual([]);
  });
});
