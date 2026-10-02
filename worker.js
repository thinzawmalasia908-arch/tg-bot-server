export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return cors('', 204);

    try {
      if (path === '/api/bots' && method === 'POST') return await registerBot(request, env);
      if (path === '/api/bots' && method === 'GET') return await listBots(url, env);

      const toggleM = path.match(/^\/api\/bots\/([^\/]+)\/toggle$/);
      if (toggleM && method === 'POST') return await toggleBot(toggleM[1], request, env);

      const delM = path.match(/^\/api\/bots\/([^\/]+)$/);
      if (delM && method === 'DELETE') return await deleteBot(delM[1], request, env);

      const whM = path.match(/^\/webhook\/([^\/]+)$/);
      if (whM && method === 'POST') return await handleWebhook(whM[1], request, env);

      return cors(JSON.stringify({ error: 'Not found' }), 404);
    } catch (e) {
      return cors(JSON.stringify({ error: e.message }), 500);
    }
  }
};

function cors(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

async function registerBot(request, env) {
  const body = await request.json();
  const { token, name, secret } = body;

  if (!token || !secret) return cors(JSON.stringify({ ok: false, error: 'token & secret required' }), 400);

  const tgResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const tgJson = await tgResp.json();
  if (!tgJson.ok) return cors(JSON.stringify({ ok: false, error: 'Token မမှန်: ' + (tgJson.description || '') }), 400);

  const info = tgJson.result;
  const botId = String(info.id);

  await env.DB.prepare(
    `INSERT INTO bots (id, token, name, username, owner_secret, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       token = excluded.token,
       name = excluded.name,
       username = excluded.username,
       owner_secret = excluded.owner_secret`
  ).bind(botId, token, name || info.first_name, info.username, secret, Date.now()).run();

  const origin = new URL(request.url).origin;
  const webhookUrl = `${origin}/webhook/${botId}`;
  await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);

  const existing = await env.DB.prepare(`SELECT COUNT(*) as c FROM commands WHERE bot_id = ?`).bind(botId).first();
  if (!existing || existing.c === 0) {
    await env.DB.prepare(`INSERT INTO commands (bot_id, trigger, response) VALUES (?, ?, ?)`)
      .bind(botId, '/start', 'မင်္ဂလာပါ! ကျွန်တော် bot ဖြစ်ပါတယ် 🤖').run();
    await env.DB.prepare(`INSERT INTO commands (bot_id, trigger, response) VALUES (?, ?, ?)`)
      .bind(botId, '/help', 'Commands:\n/start - စတင်\n/help - အကူအညီ').run();
    await env.DB.prepare(`INSERT INTO auto_reply (bot_id, keyword, response, match_type) VALUES (?, ?, ?, ?)`)
      .bind(botId, 'hello', 'မင်္ဂလာပါ 👋', 'contains').run();
  }

  return cors(JSON.stringify({
    ok: true, botId, username: info.username, firstName: info.first_name, webhookUrl,
  }));
}

async function listBots(url, env) {
  const secret = url.searchParams.get('secret');
  if (!secret) return cors(JSON.stringify({ ok: false, error: 'secret required' }), 400);

  const r = await env.DB.prepare(
    `SELECT id, name, username, enabled, created_at FROM bots WHERE owner_secret = ?`
  ).bind(secret).all();

  return cors(JSON.stringify({ ok: true, bots: r.results || [] }));
}

async function toggleBot(botId, request, env) {
  const body = await request.json();
  const { enabled, secret } = body;

  const bot = await env.DB.prepare(`SELECT token, owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot) return cors(JSON.stringify({ ok: false, error: 'Bot not found' }), 404);
  if (bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);

  const origin = new URL(request.url).origin;
  if (enabled) {
    const webhookUrl = `${origin}/webhook/${botId}`;
    await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
  } else {
    await fetch(`https://api.telegram.org/bot${bot.token}/deleteWebhook`);
  }

  await env.DB.prepare(`UPDATE bots SET enabled = ? WHERE id = ?`).bind(enabled ? 1 : 0, botId).run();
  return cors(JSON.stringify({ ok: true, enabled }));
}

async function deleteBot(botId, request, env) {
  const body = await request.json();
  const { secret } = body;

  const bot = await env.DB.prepare(`SELECT token, owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot) return cors(JSON.stringify({ ok: false, error: 'Not found' }), 404);
  if (bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);

  await fetch(`https://api.telegram.org/bot${bot.token}/deleteWebhook`);
  await env.DB.prepare(`DELETE FROM bots WHERE id = ?`).bind(botId).run();
  await env.DB.prepare(`DELETE FROM commands WHERE bot_id = ?`).bind(botId).run();
  await env.DB.prepare(`DELETE FROM auto_reply WHERE bot_id = ?`).bind(botId).run();

  return cors(JSON.stringify({ ok: true }));
}

async function handleWebhook(botId, request, env) {
  const update = await request.json();
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return new Response('ok');

  const bot = await env.DB.prepare(`SELECT token, enabled FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || !bot.enabled) return new Response('ok');

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  let reply = null;

  if (text.startsWith('/')) {
    const c = await env.DB.prepare(`SELECT trigger, response FROM commands WHERE bot_id = ? AND enabled = 1`).bind(botId).all();
    const hit = (c.results || []).find(x => text === x.trigger || text.startsWith(x.trigger + ' '));
    if (hit) reply = hit.response;
  }

  if (!reply) {
    const r = await env.DB.prepare(`SELECT keyword, response, match_type FROM auto_reply WHERE bot_id = ? AND enabled = 1`).bind(botId).all();
    const t = text.toLowerCase();
    for (const row of (r.results || [])) {
      const k = row.keyword.toLowerCase();
      let ok = false;
      if (row.match_type === 'exact') ok = t === k;
      else if (row.match_type === 'starts') ok = t.startsWith(k);
      else ok = t.includes(k);
      if (ok) { reply = row.response; break; }
    }
  }

  if (reply) {
    await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: reply }),
    });
  }

  return new Response('ok');
}