const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const TOKEN = '8983487603:AAEKlidCC7AJGrhIKmYD3U-CTYxvd4vhG9A';
const MASTER_ID = 845655193;
const PORT = process.env.PORT || 3000;

// Firebase Admin
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
    console.log('Firebase Admin OK');
  }
} catch(e) {
  console.log('Firebase Admin error:', e.message);
}

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

const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MN_UA = ['\u0441\u0456\u0447','\u043b\u044e\u0442','\u0431\u0435\u0440','\u043a\u0432\u0456','\u0442\u0440\u0430','\u0447\u0435\u0440','\u043b\u0438\u043f','\u0441\u0435\u0440','\u0432\u0435\u0440','\u0436\u043e\u0432','\u043b\u0438\u0441','\u0433\u0440\u0443'];

let clients = {};
let userState = {};

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.getDate() + ' ' + MN_UA[d.getMonth()];
}

async function findClient(chatId) {
  let client = clients[String(chatId)] || Object.values(clients).find(c => c.telegramId === chatId || c.telegramId === String(chatId));
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

async function loadClients() {
  if (!db) return;
  try {
    const snap = await db.collection('telegramClients').get();
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.code) clients[data.code] = data;
      if (data.telegramId) clients[String(data.telegramId)] = data;
    });
    console.log('Clients loaded:', Object.keys(clients).length);
  } catch(e) { console.log('Load clients error:', e.message); }
}
loadClients();

async function showClientBookings(chatId, client) {
  if (!db) { bot.sendMessage(chatId, 'Записи тимчасово недоступні'); return; }
  try {
    let snap;
    if (client.phone && client.phone !== '—') {
      snap = await db.collection('bookings').where('phone', '==', client.phone).get();
    } else {
      snap = await db.collection('bookings').where('code', '==', client.code).get();
    }
    const bookings = snap.docs.map(d => d.data()).filter(b => b.status !== 'cancelled').sort((a,b) => a.date > b.date ? 1 : -1);
    if (!bookings.length) {
      bot.sendMessage(chatId, `Активних записів немає.\n\nЗапишіться: https://ideals-nail.web.app?tg=${chatId}`);
      return;
    }
    const text = bookings.map(b => {
      const d = new Date(b.date + 'T00:00:00');
      const status = b.status === 'confirmed' ? '' : '';
      return status + ' ' + d.getDate() + ' ' + MN_UA[d.getMonth()] + ', ' + b.time + '\n' + b.services + '\n' + b.price + ' грн';
    }).join('\n\n');
    bot.sendMessage(chatId, 'Ваші записи:\n\n' + text);
  } catch(e) {
    console.log('showClientBookings error:', e.message);
    bot.sendMessage(chatId, 'Не вдалось завантажити записи.');
  }
}

async function linkClient(chatId, code, msg) {
  const tgName = msg.from.first_name || 'Client';
  const username = msg.from.username || '';
  let realName = tgName;
  let realPhone = '—';
  if (db) {
    try {
      const snap = await db.collection('bookings').where('code', '==', code).limit(1).get();
      if (!snap.empty) {
        const booking = snap.docs[0].data();
        if (booking.name) realName = booking.name;
        if (booking.phone) realPhone = booking.phone;
      }
    } catch(e) {}
  }
  const clientData = { telegramId: chatId, name: realName, phone: realPhone, code, username };
  clients[code] = clientData;
  clients[String(chatId)] = clientData;
  delete userState[chatId];
  if (db) {
    try {
      await db.collection('telegramClients').doc(String(chatId)).set(clientData);
    } catch(e) {}
  }
  bot.sendMessage(chatId,
    '🌸 ' + realName + ', ваш код прийнято!\n\nТепер ви будете отримувати сповіщення про ваш запис 💅',
    {
      reply_markup: {
        keyboard: [
          ['Мої записи', 'Новий запис'],
          ['Перенести запис', 'Скасувати запис'],
          ['Зв\'язатись з майстром']
        ],
        resize_keyboard: true
      }
    }
  );
  bot.sendMessage(MASTER_ID, '🔗 Клієнт прив\'язав код\n\n👤 ' + realName + '\n📱 ' + realPhone + '\n🔑 ' + code + '\n💬 @' + (username || 'без username'));
}

