// /api/rooms.js
// A small directory of open rooms so "Join Random Room" has something to pick
// from - pure P2P has no way to discover a room you don't already have the code
// for, so this is a minimal Redis-backed lobby list. Entries expire on their own
// (ROOM_TTL_SECONDS) so a host that crashed without unregistering doesn't leave a
// permanently-listed dead room; the host is expected to send a heartbeat roughly
// every 30-45s while the room is open.

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ROOM_TTL_SECONDS = 90;

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
    if (action === 'register' || action === 'heartbeat') {
      const { code, hostClientId, maxPlayers, count } = body;
      if (!code || !hostClientId || !maxPlayers) {
        return res.status(400).json({ error: 'Missing code, hostClientId, or maxPlayers' });
      }
      await redis.set(`room:${code}`, {
        hostClientId,
        maxPlayers: Math.max(2, Math.min(16, Number(maxPlayers) || 2)),
        count: Math.max(1, Number(count) || 1),
        updatedAt: Date.now()
      }, { ex: ROOM_TTL_SECONDS });
      return res.status(200).json({ ok: true });
    }

    if (action === 'unregister') {
      const { code } = body;
      if (!code) return res.status(400).json({ error: 'Missing code' });
      await redis.del(`room:${code}`);
      return res.status(200).json({ ok: true });
    }

    if (action === 'random') {
      const keys = await redis.keys('room:*');
      if (!keys || keys.length === 0) {
        return res.status(200).json({ code: null });
      }
      const records = await Promise.all(keys.map(async (key) => {
        const val = await redis.get(key);
        return val ? { code: key.slice('room:'.length), ...val } : null;
      }));
      const open = records.filter(r => r && r.count < r.maxPlayers);
      if (open.length === 0) {
        return res.status(200).json({ code: null });
      }
      const pick = open[Math.floor(Math.random() * open.length)];
      return res.status(200).json({ code: pick.code });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('rooms.js error:', err);
    return res.status(500).json({ error: 'Room service unavailable' });
  }
}
