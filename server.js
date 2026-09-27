require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { BOT_TOKEN, PUBLIC_URL, PORT = 3000 } = process.env;

if (!BOT_TOKEN) {
  console.error('❌ Не задан BOT_TOKEN в переменных окружения (.env)');
  process.exit(1);
}

const WEBHOOK_PATH = '/telegram-webhook';
const WEBHOOK_SECRET = crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32);

const DB_PATH = path.join(__dirname, 'data.json');

const ENERGY_REGEN_MS = 3000;
const DEFAULT_MAX_ENERGY = 100;

const STORE_ITEMS = {
  energy_refill: {
    title: 'Полная энергия',
    description: 'Мгновенно восстанавливает всю энергию',
    price: 15,
    apply: (u) => { u.energy = u.maxEnergy; },
  },
  coin_boost_30m: {
    title: 'x2 монеты (30 мин)',
    description: 'Удваивает доход с каждого тапа на 30 минут',
    price: 25,
    apply: (u) => { u.boostUntil = Date.now() + 30 * 60 * 1000; },
  },
  golden_skin: {
    title: 'Золотой скин',
    description: 'Косметический золотой вид кнопки тапа',
    price: 40,
    apply: (u) => { u.skin = 'golden'; },
  },
  max_energy_up: {
    title: '+50 макс. энергии',
    description: 'Навсегда увеличивает максимум энергии на 50',
    price: 50,
    apply: (u) => { u.maxEnergy += 50; },
  },
};

const UPGRADES = {
  tapPower: { baseCost: 20, growth: 1.6, apply: (u) => { u.tapPower += 1; } },
  maxEnergy: { baseCost: 30, growth: 1.6, apply: (u) => { u.maxEnergy += 10; } },
};

function upgradeCost(type, level) {
  const cfg = UPGRADES[type];
  return Math.floor(cfg.baseCost * Math.pow(cfg.growth, level));
}

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { users: {} };
  }
}
function saveDb() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db));
  } catch (e) {
    console.error('Ошибка записи базы:', e.message);
  }
}
const db = loadDb();

function getUser(id) {
  if (!db.users[id]) {
    db.users[id] = {
      coins: 0,
      energy: DEFAULT_MAX_ENERGY,
      maxEnergy: DEFAULT_MAX_ENERGY,
      tapPower: 1,
      levels: { tapPower: 0, maxEnergy: 0 },
      boostUntil: 0,
      skin: 'default',
      lastUpdate: Date.now(),
    };
  }
  return db.users[id];
}

function regenEnergy(u) {
  const now = Date.now();
  const elapsed = now - u.lastUpdate;
  const regen = Math.floor(elapsed / ENERGY_REGEN_MS);
  if (regen > 0) {
    u.energy = Math.min(u.maxEnergy, u.energy + regen);
    u.lastUpdate = now;
  }
}

function publicState(u) {
  return {
    coins: u.coins,
    energy: u.energy,
    maxEnergy: u.maxEnergy,
    tapPower: u.tapPower,
    levels: u.levels,
    boostActive: Date.now() < u.boostUntil,
    boostUntil: u.boostUntil,
    skin: u.skin,
  };
}

function verifyInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const pairs = [];
  for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computedHash !== hash) return null;
  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch {
    return null;
  }
}

async function tgApi(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('ok'));

app.post('/api/state', (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const u = getUser(user.id);
  regenEnergy(u);
  saveDb();
  res.json(publicState(u));
});

app.post('/api/save', (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const u = getUser(user.id);
  regenEnergy(u);
  const { coins, energy } = req.body;
  if (typeof coins === 'number' && coins >= u.coins && coins - u.coins < 100000) {
    u.coins = Math.floor(coins);
  }
  if (typeof energy === 'number') {
    u.energy = Math.max(0, Math.min(u.maxEnergy, Math.floor(energy)));
  }
  u.lastUpdate = Date.now();
  saveDb();
  res.json(publicState(u));
});

app.post('/api/upgrade', (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const { type } = req.body;
  const cfg = UPGRADES[type];
  if (!cfg) return res.status(400).json({ error: 'unknown upgrade' });
  const u = getUser(user.id);
  regenEnergy(u);
  const level = u.levels[type] || 0;
  const cost = upgradeCost(type, level);
  if (u.coins < cost) return res.status(400).json({ error: 'not enough coins' });
  u.coins -= cost;
  u.levels[type] = level + 1;
  cfg.apply(u);
  saveDb();
  res.json(publicState(u));
});

app.get('/api/store', (req, res) => {
  const items = Object.entries(STORE_ITEMS).map(([id, it]) => ({
    id, title: it.title, description: it.description, price: it.price,
  }));
  res.json(items);
});

app.post('/api/create-invoice', async (req, res) => {
  const user = verifyInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const { itemId } = req.body;
  const item = STORE_ITEMS[itemId];
  if (!item) return res.status(400).json({ error: 'unknown item' });

  const payload = JSON.stringify({ uid: user.id, itemId, ts: Date.now() });
  const result = await tgApi('createInvoiceLink', {
    title: item.title,
    description: item.description,
    payload,
    currency: 'XTR',
    prices: [{ label: item.title, amount: item.price }],
  });

  if (!result.ok) {
    console.error('createInvoiceLink error:', result);
    return res.status(500).json({ error: 'telegram_error', details: result.description });
  }
  res.json({ invoiceUrl: result.result });
});

app.post(WEBHOOK_PATH, async (req, res) => {
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  const update = req.body;
  try {
    if (update.message?.text === '/start') {
      await tgApi('sendMessage', {
        chat_id: update.message.chat.id,
        text: 'Жми и зарабатывай монеты! 🪙',
        reply_markup: {
          inline_keyboard: [[{ text: '🎮 Играть', web_app: { url: PUBLIC_URL } }]],
        },
      });
    } else if (update.pre_checkout_query) {
      await tgApi('answerPreCheckoutQuery', {
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true,
      });
    } else if (update.message?.successful_payment) {
      const payment = update.message.successful_payment;
      const payload = JSON.parse(payment.invoice_payload);
      const item = STORE_ITEMS[payload.itemId];
      if (item) {
        const u = getUser(payload.uid);
        item.apply(u);
        saveDb();
        await tgApi('sendMessage', {
          chat_id: update.message.chat.id,
          text: `Готово! Куплено: ${item.title} ⭐`,
        });
      }
    }
  } catch (e) {
    console.error('Ошибка обработки апдейта:', e);
  }
});

app.listen(PORT, async () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  if (PUBLIC_URL) {
    const url = `${PUBLIC_URL}${WEBHOOK_PATH}`;
    const result = await tgApi('setWebhook', { url, secret_token: WEBHOOK_SECRET });
    console.log('setWebhook:', result.ok ? `OK → ${url}` : JSON.stringify(result));
  } else {
    console.warn('⚠️  PUBLIC_URL не задан — вебхук не настроен автоматически');
  }
});