function showClientMenu(chatId, client) {
  bot.sendMessage(chatId, 'Вітаємо, ' + client.name + '!\nОберіть дію:', {
    reply_markup: {
      keyboard: [
        ['Мої записи', 'Новий запис'],
        ['Перенести запис', 'Скасувати запис'],
        ['Зв\'язатись з майстром']
      ],
      resize_keyboard: true
    }
  });
}

// /start
bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const param = match[1].trim();
  if (chatId === MASTER_ID) {
    bot.sendMessage(chatId, 'Вітаємо, майстре!\n\n/today — записи\n/bookings — адмінка\n/stats — статистика');
    return;
  }
  if (param && param.startsWith('IDEALS-')) {
    linkClient(chatId, param, msg);
    return;
  }
  const known = await findClient(chatId);
  if (known) { showClientMenu(chatId, known); return; }
  bot.sendMessage(chatId, 'Вітаємо!\n\nВведіть код який отримали після запису.\nКод виглядає так: IDEALS-XXXX');
  userState[chatId] = { step: 'waiting_code' };
});

// Menu handler
async function handleMenuButton(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.includes('Новий запис')) {
    bot.sendMessage(chatId, 'Перейдіть для запису:\nhttps://ideals-nail.web.app?tg=' + chatId);
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
    // Показуємо список активних записів для вибору
    if (db) {
      try {
        let snap;
        if (client.phone && client.phone !== '—') {
          snap = await db.collection('bookings').where('phone', '==', client.phone).get();
        } else {
          snap = await db.collection('bookings').where('code', '==', client.code).get();
        }
        const active = snap.docs.map(d => ({...d.data(), id: d.id}))
          .filter(b => b.status !== 'cancelled')
          .sort((a,b) => a.date > b.date ? 1 : -1);
        
        if (!active.length) {
          bot.sendMessage(chatId, 'Активних записів немає.');
          return true;
        }
        if (active.length === 1) {
          userState[chatId] = { step: 'reschedule_date', data: { bookingId: active[0].id } };
          bot.sendMessage(chatId, 'Введіть нову дату у форматі ДД.ММ\nНаприклад: 15.07');
          return true;
        }
        // Кілька записів — показуємо вибір
        const keyboard = active.map(b => [{
          text: `${fmtDate(b.date)} ${b.time} — ${(b.services||'').split(',')[0]}`,
          callback_data: `pick_reschedule_${b.id}`
        }]);
        bot.sendMessage(chatId, 'Оберіть запис для перенесення:', {
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch(e) {
        userState[chatId] = { step: 'reschedule_date', data: {} };
        bot.sendMessage(chatId, 'Введіть нову дату у форматі ДД.ММ\nНаприклад: 15.07');
      }
    } else {
      userState[chatId] = { step: 'reschedule_date', data: {} };
      bot.sendMessage(chatId, 'Введіть нову дату у форматі ДД.ММ\nНаприклад: 15.07');
    }
    return true;
  }

  if (text.includes('Скасувати запис')) {
    const client = await findClient(chatId);
    if (!client) {
      bot.sendMessage(chatId, 'Введіть ваш код IDEALS-XXXX');
      userState[chatId] = { step: 'waiting_code' };
      return true;
    }
    // Показуємо список активних записів для вибору
    if (db) {
      try {
        let snap;
        if (client.phone && client.phone !== '—') {
          snap = await db.collection('bookings').where('phone', '==', client.phone).get();
        } else {
          snap = await db.collection('bookings').where('code', '==', client.code).get();
        }
        const active = snap.docs.map(d => ({...d.data(), id: d.id}))
          .filter(b => b.status !== 'cancelled')
          .sort((a,b) => a.date > b.date ? 1 : -1);
        
        if (!active.length) {
          bot.sendMessage(chatId, 'Активних записів немає.');
          return true;
        }
        if (active.length === 1) {
          bot.sendMessage(chatId, 'Скасувати запис ' + fmtDate(active[0].date) + ' о ' + active[0].time + '?', {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Так, скасувати', callback_data: `cancel_booking_${active[0].id}_${chatId}` },
                { text: 'Ні, залишити', callback_data: 'keep' }
              ]]
            }
          });
          return true;
        }
        // Кілька записів — показуємо вибір
        const keyboard = active.map(b => [{
          text: `${fmtDate(b.date)} ${b.time} — ${(b.services||'').split(',')[0]}`,
          callback_data: `pick_cancel_${b.id}_${chatId}`
        }]);
        bot.sendMessage(chatId, 'Оберіть запис для скасування:', {
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch(e) {
        bot.sendMessage(chatId, 'Скасувати запис?', {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Так, скасувати', callback_data: `cancel_${chatId}` },
              { text: 'Ні, залишити', callback_data: 'keep' }
            ]]
          }
        });
      }
    }
    return true;
  }

  if (text.includes('язатись') || text.includes('майстром')) {
    bot.sendMessage(chatId,
      'Зв\'язатись з майстром Інною:\n\nTelegram: @Ideals_i\nТелефон: +380631562600\n\nПишіть або телефонуйте!',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Написати в Telegram', url: 'https://t.me/Ideals_i' }
          ]]
        }
      }
    );
    return true;
  }

  return false;
}

