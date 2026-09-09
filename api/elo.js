// /api/elo.js
// Stores each browser's chess rating under elo:<clientId> in Redis, keyed by the
// same stable clientId used for name reservation (see /api/name.js).
//
// Honest limitation: this endpoint trusts whichever client calls it to report an
// accurate result. The chess room's HOST is the one who calls it (the host runs
// the authoritative copy of the chess rules engine and validates every move), so
// a normal player can't just call this directly to hand themselves a win - but a
// player who modifies their own client code and chooses to host could, in theory,
// report a fake result. There's no way to fully close that without a real
// always-on server refereeing every game, which is out of scope here. For a
// private game with friends this is a reasonable, clearly-stated trade-off.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const DEFAULT_ELO = 1200;
const K_FACTOR = 32;

function titleForElo(elo) {
  if (elo >= 2100) return 'GM';
  if (elo >= 1500) return 'M';
  return null;
}

async function getRecord(clientId) {
  const record = await redis.get(`elo:${clientId}`);
  return record || { elo: DEFAULT_ELO, wins: 0, losses: 0, draws: 0 };
}

function expectedScore(ratingSelf, ratingOpponent) {
  return 1 / (1 + Math.pow(10, (ratingOpponent - ratingSelf) / 400));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { action } = body || {};

  try {
    if (action === 'get') {
      const { clientId } = body;
      if (!clientId) return res.status(400).json({ error: 'Missing clientId' });
      const record = await getRecord(clientId);
      return res.status(200).json({ elo: record.elo, title: titleForElo(record.elo) });
    }

    if (action === 'report') {
      // result: 'a' (a wins), 'b' (b wins), or 'draw'. Uses pre-game ratings for
      // BOTH calculations so the order of computation can't skew the result.
      const { aClientId, bClientId, result } = body;
      if (!aClientId || !bClientId || !result) {
        return res.status(400).json({ error: 'Missing aClientId, bClientId, or result' });
      }
      if (aClientId === bClientId) {
        return res.status(400).json({ error: 'aClientId and bClientId must differ' });
      }

      const [recA, recB] = await Promise.all([getRecord(aClientId), getRecord(bClientId)]);
      const expA = expectedScore(recA.elo, recB.elo);
      const expB = expectedScore(recB.elo, recA.elo);

      let scoreA;
      if (result === 'a') scoreA = 1;
      else if (result === 'b') scoreA = 0;
      else if (result === 'draw') scoreA = 0.5;
      else return res.status(400).json({ error: "result must be 'a', 'b', or 'draw'" });
      const scoreB = 1 - scoreA;

      const newEloA = Math.round(recA.elo + K_FACTOR * (scoreA - expA));
      const newEloB = Math.round(recB.elo + K_FACTOR * (scoreB - expB));

      const updatedA = {
        elo: newEloA,
        wins: recA.wins + (scoreA === 1 ? 1 : 0),
        losses: recA.losses + (scoreA === 0 ? 1 : 0),
        draws: recA.draws + (scoreA === 0.5 ? 1 : 0)
      };
      const updatedB = {
        elo: newEloB,
        wins: recB.wins + (scoreB === 1 ? 1 : 0),
        losses: recB.losses + (scoreB === 0 ? 1 : 0),
        draws: recB.draws + (scoreB === 0.5 ? 1 : 0)
      };

      await Promise.all([
        redis.set(`elo:${aClientId}`, updatedA),
        redis.set(`elo:${bClientId}`, updatedB)
      ]);

      return res.status(200).json({
        a: { elo: newEloA, delta: newEloA - recA.elo, title: titleForElo(newEloA) },
        b: { elo: newEloB, delta: newEloB - recB.elo, title: titleForElo(newEloB) }
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('elo.js error:', err);
    return res.status(500).json({ error: 'Elo service unavailable' });
  }
}
