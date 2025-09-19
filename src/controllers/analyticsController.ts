import { Request, Response } from 'express';
import AnalyticsEvent from '../models/AnalyticsEvent';
import Search from '../models/Search';

function parseDate(input?: string, fallbackDays = 7): Date {
  if (input) {
    const d = new Date(input);
    if (!isNaN(d.getTime())) return d;
  }
  const d = new Date();
  d.setDate(d.getDate() - fallbackDays);
  return d;
}

export const getSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const from = parseDate(String(req.query.from || ''));
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const namesParam = String(req.query.name || '');
    const names = namesParam ? namesParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

    const match: any = { createdAt: { $gte: from, $lte: to } };
    if (names && names.length > 0) {
      match.name = { $in: names };
    }

    const pipeline: any[] = [
      { $match: match },
      {
        $group: {
          _id: { name: '$name', cohort: '$cohort' },
          events: { $sum: 1 },
          users: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          _id: 0,
          name: '$_id.name',
          cohort: '$_id.cohort',
          events: 1,
          uniqueUsers: { $size: '$users' }
        }
      },
      { $sort: { name: 1, cohort: 1 } }
    ];

    const data = await AnalyticsEvent.aggregate(pipeline);
    res.json({ from, to, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get analytics summary' });
  }
};

export const getTimeseries = async (req: Request, res: Response): Promise<void> => {
  try {
    const from = parseDate(String(req.query.from || ''));
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const name = String(req.query.name || '');
    const groupByCohort = String(req.query.group || '') === 'cohort';
    const period = String(req.query.period || 'day'); // day|hour

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const dateFormat = period === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';

    const groupId: any = {
      ts: { $dateToString: { format: dateFormat, date: '$createdAt' } },
    };
    if (groupByCohort) groupId.cohort = '$cohort';

    const pipeline: any[] = [
      { $match: { name, createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: groupId, events: { $sum: 1 }, users: { $addToSet: '$userId' } } },
      { $project: { _id: 0, ts: '$_id.ts', cohort: '$_id.cohort', events: 1, uniqueUsers: { $size: '$users' } } },
      { $sort: { ts: 1, cohort: 1 } }
    ];

    const data = await AnalyticsEvent.aggregate(pipeline);
    res.json({ from, to, name, period, groupByCohort, data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get analytics timeseries' });
  }
};

export const getABConversion = async (req: Request, res: Response): Promise<void> => {
  try {
    const from = parseDate(String(req.query.from || ''));
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const baseEvent = String(req.query.base || 'tma_open');
    const goal = String(req.query.goal || 'search'); // 'search' = использовать коллекцию Search

    // База (tma_open): уникальные пользователи по когорте
    const baseAgg = await AnalyticsEvent.aggregate([
      { $match: { name: baseEvent, createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$cohort', users: { $addToSet: '$userId' } } },
      { $project: { _id: 0, cohort: '$_id', baseUsers: { $size: '$users' } } }
    ]);
    const baseMap: Record<string, number> = {};
    for (const row of baseAgg) baseMap[row.cohort || 'unknown'] = row.baseUsers;

    // Цель — по Search (уникальные userId с поиском) → маппим к когорте пользователя
    const searches = await Search.aggregate([
      { $match: { createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$userId' } },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'u'
        }
      },
      { $unwind: '$u' },
      { $project: { cohort: '$u.cohort' } },
      { $group: { _id: '$cohort', users: { $sum: 1 } } },
      { $project: { _id: 0, cohort: '$_id', goalUsers: '$users' } }
    ]);

    // Считаем конверсию по когорте
    const cohorts = new Set<string>([
      ...Object.keys(baseMap),
      ...searches.map((r: any) => r.cohort || 'unknown')
    ]);
    const result: any[] = [];
    for (const c of cohorts) {
      const base = baseMap[c] || 0;
      const goalRow = searches.find((r: any) => (r.cohort || 'unknown') === c);
      const goalUsers = goalRow ? goalRow.goalUsers : 0;
      const cr = base > 0 ? goalUsers / base : 0;
      result.push({ cohort: c || 'unknown', baseUsers: base, goalUsers, conversion: cr });
    }
    res.json({ from, to, baseEvent, goal, data: result.sort((a, b) => a.cohort.localeCompare(b.cohort)) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute A/B conversion' });
  }
};

export const getFunnel = async (req: Request, res: Response): Promise<void> => {
  try {
    const from = parseDate(String(req.query.from || ''));
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const cohort = String(req.query.cohort || ''); // опционально фильтровать по когорте
    const premiumParam = String(req.query.premium || ''); // 'true'|'false'|''
    const geoParam = String(req.query.geo || ''); // 'true'|'false'|''
    const steps = (req.body?.steps as string[]) || [];
    if (!Array.isArray(steps) || steps.length < 2) {
      res.status(400).json({ error: 'Provide steps: string[] with at least two event names' });
      return;
    }

    // helper для выборки первых событий по пользователю с фильтрами
    const getFirstEventsByUser = async (stepName: string): Promise<Map<string, Date>> => {
      const isMatched = stepName === 'matched';
      const baseMatch: any = {
        createdAt: { $gte: from, $lte: to },
        ...(isMatched ? { name: 'search_end', 'props.outcome': 'matched' } : { name: stepName })
      };
      if (cohort) baseMatch.cohort = cohort as any;
      if (geoParam === 'true') baseMatch['props.useGeolocation'] = true;
      if (geoParam === 'false') baseMatch['props.useGeolocation'] = false;
      const pipeline: any[] = [{ $match: baseMatch }];
      if (premiumParam === 'true' || premiumParam === 'false') {
        pipeline.push(
          {
            $lookup: {
              from: 'users',
              localField: 'userId',
              foreignField: '_id',
              as: 'u'
            }
          },
          { $unwind: '$u' },
          {
            $match: ((): any => {
              const wantPremium = premiumParam === 'true';
              const isPremiumExpr = {
                $and: [
                  { $eq: ['$u.subscription.isActive', true] },
                  { $ne: ['$u.subscription.type', 'basic'] }
                ]
              };
              return wantPremium ? { $expr: isPremiumExpr } : { $expr: { $not: isPremiumExpr } };
            })()
          }
        );
      }
      pipeline.push(
        { $group: { _id: '$userId', ts: { $min: '$createdAt' } } }
      );
      const rows = await AnalyticsEvent.aggregate(pipeline);
      const map = new Map<string, Date>();
      for (const r of rows) map.set(String(r._id), new Date(r.ts));
      return map;
    };

    // Загружаем уникальные пользователи по каждому шагу (по времени/когорте/фильтрам)
    const stepSets: Array<Set<string>> = [];
    const stepFirstTs: Map<string, Map<string, Date>> = new Map(); // step -> userId -> first ts
    for (const name of steps) {
      const tsMap = await getFirstEventsByUser(name);
      stepFirstTs.set(name, tsMap);
      stepSets.push(new Set(Array.from(tsMap.keys())));
    }

    // Считаем проход по воронке (пересечение множеств)
    const result: Array<{ step: string; users: number }> = [];
    let current = stepSets[0];
    result.push({ step: steps[0], users: current.size });
    for (let i = 1; i < stepSets.length; i++) {
      const next = stepSets[i];
      const intersect = new Set<string>();
      current.forEach((u) => { if (next.has(u)) intersect.add(u); });
      result.push({ step: steps[i], users: intersect.size });
      current = intersect;
    }

    // Времена прохождения: п50/п90 между последовательными шагами для пользователей, прошедших оба
    const timings: Array<{ from: string; to: string; p50Ms: number; p90Ms: number; avgMs: number }> = [];
    for (let i = 0; i < steps.length - 1; i++) {
      const a = steps[i];
      const b = steps[i + 1];
      const aTs = stepFirstTs.get(a) || new Map();
      const bTs = stepFirstTs.get(b) || new Map();
      const deltas: number[] = [];
      for (const [uid, tsA] of aTs.entries()) {
        const tsB = bTs.get(uid);
        if (tsB) {
          const ms = tsB.getTime() - tsA.getTime();
          if (ms >= 0 && Number.isFinite(ms)) deltas.push(ms);
        }
      }
      deltas.sort((x, y) => x - y);
      const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
      const p50 = deltas.length ? deltas[Math.floor(0.5 * (deltas.length - 1))] : 0;
      const p90 = deltas.length ? deltas[Math.floor(0.9 * (deltas.length - 1))] : 0;
      timings.push({ from: a, to: b, p50Ms: p50, p90Ms: p90, avgMs: Math.round(avg) });
    }

    res.json({ from, to, cohort: cohort || undefined, premium: premiumParam || undefined, geo: geoParam || undefined, steps, data: result, timings });
  } catch (error) {
    res.status(500).json({ error: 'Failed to compute funnel' });
  }
};

export const getTimingSeries = async (req: Request, res: Response): Promise<void> => {
  try {
    const from = parseDate(String(req.query.from || ''));
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const stepA = String(req.query.stepA || '');
    const stepB = String(req.query.stepB || '');
    const cohort = String(req.query.cohort || '');
    const premiumParam = String(req.query.premium || '');
    const geoParam = String(req.query.geo || '');
    const period = String(req.query.period || 'day'); // day|hour
    if (!stepA || !stepB) {
      res.status(400).json({ error: 'stepA and stepB are required' });
      return;
    }

    const bucketFormat = period === 'hour' ? '%Y-%m-%dT%H:00:00Z' : '%Y-%m-%d';

    // переиспользуем helper из getFunnel
    const getFirst = async (name: string) => {
      const isMatched = name === 'matched';
      const match: any = {
        createdAt: { $gte: from, $lte: to },
        ...(isMatched ? { name: 'search_end', 'props.outcome': 'matched' } : { name })
      };
      if (cohort) match.cohort = cohort as any;
      if (geoParam === 'true') match['props.useGeolocation'] = true;
      if (geoParam === 'false') match['props.useGeolocation'] = false;
      const pipeline: any[] = [{ $match: match }];
      if (premiumParam === 'true' || premiumParam === 'false') {
        pipeline.push(
          { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'u' } },
          { $unwind: '$u' },
          {
            $match: ((): any => {
              const wantPremium = premiumParam === 'true';
              const isPremiumExpr = {
                $and: [
                  { $eq: ['$u.subscription.isActive', true] },
                  { $ne: ['$u.subscription.type', 'basic'] }
                ]
              };
              return wantPremium ? { $expr: isPremiumExpr } : { $expr: { $not: isPremiumExpr } };
            })()
          }
        );
      }
      pipeline.push({ $project: { userId: 1, createdAt: 1, bucket: { $dateToString: { format: bucketFormat, date: '$createdAt' } } } });
      const docs = await AnalyticsEvent.aggregate(pipeline);
      // earliest A per user per bucket
      const perBucket: Map<string, Map<string, Date>> = new Map();
      for (const d of docs as any[]) {
        const b = d.bucket as string;
        const u = String(d.userId);
        const ts = new Date(d.createdAt);
        if (!perBucket.has(b)) perBucket.set(b, new Map());
        const m = perBucket.get(b) as Map<string, Date>;
        if (!m.has(u) || ts < (m.get(u) as Date)) m.set(u, ts);
      }
      return perBucket;
    };

    const aBuckets = await getFirst(stepA);
    const bBuckets = await getFirst(stepB);

    // для каждого бакета считаем дельты A→B по пересечению юзеров
    const allBuckets = new Set<string>([...aBuckets.keys(), ...bBuckets.keys()]);
    const series: Array<{ bucket: string; count: number; p50Ms: number; p90Ms: number; avgMs: number }> = [];
    for (const bucket of Array.from(allBuckets).sort()) {
      const aMap = aBuckets.get(bucket) || new Map();
      const bMap = bBuckets.get(bucket) || new Map();
      const deltas: number[] = [];
      for (const [uid, tsA] of aMap.entries()) {
        const tsB = bMap.get(uid);
        if (tsB) {
          const ms = tsB.getTime() - tsA.getTime();
          if (ms >= 0 && Number.isFinite(ms)) deltas.push(ms);
        }
      }
      deltas.sort((x, y) => x - y);
      const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
      const p50 = deltas.length ? deltas[Math.floor(0.5 * (deltas.length - 1))] : 0;
      const p90 = deltas.length ? deltas[Math.floor(0.9 * (deltas.length - 1))] : 0;
      series.push({ bucket, count: deltas.length, p50Ms: p50, p90Ms: p90, avgMs: Math.round(avg) });
    }

    res.json({ from, to, stepA, stepB, period, cohort: cohort || undefined, premium: premiumParam || undefined, geo: geoParam || undefined, data: series });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get timing series' });
  }
};


