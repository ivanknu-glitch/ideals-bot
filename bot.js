const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Firebase Admin ініціалізація
let db = null;
try {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : null;
  
  if (privateKey && process.env.FIREBASE_CLIENT_EMAIL) {
    const firebaseApp = initializeApp({
      credential: cert({
        projectId: 'ideals-nail',
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: privateKey,
      })
    });
    db = getFirestore(firebaseApp);
    console.log('✅ Firebase Admin підключено');
  } else {
    console.log('⚠️ Firebase змінні не знайдено, продовжуємо без Firebase');
  }
} catch(e) {
  console.log('⚠️ Firebase Admin помилка:', e.message);
}

const TOKEN = '8983487603:AAEKlidCC7AJGrhIKmYD3U-CTYxvd4vhG9A';
const MASTER_ID = 1199443187;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

const MN = ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
const usedCodes = new Set();
let clients = {};
let userState = {};

function generateCode() {
  let code;
  do {
    const ts = Date.now().toString(36).toUpperCase().slice(-4);
    const rnd = Math.random().toString(36).toUpperCase().slice(2,5);
    code = 'IDEALS-' + ts + rnd;
  } while (usedCodes.has(code));
  usedCodes.add(code);
  return code;
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDate() + ' ' + MN[d.getMonth()];
}

// /start
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const param = match[1].trim();

  if (chatId === MASTER_ID) {
    bot.sendMessage(chatId,
      `👑 *Вітаємо, майстре!*\n\nДоступні команди:\n/today — посилання на записи\n/bookings — адмін-панель\n/stats — статистика`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (param && param.startsWith('IDEALS-')) {
    linkClient(chatId, param, msg);
    return;
  }

  const known = await findClient(chatId);
  if (known) { showClientMenu(chatId, known); return; }

  bot.sendMessage(chatId,
    `🌸 *Вітаємо в Ideals Nail Studio!*\n\nВведіть код який отримали після запису.\nКод виглядає так: *IDEALS-XXXX*`,
    { parse_mode: 'Markdown' }
  );
  userState[chatId] = { step: 'waiting_code' };
});

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  // Перевіряємо кнопки меню
  const isMenuButton = await handleMenuButton(msg);
  if (isMenuButton) return;

  const state = userState[chatId];

  if (state && state.step === 'waiting_code') {
    const code = text.trim().toUpperCase();
    if (code.startsWith('IDEALS-')) {
      linkClient(chatId, code, msg);
    } else {
      bot.sendMessage(chatId, `❌ Невірний код. Введіть код у форматі *IDEALS-XXXX*`, { parse_mode: 'Markdown' });
    }
    return;
  }

  if (state && state.step === 'reschedule_date') {
    userState[chatId].data.newDate = text;
    userState[chatId].step = 'reschedule_time';
    bot.sendMessage(chatId, `⏰ Введіть бажаний час (наприклад: *14:00*)`, { parse_mode: 'Markdown' });
    return;
  }

  if (state && state.step === 'reschedule_time') {
    const time = text.trim();
    const client = await findClient(chatId);
    const newDate = userState[chatId].data.newDate;
    bot.sendMessage(MASTER_ID,
      `🔄 *Запит на перенесення*\n\n👤 ${client ? client.name : 'Клієнт'}\n📱 ${client ? client.phone : '—'}\n📅 Нова дата: ${newDate}\n⏰ Новий час: ${time}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Підтвердити', callback_data: `res_ok_${chatId}_${newDate}_${time}` },
            { text: '❌ Відхилити', callback_data: `res_no_${chatId}` }
          ]]
        }
      }
    );
    bot.sendMessage(chatId, `✅ Запит надіслано! Майстер розгляне і повідомить вас.`);
    delete userState[chatId];
    return;
  }
});

async function linkClient(chatId, code, msg) {
  const name = msg.from.first_name || 'Клієнт';
  const username = msg.from.username || '';
  const clientData = { telegramId: chatId, name, phone: '—', code, username };
  clients[code] = clientData;
  clients[String(chatId)] = clientData;
  delete userState[chatId];

  // Зберігаємо в Firebase
  if (db) {
    try {
      await db.collection('telegramClients').doc(String(chatId)).set(clientData);
      console.log('✅ Клієнт збережено в Firebase:', chatId);
    } catch(e) { console.log('Firebase client save error:', e.message); }
  }

  bot.sendMessage(chatId,
    `✅ *${name}, ваш код прийнято!*\n\nТепер ви будете отримувати сповіщення про ваш запис 🌸`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['📅 Мої записи', '🆕 Новий запис'],
          ['🔄 Перенести запис', '❌ Скасувати запис'],
          ["📞 Зв'язатись з майстром"]
        ],
        resize_keyboard: true
      }
    }
  );

  bot.sendMessage(MASTER_ID,
    `🔗 *Клієнт прив'язав код*\n\n👤 ${name}\n🔑 ${code}\n💬 @${username || 'без username'}`,
    { parse_mode: 'Markdown' }
  );
}