// Message handler
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const isMenuButton = await handleMenuButton(msg);
  if (isMenuButton) return;

  const state = userState[chatId];

  if (state && state.step === 'waiting_code') {
    const code = text.trim().toUpperCase();
    if (code.startsWith('IDEALS-')) {
      linkClient(chatId, code, msg);
    } else {
      bot.sendMessage(chatId, 'Невірний код. Введіть код у форматі IDEALS-XXXX');
    }
    return;
  }

  if (state && state.step === 'reschedule_date') {
    let newDate = text.trim();
    const dateMatch = newDate.match(/^(\d{1,2})\.(\d{1,2})$/);
    if (dateMatch) {
      const year = new Date().getFullYear();
      const month = dateMatch[2].padStart(2, '0');
      const day = dateMatch[1].padStart(2, '0');
      newDate = `${year}-${month}-${day}`;
    }
    userState[chatId].data.newDate = newDate;
    userState[chatId].step = 'reschedule_time';
    bot.sendMessage(chatId, 'Введіть бажаний час (наприклад: 14:00)');
    // bookingId зберігається в userState[chatId].data.bookingId
    return;
  }

  if (state && state.step === 'reschedule_time') {
    const time = text.trim();
    const client = await findClient(chatId);
    const newDate = userState[chatId].data.newDate;

    // Перевіряємо чи слот вільний
    if (db) {
      try {
        // Перевіряємо вихідні дні
        const settingsDoc = await db.collection('settings').doc('dayoffs').get();
        const specificDoc = await db.collection('settings').doc('specificDaysOff').get();
        const regularDaysOff = settingsDoc.exists ? (settingsDoc.data().days || []) : [];
        const specificDaysOff = specificDoc.exists ? (specificDoc.data().dates || []).map(d => d.date) : [];

        // Перевіряємо день тижня
        const DN_UA = ['Понеділок','Вівторок','Середа','Четвер','П\'ятниця','Субота','Неділя'];
        const dayObj = new Date(newDate + 'T00:00:00');
        const dayName = DN_UA[(dayObj.getDay()+6)%7];

        if(regularDaysOff.includes(dayName) || specificDaysOff.includes(newDate)) {
          bot.sendMessage(chatId, `❌ ${fmtDate(newDate)} — вихідний день.\n\nВведіть іншу дату (ДД.ММ):`);
          userState[chatId].step = 'reschedule_date';
          return;
        }

        // Перевіряємо чи слот вільний
        const snap = await db.collection('bookings')
          .where('date', '==', newDate)
          .where('time', '==', time)
          .where('status', '!=', 'cancelled')
          .get();
        if (!snap.empty) {
          bot.sendMessage(chatId, `❌ На жаль, ${fmtDate(newDate)} о ${time} вже зайнято.\n\nВведіть іншу дату (ДД.ММ):`);
          userState[chatId].step = 'reschedule_date';
          return;
        }
      } catch(e) { console.log('Slot check error:', e.message); }
    }

    bot.sendMessage(MASTER_ID,
      '🔄 Запит на перенесення\n\n👤 ' + (client ? client.name : 'Клієнт') + '\n📱 ' + (client ? client.phone : '—') + '\n📅 Нова дата: ' + newDate + '\n⏰ Новий час: ' + time,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Підтвердити', callback_data: `res_ok_${chatId}_${newDate}_${time}` },
            { text: 'Відхилити', callback_data: `res_no_${chatId}` }
          ]]
        }
      }
    );
    bot.sendMessage(chatId, 'Запит надіслано! Майстер розгляне і повідомить вас.');
    delete userState[chatId];
    return;
  }
});

