export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return cors('', 204);

    try {
      // ===== Bots =====
      if (path === '/api/bots' && method === 'POST') return await registerBot(request, env);
      if (path === '/api/bots' && method === 'GET') return await listBots(url, env);
      const toggleM = path.match(/^\/api\/bots\/([^\/]+)\/toggle$/);
      if (toggleM && method === 'POST') return await toggleBot(toggleM[1], request, env);
      const delM = path.match(/^\/api\/bots\/([^\/]+)$/);
      if (delM && method === 'DELETE') return await deleteBot(delM[1], request, env);

      // ===== Commands =====
      if (path === '/api/commands' && method === 'GET') return await listCommands(url, env);
      if (path === '/api/commands' && method === 'POST') return await addCommand(request, env);
      const cmdUpd = path.match(/^\/api\/commands\/(\d+)$/);
      if (cmdUpd && method === 'PUT') return await updateCommand(cmdUpd[1], request, env);
      if (cmdUpd && method === 'DELETE') return await deleteCommand(cmdUpd[1], request, env);

      // ===== Auto Reply =====
      if (path === '/api/auto_reply' && method === 'GET') return await listAutoReply(url, env);
      if (path === '/api/auto_reply' && method === 'POST') return await addAutoReply(request, env);
      const arUpd = path.match(/^\/api\/auto_reply\/(\d+)$/);
      if (arUpd && method === 'PUT') return await updateAutoReply(arUpd[1], request, env);
      if (arUpd && method === 'DELETE') return await deleteAutoReply(arUpd[1], request, env);

      // ===== Menus =====
      if (path === '/api/menus' && method === 'GET') return await listMenus(url, env);
      if (path === '/api/menus' && method === 'POST') return await addMenu(request, env);
      const menuUpd = path.match(/^\/api\/menus\/(\d+)$/);
      if (menuUpd && method === 'PUT') return await updateMenu(menuUpd[1], request, env);
      if (menuUpd && method === 'DELETE') return await deleteMenu(menuUpd[1], request, env);

      // ===== Webhook =====
      const whM = path.match(/^\/webhook\/([^\/]+)$/);
      if (whM && method === 'POST') return await handleWebhook(whM[1], request, env);

      return cors(JSON.stringify({ error: 'Not found', path }), 404);
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
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
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
  if (!tgJson.ok) return cors(JSON.stringify({ ok: false, error: 'Token မမှန်' }), 400);

  const info = tgJson.result;
  const botId = String(info.id);

  await env.DB.prepare(
    `INSERT INTO bots (id, token, name, username, owner_secret, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET
       token = excluded.token, name = excluded.name,
       username = excluded.username, owner_secret = excluded.owner_secret`
  ).bind(botId, token, name || info.first_name, info.username, secret, Date.now()).run();

  const existing = await env.DB.prepare(`SELECT COUNT(*) as c FROM commands WHERE bot_id = ?`).bind(botId).first();
  if (!existing || existing.c === 0) {
    await env.DB.prepare(`INSERT INTO commands (bot_id, trigger, response) VALUES (?, ?, ?)`)
      .bind(botId, '/start', 'မင်္ဂလာပါ! ကျွန်တော် bot ဖြစ်ပါတယ် 🤖').run();
    await env.DB.prepare(`INSERT INTO commands (bot_id, trigger, response) VALUES (?, ?, ?)`)
      .bind(botId, '/help', 'Commands:\n/start - စတင်\n/help - အကူအညီ').run();
    await env.DB.prepare(`INSERT INTO auto_reply (bot_id, keyword, response, match_type) VALUES (?, ?, ?, ?)`)
      .bind(botId, 'hello', 'မင်္ဂလာပါ 👋', 'contains').run();
  }

  // Default menu — ၄ ခလုတ်
  const menuExist = await env.DB.prepare(`SELECT COUNT(*) as c FROM menus WHERE bot_id = ?`).bind(botId).first();
  if (!menuExist || menuExist.c === 0) {
    await env.DB.prepare(`INSERT INTO menus (bot_id, label, action, row_num, enabled) VALUES (?, ?, ?, ?, 1)`)
      .bind(botId, '📅 Time', '/time', 1).run();
    await env.DB.prepare(`INSERT INTO menus (bot_id, label, action, row_num, enabled) VALUES (?, ?, ?, ?, 1)`)
      .bind(botId, 'ℹ️ Help', '/help', 1).run();
    await env.DB.prepare(`INSERT INTO menus (bot_id, label, action, row_num, enabled) VALUES (?, ?, ?, ?, 1)`)
      .bind(botId, '👋 Hello', 'hello', 2).run();
    await env.DB.prepare(`INSERT INTO menus (bot_id, label, action, row_num, enabled) VALUES (?, ?, ?, ?, 1)`)
      .bind(botId, '🛒 Price', 'ဈေး', 2).run();
  }

  return cors(JSON.stringify({
    ok: true, botId, username: info.username, firstName: info.first_name,
  }));
}

