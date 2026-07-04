import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GameManager, OutEvent, TARGET_SCORE, ROUND_SECONDS } from '../src/services/GameService';

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

  it('повторное приглашение во время активной игры игнорируется (не сбрасывает игру)', () => {
    const { gm } = startGame();
    expect(gm.invite(CHAT, A, 'draw-guess', PLAYERS)).toEqual([]);
    // игра всё ещё активна — событие рисующего обрабатывается
    expect(gm.event(CHAT, A, 'draw', { x0: 0, y0: 0, x1: 1, y1: 1 })).toHaveLength(1);
  });
});

describe('конец игры (победа до TARGET_SCORE)', () => {
  /** Играет верными догадками до конца игры (очки чередуются из-за смены ролей). */
  function playToWin(gm: GameManager, firstWord: string): OutEvent[] {
    let word = firstWord;
    let guesser = B; // A стартует рисующим
    let out: OutEvent[] = [];
    for (let i = 0; i < TARGET_SCORE * 2; i++) {
      out = gm.event(CHAT, guesser, 'guess', { text: word });
      if (out.some((e) => e.event === 'game:end')) return out;
      const drawerStart = out.find((e) => e.event === 'game:start' && (e.data as any).word) as any;
      word = drawerStart.data.word;
      guesser = drawerStart.toUserId === A ? B : A;
    }
    throw new Error('игра не завершилась за ожидаемое число раундов');
  }

  it('game:start содержит roundSeconds и targetScore', () => {
    const gm = new GameManager();
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    const out = gm.respond(CHAT, B, true);
    const start = out.find((e) => e.event === 'game:start')!.data as any;
    expect(start.roundSeconds).toBe(ROUND_SECONDS);
    expect(start.targetScore).toBe(TARGET_SCORE);
  });

  it('набор TARGET_SCORE очков → correct + персонализированный game:end, сессия закрыта', () => {
    const { gm, word } = startGame();
    const out = playToWin(gm, word);

    // последний ответ: correct обоим + game:end обоим, БЕЗ нового game:start
    expect(out.some((e) => (e.data as any).type === 'correct')).toBe(true);
    expect(out.some((e) => e.event === 'game:start')).toBe(false);
    const ends = out.filter((e) => e.event === 'game:end');
    expect(ends).toHaveLength(2);
    const winnerEnd = ends.find((e) => (e.data as any).youWon)!.data as any;
    const loserEnd = ends.find((e) => !(e.data as any).youWon)!.data as any;
    expect(winnerEnd.reason).toBe('finished');
    expect(winnerEnd.myScore).toBe(TARGET_SCORE);
    expect(loserEnd.opponentScore).toBe(TARGET_SCORE);

    // сессия удалена — события игнорируются, можно пригласить заново
    expect(gm.event(CHAT, A, 'draw', {})).toEqual([]);
    expect(gm.invite(CHAT, A, 'draw-guess', PLAYERS)).toHaveLength(1);
  });
});

describe('таймер раунда', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  function startTimedGame(roundMs = 5000) {
    const gm = new GameManager(roundMs);
    const dispatched: OutEvent[][] = [];
    gm.setDispatcher((evts) => dispatched.push(evts));
    gm.invite(CHAT, A, 'draw-guess', PLAYERS);
    const out = gm.respond(CHAT, B, true);
    const word = (out.find((e) => e.toUserId === A && e.event === 'game:start')!.data as any).word as string;
    return { gm, dispatched, word };
  }

  it('по истечении раунда: timeout со словом обоим + новый раунд со сменой ролей, очков никому', () => {
    const { gm, dispatched, word } = startTimedGame();
    void gm;
    jest.advanceTimersByTime(5000);

    expect(dispatched).toHaveLength(1);
    const out = dispatched[0];
    const timeouts = out.filter((e) => (e.data as any).type === 'timeout');
    expect(timeouts.map((e) => e.toUserId).sort()).toEqual([A, B]);
    expect((timeouts[0].data as any).payload.word).toBe(word);

    const starts = out.filter((e) => e.event === 'game:start');
    expect(starts).toHaveLength(2);
    const bStart = starts.find((e) => e.toUserId === B)!.data as any;
    expect(bStart.role).toBe('drawer'); // роли поменялись
    expect(bStart.myScore).toBe(0);
    expect(bStart.round).toBe(2);
  });

  it('верная догадка перезапускает таймер (старый не срабатывает)', () => {
    const { gm, dispatched, word } = startTimedGame();
    jest.advanceTimersByTime(4000);
    gm.event(CHAT, B, 'guess', { text: word }); // раунд закончился догадкой
    jest.advanceTimersByTime(1500); // старый дедлайн прошёл, новый (5s) ещё нет
    expect(dispatched).toHaveLength(0);
    jest.advanceTimersByTime(3500); // истёк уже новый раунд
    expect(dispatched).toHaveLength(1);
  });

  it('после leave таймер не срабатывает', () => {
    const { gm, dispatched } = startTimedGame();
    gm.leave(CHAT, A);
    jest.advanceTimersByTime(60000);
    expect(dispatched).toHaveLength(0);
  });

  it('после победы таймер не срабатывает', () => {
    const { gm, dispatched, word } = startTimedGame();
    let w = word;
    let guesser = B;
    for (let i = 0; i < TARGET_SCORE * 2; i++) {
      const out = gm.event(CHAT, guesser, 'guess', { text: w });
      if (out.some((e) => e.event === 'game:end')) break;
      const drawerStart = out.find((e) => e.event === 'game:start' && (e.data as any).word) as any;
      w = drawerStart.data.word;
      guesser = drawerStart.toUserId === A ? B : A;
    }
    jest.advanceTimersByTime(60000);
    expect(dispatched).toHaveLength(0);
  });
});