// Завантажуємо клієнтів з Firebase при старті
async function loadClients() {
  if (!db) return;
  try {
    const snap = await db.collection('telegramClients').get();
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.code) clients[data.code] = data;
      if (data.telegramId) clients[String(data.telegramId)] = data;
    });
    console.log('✅ Завантажено клієнтів:', Object.keys(clients).length);
  } catch(e) { console.log('Firebase load clients error:', e.message); }
}

// Пошук клієнта по telegramId
async function findClient(chatId) {
  // Спочатку в пам'яті
  let client = clients[String(chatId)] || Object.values(clients).find(c => c.telegramId === chatId || c.telegramId === String(chatId));
  // Якщо не знайдено — в Firebase
  if (!client && db) {
    try {
      const doc = await db.collection('telegramClients').doc(String(chatId)).get();
      if (doc.exists) {
        client = doc.data();
        clients[String(chatId)] = client;
        if (client.code) clients[client.code] = client;
      }
    } catch(e) {}
  }
  return client;
}
loadClients();

function showClientMenu(chatId, client) {
  bot.sendMessage(chatId, `🌸 *Вітаємо, ${client.name}!*\nОберіть дію:`, {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        ['📅 Мої записи', '🆕 Новий запис'],
        ['🔄 Перенести запис', '❌ Скасувати запис'],
        ["📞 Зв'язатись з майстром"]
      ],
      resize_keyboard: true
    }
  });
}

// Обробка кнопок меню через текст повідомлення
async function handleMenuButton(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.includes('Новий запис')) {
    bot.sendMessage(chatId, `🆕 Перейдіть для запису:\nhttps://ideals-nail.web.app?tg=${chatId}`);
    return true;
  }

  if (text.includes('Мої записи')) {
    const client = await findClient(chatId);
    if (!client) {
      bot.sendMessage(chatId, 'Введіть ваш код IDEALS-XXXX');
      userState[chatId] = { step: 'waiting_code' };
      return true;
    }
    await showClientBookings(chatId, client);
    return true;
  }

  if (text.includes('Перенести запис')) {
    const client = await findClient(chatId);
    if (!client) {
      bot.sendMessage(chatId, 'Введіть ваш код IDEALS-XXXX');
      userState[chatId] = { step: 'waiting_code' };
      return true;
    }
    userState[chatId] = { step: 'reschedule_date', data: {} };
    bot.sendMessage(chatId, `📅 Введіть бажану нову дату (наприклад: 15 липня)`);
    return true;
  }

  if (text.includes('Скасувати запис')) {
    const client = await findClient(chatId);
    if (!client) {
      bot.sendMessage(chatId, 'Введіть ваш код IDEALS-XXXX');
      userState[chatId] = { step: 'waiting_code' };
      return true;
    }
    bot.sendMessage(chatId, `❌ Скасувати запис?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Так, скасувати', callback_data: `cancel_${chatId}` },
          { text: 'Ні, залишити', callback_data: 'keep' }
        ]]
      }
    });
    return true;
  }

  if (text.includes('язатись') || text.includes('📞') || text.includes('майстром')) {
    bot.sendMessage(chatId, `📞 Telegram майстра: @ideals_nail

Пишіть якщо є запитання! 🌸`);
    return true;
  }

  return false;
}

bot.onText(/\/today/, (msg) => {
  if (msg.chat.id !== MASTER_ID) return;
  bot.sendMessage(MASTER_ID, `📋 Адмін-панель:\nhttps://ideals-nail.web.app/admin.html`);
});