async function listBots(url, env) {
  const secret = url.searchParams.get('secret');
  if (!secret) return cors(JSON.stringify({ ok: false, error: 'secret required' }), 400);
  const r = await env.DB.prepare(`SELECT id, name, username, enabled FROM bots WHERE owner_secret = ?`).bind(secret).all();
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
    await fetch(`https://api.telegram.org/bot${bot.token}/setWebhook?url=${encodeURIComponent(origin + '/webhook/' + botId)}`);
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
  await env.DB.prepare(`DELETE FROM menus WHERE bot_id = ?`).bind(botId).run();
  return cors(JSON.stringify({ ok: true }));
}

// ===== Commands =====
async function listCommands(url, env) {
  const botId = url.searchParams.get('botId');
  const secret = url.searchParams.get('secret');
  if (!botId || !secret) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  const r = await env.DB.prepare(`SELECT id, trigger, response, enabled FROM commands WHERE bot_id = ? ORDER BY id`).bind(botId).all();
  return cors(JSON.stringify({ ok: true, commands: r.results || [] }));
}

async function addCommand(request, env) {
  const body = await request.json();
  const { botId, trigger, response, secret } = body;
  if (!botId || !trigger || !response || !secret) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  let t = trigger.trim();
  if (!t.startsWith('/')) t = '/' + t;
  await env.DB.prepare(`INSERT INTO commands (bot_id, trigger, response, enabled) VALUES (?, ?, ?, 1)`).bind(botId, t, response).run();
  return cors(JSON.stringify({ ok: true }));
}

async function updateCommand(id, request, env) {
  const body = await request.json();
  const { trigger, response, enabled, secret, botId } = body;
  if (!secret || !botId) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  if (trigger !== undefined) {
    let t = trigger.trim();
    if (!t.startsWith('/')) t = '/' + t;
    await env.DB.prepare(`UPDATE commands SET trigger = ? WHERE id = ? AND bot_id = ?`).bind(t, id, botId).run();
  }
  if (response !== undefined) await env.DB.prepare(`UPDATE commands SET response = ? WHERE id = ? AND bot_id = ?`).bind(response, id, botId).run();
  if (enabled !== undefined) await env.DB.prepare(`UPDATE commands SET enabled = ? WHERE id = ? AND bot_id = ?`).bind(enabled ? 1 : 0, id, botId).run();
  return cors(JSON.stringify({ ok: true }));
}

async function deleteCommand(id, request, env) {
  const body = await request.json();
  const { secret, botId } = body;
  if (!secret || !botId) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  await env.DB.prepare(`DELETE FROM commands WHERE id = ? AND bot_id = ?`).bind(id, botId).run();
  return cors(JSON.stringify({ ok: true }));
}

// ===== Auto Reply =====
async function listAutoReply(url, env) {
  const botId = url.searchParams.get('botId');
  const secret = url.searchParams.get('secret');
  if (!botId || !secret) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  const r = await env.DB.prepare(`SELECT id, keyword, response, match_type, enabled FROM auto_reply WHERE bot_id = ? ORDER BY id`).bind(botId).all();
  return cors(JSON.stringify({ ok: true, rules: r.results || [] }));
}

async function addAutoReply(request, env) {
  const body = await request.json();
  const { botId, keyword, response, match_type, secret } = body;
  if (!botId || !keyword || !response || !secret) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  const mt = match_type || 'contains';
  await env.DB.prepare(`INSERT INTO auto_reply (bot_id, keyword, response, match_type, enabled) VALUES (?, ?, ?, ?, 1)`).bind(botId, keyword, response, mt).run();
  return cors(JSON.stringify({ ok: true }));
}

async function updateAutoReply(id, request, env) {
  const body = await request.json();
  const { keyword, response, match_type, enabled, secret, botId } = body;
  if (!secret || !botId) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  if (keyword !== undefined) await env.DB.prepare(`UPDATE auto_reply SET keyword = ? WHERE id = ? AND bot_id = ?`).bind(keyword, id, botId).run();
  if (response !== undefined) await env.DB.prepare(`UPDATE auto_reply SET response = ? WHERE id = ? AND bot_id = ?`).bind(response, id, botId).run();
  if (match_type !== undefined) await env.DB.prepare(`UPDATE auto_reply SET match_type = ? WHERE id = ? AND bot_id = ?`).bind(match_type, id, botId).run();
  if (enabled !== undefined) await env.DB.prepare(`UPDATE auto_reply SET enabled = ? WHERE id = ? AND bot_id = ?`).bind(enabled ? 1 : 0, id, botId).run();
  return cors(JSON.stringify({ ok: true }));
}