// Callback handler
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;

  if (data.startsWith('confirm_')) {
    const firebaseId = data.replace('confirm_', '');
    bot.editMessageText('Запис підтверджено', { chat_id: chatId, message_id: query.message.message_id });
    if (db && firebaseId !== 'none') {
      try { await db.collection('bookings').doc(firebaseId).update({ status: 'confirmed' }); } catch(e) {}
    }
  }

  if (data.startsWith('reject_')) {
    const firebaseId = data.replace('reject_', '');
    bot.editMessageText('Запис відхилено', { chat_id: chatId, message_id: query.message.message_id });
    if (db && firebaseId !== 'none') {
      try { await db.collection('bookings').doc(firebaseId).update({ status: 'cancelled' }); } catch(e) {}
    }
  }

  if (data.startsWith('res_ok_')) {
    const parts = data.split('_');
    const clientChatId = parseInt(parts[2]);
    const newDate = parts[3];
    const newTime = parts[4];
    bot.editMessageText('Перенесення підтверджено: ' + newDate + ' о ' + newTime, { chat_id: chatId, message_id: query.message.message_id });
    bot.sendMessage(clientChatId, '🔄 Ваш запис перенесено!\n\n📅 ' + fmtDate(newDate) + ' о ' + newTime + '\n\nЧекаємо вас! 🌸');
    if (db) {
      try {
        // Якщо є конкретний bookingId — оновлюємо тільки його
        const bookingId = userState[clientChatId] && userState[clientChatId].data && userState[clientChatId].data.bookingId;
        if (bookingId) {
          await db.collection('bookings').doc(bookingId).update({ date: newDate, time: newTime, status: 'confirmed' });
        } else {
          const clientDoc = await db.collection('telegramClients').doc(String(clientChatId)).get();
          if (clientDoc.exists) {
            const code = clientDoc.data().code;
            const snap = await db.collection('bookings').where('code', '==', code).where('status', '!=', 'cancelled').get();
            const firstDoc = snap.docs[0];
            if (firstDoc) await db.collection('bookings').doc(firstDoc.id).update({ date: newDate, time: newTime, status: 'confirmed' });
          }
        }
      } catch(e) { console.log('Reschedule Firebase error:', e.message); }
    }
  }

  if (data.startsWith('res_no_')) {
    const clientChatId = parseInt(data.split('_')[2]);
    bot.editMessageText('Перенесення відхилено', { chat_id: chatId, message_id: query.message.message_id });
    if (clientChatId) bot.sendMessage(clientChatId, 'На жаль, перенесення неможливе. Зв\'яжіться з майстром.');
  }

  if (data.startsWith('cancel_')) {
    const clientChatId = parseInt(data.split('_')[1]);
    bot.editMessageText('Запис скасовано', { chat_id: chatId, message_id: query.message.message_id });
    bot.sendMessage(clientChatId, '✅ Ваш запис скасовано. До зустрічі! 🌸');
    bot.sendMessage(MASTER_ID, '⚠️ Клієнт скасував запис');
    if (db) {
      try {
        const clientDoc = await db.collection('telegramClients').doc(String(clientChatId)).get();
        if (clientDoc.exists) {
          const code = clientDoc.data().code;
          const snap = await db.collection('bookings').where('code', '==', code).where('status', '!=', 'cancelled').get();
          for (const doc of snap.docs) {
            await db.collection('bookings').doc(doc.id).update({ status: 'cancelled' });
          }
        }
      } catch(e) { console.log('Cancel Firebase error:', e.message); }
    }
  }

  if (data === 'keep') {
    bot.editMessageText('Запис залишено!', { chat_id: chatId, message_id: query.message.message_id });
  }

  // Вибір конкретного запису для перенесення
  if (data.startsWith('pick_reschedule_')) {
    const bookingId = data.replace('pick_reschedule_', '');
    bot.editMessageText('Введіть нову дату у форматі ДД.ММ\nНаприклад: 15.07', { chat_id: chatId, message_id: query.message.message_id });
    userState[chatId] = { step: 'reschedule_date', data: { bookingId } };
  }

  // Вибір конкретного запису для скасування
  if (data.startsWith('pick_cancel_')) {
    const parts = data.split('_');
    const bookingId = parts[2];
    const clientChatId = parseInt(parts[3]);
    if (db) {
      try {
        const bookingDoc = await db.collection('bookings').doc(bookingId).get();
        if (bookingDoc.exists) {
          const b = bookingDoc.data();
          bot.editMessageText('Скасувати запис ' + fmtDate(b.date) + ' о ' + b.time + '?', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: {
              inline_keyboard: [[
                { text: 'Так, скасувати', callback_data: `cancel_booking_${bookingId}_${clientChatId}` },
                { text: 'Ні, залишити', callback_data: 'keep' }
              ]]
            }
          });
        }
      } catch(e) {}
    }
  }

  // Скасування конкретного запису
  if (data.startsWith('cancel_booking_')) {
    const parts = data.split('_');
    const bookingId = parts[2];
    const clientChatId = parseInt(parts[3]);
    bot.editMessageText('Запис скасовано', { chat_id: chatId, message_id: query.message.message_id });
    bot.sendMessage(clientChatId, '✅ Ваш запис скасовано. До зустрічі! 🌸');
    bot.sendMessage(MASTER_ID, '⚠️ Клієнт скасував запис');
    if (db) {
      try {
        await db.collection('bookings').doc(bookingId).update({ status: 'cancelled' });
      } catch(e) { console.log('Cancel error:', e.message); }
    }
  }

  bot.answerCallbackQuery(query.id);
});