bot.onText(/\/bookings/, (msg) => {
  if (msg.chat.id !== MASTER_ID) return;
  bot.sendMessage(MASTER_ID, `📋 Адмін-панель:\nhttps://ideals-nail.web.app/admin.html`);
});

bot.onText(/\/stats/, (msg) => {
  if (msg.chat.id !== MASTER_ID) return;
  bot.sendMessage(MASTER_ID,
    `📊 *Статистика:*\n\nКлієнтів у боті: ${Object.keys(clients).length}\n\nДетальна статистика:\nhttps://ideals-nail.web.app/admin.html`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data.startsWith('confirm_')) {
    const firebaseId = data.replace('confirm_', '');
    bot.editMessageText(`✅ *Запис підтверджено*`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
    // Оновлюємо статус в Firebase
    try {
      if (firebaseId && firebaseId !== 'none') {
        await db.collection('bookings').doc(firebaseId).update({ status: 'confirmed' });
        console.log('✅ Firebase оновлено: confirmed', firebaseId);
      }
    } catch(e) { console.log('Firebase update error:', e); }
    const client = Object.values(clients).find(c => c.bookingId === firebaseId);
    if (client) {
      bot.sendMessage(client.telegramId, `✅ *Ваш запис підтверджено!*\n\n💳 Не забудьте про передоплату — реквізити надіслано.`, { parse_mode: 'Markdown' });
    }
  }

  if (data.startsWith('reject_')) {
    const firebaseId = data.replace('reject_', '');
    bot.editMessageText(`❌ *Запис відхилено*`, { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' });
    // Оновлюємо статус в Firebase
    try {
      if (firebaseId && firebaseId !== 'none') {
        await db.collection('bookings').doc(firebaseId).update({ status: 'cancelled' });
        console.log('✅ Firebase оновлено: cancelled', firebaseId);
      }
    } catch(e) { console.log('Firebase update error:', e); }
    const client = Object.values(clients).find(c => c.bookingId === firebaseId);
    if (client) {
      bot.sendMessage(client.telegramId, `❌ На жаль, ваш запис не підтверджено. Оберіть інший час.`);
    }
  }

  if (data.startsWith('res_ok_')) {
    const parts = data.split('_');
    const clientChatId = parseInt(parts[2]);
    const newDate = parts[3];
    const newTime = parts[4];
    bot.editMessageText(`✅ Перенесення підтверджено: ${newDate} о ${newTime}`, { chat_id: chatId, message_id: query.message.message_id });
    bot.sendMessage(clientChatId, `✅ *Запис перенесено!*\n📅 ${newDate} о ${newTime}\n\nЧекаємо вас! 🌸`, { parse_mode: 'Markdown' });
  }

  if (data.startsWith('res_no_')) {
    const clientChatId = parseInt(data.split('_')[2]);
    bot.editMessageText(`❌ Перенесення відхилено`, { chat_id: chatId, message_id: query.message.message_id });
    if (clientChatId) bot.sendMessage(clientChatId, `❌ На жаль, перенесення неможливе. Зв'яжіться з майстром.`);
  }

  if (data.startsWith('cancel_')) {
    const clientChatId = parseInt(data.split('_')[1]);
    bot.editMessageText('✅ Запис скасовано', { chat_id: chatId, message_id: query.message.message_id });
    bot.sendMessage(clientChatId, '✅ Ваш запис скасовано. До зустрічі! 🌸');
    bot.sendMessage(MASTER_ID, `⚠️ Клієнт скасував запис`);
    // Оновлюємо Firebase
    if (db) {
      try {
        const client = await db.collection('telegramClients').doc(String(clientChatId)).get();
        if (client.exists) {
          const code = client.data().code;
          const snap = await db.collection('bookings').where('code', '==', code).where('status', '!=', 'cancelled').get();
          for (const doc of snap.docs) {
            await db.collection('bookings').doc(doc.id).update({ status: 'cancelled' });
          }
          console.log('✅ Запис скасовано в Firebase');
        }
      } catch(e) { console.log('cancel Firebase error:', e.message); }
    }
  }

  if (data === 'keep') {
    bot.editMessageText('👍 Запис залишено!', { chat_id: chatId, message_id: query.message.message_id });
  }

  bot.answerCallbackQuery(query.id);
});

// API для сайту
app.post('/new-booking', (req, res) => {
  const booking = req.body;
  const clientType = booking.clientType === 'new' ? '🆕 Новий клієнт (з передоплатою)' : '🌸 Постійний клієнт';

  bot.sendMessage(MASTER_ID,
    `🌸 Новий запис!\n\n` +
    `👤 ${booking.name}\n` +
    `📱 ${booking.phone}\n` +
    `💅 ${booking.services}\n` +
    `📅 ${fmtDate(booking.date)}, ${booking.time}\n` +
    `⏱ ${booking.duration}\n` +
    `💰 ${booking.price} грн\n` +
    `${clientType}\n` +
    `🔑 Код: ${booking.code}`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Підтвердити', callback_data: `confirm_${booking.id || 'none'}` },
          { text: '❌ Відхилити', callback_data: `reject_${booking.id || 'none'}` }
        ]]
      }
    }
  );

  res.json({ success: true });
});