async function deleteAutoReply(id, request, env) {
  const body = await request.json();
  const { secret, botId } = body;
  if (!secret || !botId) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  await env.DB.prepare(`DELETE FROM auto_reply WHERE id = ? AND bot_id = ?`).bind(id, botId).run();
  return cors(JSON.stringify({ ok: true }));
}

// ===== Menus =====
async function listMenus(url, env) {
  const botId = url.searchParams.get('botId');
  const secret = url.searchParams.get('secret');
  if (!botId || !secret) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  const r = await env.DB.prepare(`SELECT id, label, action, row_num, enabled FROM menus WHERE bot_id = ? ORDER BY row_num, id`).bind(botId).all();
  return cors(JSON.stringify({ ok: true, menus: r.results || [] }));
}

async function addMenu(request, env) {
  const body = await request.json();
  const { botId, label, action, row_num, secret } = body;
  if (!botId || !label || !action || !secret) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  const rn = row_num || 1;
  await env.DB.prepare(`INSERT INTO menus (bot_id, label, action, row_num, enabled) VALUES (?, ?, ?, ?, 1)`).bind(botId, label, action, rn).run();
  return cors(JSON.stringify({ ok: true }));
}

async function updateMenu(id, request, env) {
  const body = await request.json();
  const { label, action, row_num, enabled, secret, botId } = body;
  if (!secret || !botId) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  if (label !== undefined) await env.DB.prepare(`UPDATE menus SET label = ? WHERE id = ? AND bot_id = ?`).bind(label, id, botId).run();
  if (action !== undefined) await env.DB.prepare(`UPDATE menus SET action = ? WHERE id = ? AND bot_id = ?`).bind(action, id, botId).run();
  if (row_num !== undefined) await env.DB.prepare(`UPDATE menus SET row_num = ? WHERE id = ? AND bot_id = ?`).bind(row_num, id, botId).run();
  if (enabled !== undefined) await env.DB.prepare(`UPDATE menus SET enabled = ? WHERE id = ? AND bot_id = ?`).bind(enabled ? 1 : 0, id, botId).run();
  return cors(JSON.stringify({ ok: true }));
}

async function deleteMenu(id, request, env) {
  const body = await request.json();
  const { secret, botId } = body;
  if (!secret || !botId) return cors(JSON.stringify({ ok: false, error: 'required' }), 400);
  const bot = await env.DB.prepare(`SELECT owner_secret FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || bot.owner_secret !== secret) return cors(JSON.stringify({ ok: false, error: 'Unauthorized' }), 403);
  await env.DB.prepare(`DELETE FROM menus WHERE id = ? AND bot_id = ?`).bind(id, botId).run();
  return cors(JSON.stringify({ ok: true }));
}

// ===== Webhook =====
async function handleWebhook(botId, request, env) {
  const update = await request.json();
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return new Response('ok');
  const bot = await env.DB.prepare(`SELECT token, enabled FROM bots WHERE id = ?`).bind(botId).first();
  if (!bot || !bot.enabled) return new Response('ok');

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  let reply = null;
  let showMenu = false;

  // /start or /menu → reply + menu
  if (text === '/start' || text === '/menu') {
    const c = await env.DB.prepare(`SELECT response FROM commands WHERE bot_id = ? AND trigger = ? AND enabled = 1`).bind(botId, text).first();
    reply = c ? c.response : 'မင်္ဂလာပါ!';
    showMenu = true;
  }

  // Other commands
  if (!reply && text.startsWith('/')) {
    const c = await env.DB.prepare(`SELECT trigger, response FROM commands WHERE bot_id = ? AND enabled = 1`).bind(botId).all();
    const hit = (c.results || []).find(x => text === x.trigger || text.startsWith(x.trigger + ' '));
    if (hit) reply = hit.response;
  }

  // Auto-reply
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

  // Send reply
  if (reply) {
    const payload = { chat_id: chatId, text: reply };
    if (showMenu) {
      const menus = await env.DB.prepare(`SELECT label, action, row_num FROM menus WHERE bot_id = ? AND enabled = 1 ORDER BY row_num, id`).bind(botId).all();
      const rows = {};
      for (const m of (menus.results || [])) {
        if (!rows[m.row_num]) rows[m.row_num] = [];
        rows[m.row_num].push({ text: m.label });
      }
      const keyboard = Object.keys(rows).sort((a,b) => a-b).map(rn => rows[rn]);
      if (keyboard.length > 0) {
        payload.reply_markup = {
          keyboard: keyboard,
          resize_keyboard: true,
          is_persistent: true,
        };
      }
    }
    await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  return new Response('ok');
}