// Master commands
bot.onText(/\/today/, (msg) => {
  if (msg.chat.id !== MASTER_ID) return;
  bot.sendMessage(MASTER_ID, 'Адмін-панель:\nhttps://ideals-nail.web.app/admin.html');
});
bot.onText(/\/bookings/, (msg) => {
  if (msg.chat.id !== MASTER_ID) return;
  bot.sendMessage(MASTER_ID, 'Адмін-панель:\nhttps://ideals-nail.web.app/admin.html');
});
bot.onText(/\/stats/, (msg) => {
  if (msg.chat.id !== MASTER_ID) return;
  bot.sendMessage(MASTER_ID, 'Клієнтів у боті: ' + Object.keys(clients).length + '\n\nhttps://ideals-nail.web.app/admin.html');
});
bot.onText(/\/newcode/, async (msg) => {
  const chatId = msg.chat.id;
  delete clients[String(chatId)];
  if (db) {
    try { await db.collection('telegramClients').doc(String(chatId)).delete(); } catch(e) {}
  }
  userState[chatId] = { step: 'waiting_code' };
  bot.sendMessage(chatId, 'Введіть ваш новий код IDEALS-XXXX:');
});

// API
app.post('/new-booking', (req, res) => {
  const booking = req.body;
  const clientType = booking.clientType === 'new' ? 'Новий клієнт (з передоплатою)' : 'Постійний клієнт';
  bot.sendMessage(MASTER_ID,
    '🌸 Новий запис!\n\n' +
    '👤 ' + booking.name + '\n' +
    '📱 ' + booking.phone + '\n' +
    '💅 ' + booking.services + '\n' +
    '📅 ' + fmtDate(booking.date) + ', ' + booking.time + '\n' +
    '⏱ ' + booking.duration + '\n' +
    '💰 ' + booking.price + ' грн\n' +
    clientType + '\n' +
    '🔑 Код: ' + booking.code,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Підтвердити', callback_data: `confirm_${booking.id || 'none'}` },
          { text: 'Відхилити', callback_data: `reject_${booking.id || 'none'}` }
        ]]
      }
    }
  );
  res.json({ success: true });
});