async function showClientBookings(chatId, client) {
  if (!db) { bot.sendMessage(chatId, '📅 Записи тимчасово недоступні'); return; }
  try {
    const snap = await db.collection('bookings').where('code', '==', client.code).get();
    const MN = ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
    const bookings = snap.docs.map(d=>d.data()).filter(b=>b.status!=='cancelled').sort((a,b)=>a.date>b.date?1:-1);
    if (!bookings.length) {
      bot.sendMessage(chatId, `📅 Активних записів немає.

Запишіться: https://ideals-nail.web.app`);
      return;
    }
    const text = bookings.map(b => {
      const d = new Date(b.date + 'T00:00:00');
      const status = b.status === 'confirmed' ? '✅' : '⏳';
      return status + ' ' + d.getDate() + ' ' + MN[d.getMonth()] + ', ' + b.time + '\n💅 ' + b.services + '\n💰 ' + b.price + ' грн';
    }).join('\n\n');
    bot.sendMessage(chatId, '📅 Ваші записи:\n\n' + text);
  } catch(e) {
    console.log('showClientBookings error:', e.message);
    bot.sendMessage(chatId, '📅 Не вдалось завантажити записи.');
  }
}

app.post('/notify-client', async (req, res) => {
  const { bookingId, type, date, time } = req.body;
  const MN = ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
  let clientChatId = null;
  if (db) {
    try {
      const bookingDoc = await db.collection('bookings').doc(bookingId).get();
      if (bookingDoc.exists) {
        const booking = bookingDoc.data();
        const clientSnap = await db.collection('telegramClients').where('code', '==', booking.code).get();
        if (!clientSnap.empty) clientChatId = clientSnap.docs[0].data().telegramId;
      }
    } catch(e) { console.log('notify-client error:', e.message); }
  }
  if (clientChatId) {
    if (type === 'confirmed') {
      bot.sendMessage(clientChatId, `✅ Ваш запис підтверджено!

💳 Не забудьте про передоплату.`);
    } else if (type === 'cancelled') {
      bot.sendMessage(clientChatId, `❌ Ваш запис скасовано майстром.

Для нового запису: https://ideals-nail.web.app`);
    } else if (type === 'rescheduled') {
      const d = new Date(date + 'T00:00:00');
      bot.sendMessage(clientChatId, '🔄 Ваш запис перенесено!\n\n📅 ' + d.getDate() + ' ' + MN[d.getMonth()] + ' о ' + time + '\n\nЧекаємо вас! 🌸');
    }
  }
  res.json({ success: true, notified: !!clientChatId });
});

bot.onText(/\/newcode/, async (msg) => {
  const chatId = msg.chat.id;
  delete clients[String(chatId)];
  if (db) {
    try { await db.collection('telegramClients').doc(String(chatId)).delete(); } catch(e) {}
  }
  userState[chatId] = { step: 'waiting_code' };
  bot.sendMessage(chatId, '🔄 Введіть ваш новий код IDEALS-XXXX:');
});

app.get('/', (req, res) => res.send('🌸 Ideals Bot is running!'));
app.listen(PORT, () => console.log(`🌸 Server on port ${PORT}`));
