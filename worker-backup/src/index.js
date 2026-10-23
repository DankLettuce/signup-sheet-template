// Daily D1 snapshot for the sign-up page (cron only; no HTTP routes).
import { SNAPSHOT_SQL, PRUNE_SQL } from '../../lib/snapshot.js';

export default {
  async scheduled(event, env, ctx) {
    const today = new Date().toISOString().slice(0, 10);
    if (env.STOP_AFTER && today > env.STOP_AFTER) { console.log('snapshot: past STOP_AFTER, skipping'); return; }
    const [ins] = await env.DB.batch([env.DB.prepare(SNAPSHOT_SQL).bind('daily'), env.DB.prepare(PRUNE_SQL)]);
    console.log('snapshot: saved', JSON.stringify(ins.meta && { last_row_id: ins.meta.last_row_id }));
  },
  async fetch() { return new Response('Not found', { status: 404, headers: { 'X-Robots-Tag': 'noindex' } }); },
};