app.post('/notify-client', async (req, res) => {
  const { bookingId, type, date, time } = req.body;
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
      bot.sendMessage(clientChatId, '✅ Ваш запис підтверджено! 🌸\n\nЧекаємо вас!');
    } else if (type === 'cancelled') {
      bot.sendMessage(clientChatId, '❌ На жаль, ваш запис скасовано майстром.\n\nДля нового запису: https://ideals-nail.web.app 🌸');
    } else if (type === 'rescheduled') {
      bot.sendMessage(clientChatId, '🔄 Ваш запис перенесено! \n\n📅 ' + fmtDate(date) + ' о ' + time + '\n\nЧекаємо вас! 🌸');
    }
  }
  res.json({ success: true, notified: !!clientChatId });
});

app.get('/', (req, res) => res.send('Ideals Bot is running!'));
app.listen(PORT, () => console.log('Server on port ' + PORT));
console.log('Bot started!');

// ===== НАГАДУВАННЯ =====
const sentReminders = new Set(); // щоб не надсилати двічі

async function checkReminders() {
  if (!db) return;
  try {
    const now = new Date();
    const snap = await db.collection('bookings').get();

    for (const docSnap of snap.docs) {
      const b = docSnap.data();
      if (!b.date || !b.time) continue;
      if (b.status === 'cancelled') continue;

      const bookingTime = new Date(b.date + 'T' + b.time + ':00');
      const diffMs = bookingTime - now;
      const diffMin = diffMs / 60000;

      // За 24 години (між 23:30 і 24:30 тобто 1410-1470 хв)
      const key24 = docSnap.id + '_24h';
      if (diffMin > 1290 && diffMin < 1650 && !sentReminders.has(key24)) {
        sentReminders.add(key24);
        const dateStr = b.date.split('-').reverse().slice(0,2).join('.');

        // Клієнту
        try {
          const clientSnap = await db.collection('telegramClients').where('code', '==', b.code).get();
          if (!clientSnap.empty) {
            const clientId = clientSnap.docs[0].data().telegramId;
            bot.sendMessage(clientId,
              `🔔 Нагадування!\n\n📅 Завтра о ${b.time} — ${b.services}\n\nЧекаємо вас! 🌸`
            );
          }
        } catch(e) {}



        console.log('Reminder 24h sent:', b.name, b.date, b.time);
      }

      // За 1.5 години (між 80 і 100 хв)
      const key15 = docSnap.id + '_1.5h';
      if (diffMin > 70 && diffMin < 100 && !sentReminders.has(key15)) {
        sentReminders.add(key15);

        // Клієнту
        try {
          const clientSnap = await db.collection('telegramClients').where('code', '==', b.code).get();
          if (!clientSnap.empty) {
            const clientId = clientSnap.docs[0].data().telegramId;
            bot.sendMessage(clientId,
              `⏰ Нагадування!\n\nЧерез 1.5 години о ${b.time} — ${b.services}\n\nДо зустрічі! 🌸`
            );
          }
        } catch(e) {}



        console.log('Reminder 1.5h sent:', b.name, b.date, b.time);
      }
    }
  } catch(e) {
    console.log('Reminder check error:', e.message);
  }
}

// Перевіряємо кожні 30 хвилин
setInterval(checkReminders, 30 * 60 * 1000);
// І одразу при старті
setTimeout(checkReminders, 10000);
