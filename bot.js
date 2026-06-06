const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// ==========================================
// НАЛАШТУВАННЯ
// ==========================================
const TOKEN = '8983487603:AAEKlidCC7AJGrhIKmYD3U-CTYxvd4vhG9A';
const MASTER_ID = 1199443187; // Telegram ID майстра
const MASTER_PASSWORD = 'ideals_master'; // пароль для майстра в боті
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();
app.use(express.json());

// ==========================================
// БАЗА ДАНИХ (в пам'яті, потім замінимо на Firebase)
// ==========================================
let bookings = []; // всі записи
let clients = {}; // { telegramId: { name, phone, bookingCode } }
let pendingCodes = {}; // { code: bookingData } — очікують прив'язки

// ==========================================
// СТАН РОЗМОВИ
// ==========================================
let userState = {}; // { telegramId: { step, data } }

// ==========================================
// УТИЛІТИ
// ==========================================
const MN = ['січ','лют','бер','кві','тра','чер','лип','сер','вер','жов','лис','гру'];
function fmtDate(d) {
  const dt = new Date(d);
  return `${dt.getDate()} ${MN[dt.getMonth()]} о ${dt.toTimeString().slice(0,5)}`;
}
const usedCodes = new Set();
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

// ==========================================
// КОМАНДА /start
// ==========================================
bot.onText(/\/start(.*)/, (msg, match) => {
  const chatId = msg.chat.id;
  const param = match[1].trim();

  // Якщо прийшов з параметром (посилання типу t.me/bot?start=IDEALS-1234)
  if (param && param.startsWith('IDEALS-')) {
    linkClient(chatId, param, msg);
    return;
  }

  // Перевіряємо чи це майстер
  if (chatId === MASTER_ID) {
    bot.sendMessage(chatId,
      `👑 *Вітаємо, майстре!*\n\nВи увійшли як адміністратор.\n\n` +
      `Доступні команди:\n` +
      `/bookings — всі активні записи\n` +
      `/today — записи на сьогодні\n` +
      `/stats — статистика`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Звичайний клієнт
  const isKnown = Object.values(clients).find(c => c.telegramId === chatId);
  if (isKnown) {
    showClientMenu(chatId, isKnown);
    return;
  }

  bot.sendMessage(chatId,
    `🌸 *Вітаємо в Ideals Nail Studio!*\n\n` +
    `Щоб прив'язати ваш запис, введіть код який отримали від майстра.\n\n` +
    `Код виглядає так: *IDEALS-1234*`,
    { parse_mode: 'Markdown' }
  );
  userState[chatId] = { step: 'waiting_code' };
});

// ==========================================
// ОБРОБКА ПОВІДОМЛЕНЬ
// ==========================================
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  const state = userState[chatId];

  // Клієнт вводить код
  if (state && state.step === 'waiting_code') {
    const code = text.trim().toUpperCase();
    if (code.startsWith('IDEALS-')) {
      linkClient(chatId, code, msg);
    } else {
      bot.sendMessage(chatId, `❌ Невірний формат коду. Код має виглядати як *IDEALS-1234*`, { parse_mode: 'Markdown' });
    }
    return;
  }

  // Клієнт вводить нову дату для перенесення
  if (state && state.step === 'reschedule_date') {
    userState[chatId].data.newDate = text;
    userState[chatId].step = 'reschedule_time';
    bot.sendMessage(chatId,
      `⏰ Тепер введіть бажаний час (наприклад: *14:00*)`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (state && state.step === 'reschedule_time') {
    const time = text.trim();
    const bookingId = state.data.bookingId;
    const newDate = state.data.newDate;
    const client = Object.values(clients).find(c => c.telegramId === chatId);

    // Надсилаємо запит майстру
    bot.sendMessage(MASTER_ID,
      `🔄 *Запит на перенесення*\n\n` +
      `👤 Клієнт: ${client ? client.name : 'Невідомий'}\n` +
      `📱 Телефон: ${client ? client.phone : '—'}\n` +
      `📅 Нова дата: ${newDate}\n` +
      `⏰ Новий час: ${time}\n` +
      `🔑 Код: ${client ? client.code : '—'}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Підтвердити', callback_data: `reschedule_ok_${chatId}_${newDate}_${time}` },
            { text: '❌ Відхилити', callback_data: `reschedule_no_${chatId}` }
          ]]
        }
      }
    );

    bot.sendMessage(chatId,
      `✅ *Запит надіслано!*\n\nМайстер розгляне ваш запит на перенесення на ${newDate} о ${time} і повідомить вас.`,
      { parse_mode: 'Markdown' }
    );
    delete userState[chatId];
    return;
  }
});

// ==========================================
// ПРИВ'ЯЗКА КЛІЄНТА ДО КОДУ
// ==========================================
function linkClient(chatId, code, msg) {
  const booking = pendingCodes[code];

  if (!booking) {
    // Демо режим — приймаємо будь-який валідний код
    const name = msg.from.first_name || 'Клієнт';
    clients[code] = {
      telegramId: chatId,
      name: name,
      phone: '—',
      code: code
    };
    delete userState[chatId];

    bot.sendMessage(chatId,
      `✅ *Чудово, ${name}!*\n\n` +
      `Ваш обліковий запис прив'язано до коду *${code}*.\n\n` +
      `Тепер ви будете отримувати:\n` +
      `• Підтвердження записів\n` +
      `• Нагадування за день до візиту\n` +
      `• Повідомлення про зміни`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            ['📅 Мої записи'],
            ['🔄 Перенести запис', '❌ Скасувати запис'],
            ['📞 Зв\'язатись з майстром']
          ],
          resize_keyboard: true
        }
      }
    );

    // Повідомляємо майстра
    bot.sendMessage(MASTER_ID,
      `🔗 *Клієнт прив'язав код*\n\n` +
      `👤 ${name}\n` +
      `🔑 Код: ${code}\n` +
      `💬 Telegram: @${msg.from.username || 'без username'}`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Прив'язуємо до реального запису
  clients[code] = {
    telegramId: chatId,
    name: booking.name,
    phone: booking.phone,
    code: code,
    bookingId: booking.id
  };
  delete pendingCodes[code];
  delete userState[chatId];

  bot.sendMessage(chatId,
    `✅ *${booking.name}, ваш запис прив'язано!*\n\n` +
    `📅 ${fmtDate(booking.date)}\n` +
    `💅 ${booking.service}\n\n` +
    `Тепер ви будете отримувати нагадування і повідомлення про статус запису.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['📅 Мої записи'],
          ['🔄 Перенести запис', '❌ Скасувати запис'],
          ['📞 Зв\'язатись з майстром']
        ],
        resize_keyboard: true
      }
    }
  );
}

// ==========================================
// МЕНЮ КЛІЄНТА
// ==========================================
function showClientMenu(chatId, client) {
  bot.sendMessage(chatId,
    `🌸 *Вітаємо, ${client.name}!*\n\nОберіть дію:`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        keyboard: [
          ['📅 Мої записи'],
          ['🔄 Перенести запис', '❌ Скасувати запис'],
          ['📞 Зв\'язатись з майстром']
        ],
        resize_keyboard: true
      }
    }
  );
}

// ==========================================
// КНОПКИ МЕНЮ КЛІЄНТА
// ==========================================
bot.onText(/📅 Мої записи/, (msg) => {
  const chatId = msg.chat.id;
  const client = Object.values(clients).find(c => c.telegramId === chatId);
  if (!client) { bot.sendMessage(chatId, 'Спочатку введіть ваш код IDEALS-XXXX'); return; }

  const myBookings = bookings.filter(b => b.clientCode === client.code && b.status !== 'cancelled');
  if (!myBookings.length) {
    bot.sendMessage(chatId, `📅 *Активних записів немає*\n\nЗапишіться на сайті: ideals-nail.com`, { parse_mode: 'Markdown' });
    return;
  }
  const text = myBookings.map(b => `• ${fmtDate(b.date)} — ${b.service}`).join('\n');
  bot.sendMessage(chatId, `📅 *Ваші записи:*\n\n${text}`, { parse_mode: 'Markdown' });
});

bot.onText(/🔄 Перенести запис/, (msg) => {
  const chatId = msg.chat.id;
  const client = Object.values(clients).find(c => c.telegramId === chatId);
  if (!client) { bot.sendMessage(chatId, 'Спочатку введіть ваш код IDEALS-XXXX'); return; }

  userState[chatId] = { step: 'reschedule_date', data: { bookingId: client.bookingId } };
  bot.sendMessage(chatId,
    `📅 *Перенесення запису*\n\nВведіть бажану нову дату\n(наприклад: *15 липня*)`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/❌ Скасувати запис/, (msg) => {
  const chatId = msg.chat.id;
  const client = Object.values(clients).find(c => c.telegramId === chatId);
  if (!client) { bot.sendMessage(chatId, 'Спочатку введіть ваш код IDEALS-XXXX'); return; }

  bot.sendMessage(chatId,
    `❌ *Ви впевнені що хочете скасувати запис?*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Так, скасувати', callback_data: `cancel_booking_${chatId}` },
          { text: 'Ні, залишити', callback_data: 'keep_booking' }
        ]]
      }
    }
  );
});

bot.onText(/📞 Зв'язатись з майстром/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `📞 *Зв'язок з майстром*\n\nTelegram: @ideals_nail\n\nПишіть якщо є запитання! 🌸`,
    { parse_mode: 'Markdown' }
  );
});

// ==========================================
// КОМАНДИ МАЙСТРА
// ==========================================
bot.onText(/\/bookings/, (msg) => {
  if (msg.chat.id !== MASTER_ID) return;
  const active = bookings.filter(b => b.status !== 'cancelled');
  if (!active.length) { bot.sendMessage(MASTER_ID, '📅 Активних записів немає'); return; }
  const text = active.map(b => `• ${fmtDate(b.date)} — ${b.name} — ${b.service}`).join('\n');
  bot.sendMessage(MASTER_ID, `📅 *Активні записи:*\n\n${text}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/today/, (msg) => {
  if (msg.chat.id !== MASTER_ID) return;
  const today = new Date(); today.setHours(0,0,0,0);
  const todayBookings = bookings.filter(b => {
    const d = new Date(b.date); d.setHours(0,0,0,0);
    return d.getTime() === today.getTime() && b.status !== 'cancelled';
  }).sort((a,b) => a.time > b.time ? 1 : -1);

  if (!todayBookings.length) { bot.sendMessage(MASTER_ID, '📅 Сьогодні записів немає'); return; }
  const text = todayBookings.map(b => `• ${b.time} — ${b.name} (${b.phone}) — ${b.service}`).join('\n');
  bot.sendMessage(MASTER_ID, `📅 *Записи на сьогодні:*\n\n${text}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/stats/, (msg) => {
  if (msg.chat.id !== MASTER_ID) return;
  const active = bookings.filter(b => b.status !== 'cancelled');
  const rev = active.reduce((s,b) => s + (b.price || 0), 0);
  bot.sendMessage(MASTER_ID,
    `📊 *Статистика:*\n\n` +
    `Всього записів: ${active.length}\n` +
    `Клієнтів у боті: ${Object.keys(clients).length}\n` +
    `Виручка: ${rev.toLocaleString()} ₴`,
    { parse_mode: 'Markdown' }
  );
});

// ==========================================
// CALLBACK КНОПКИ
// ==========================================
bot.on('callback_query', (query) => {
  const data = query.data;
  const chatId = query.message.chat.id;

  // Підтвердити запис
  if (data.startsWith('confirm_')) {
    const bookingId = parseInt(data.split('_')[1]);
    const booking = bookings.find(b => b.id === bookingId);
    if (booking) {
      booking.status = 'confirmed';
      bot.editMessageText(
        `✅ *Запис підтверджено*\n\n👤 ${booking.name}\n📅 ${fmtDate(booking.date)}\n💅 ${booking.service}`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
      // Сповіщаємо клієнта
      const client = Object.values(clients).find(c => c.bookingId === bookingId);
      if (client) {
        bot.sendMessage(client.telegramId,
          `✅ *Ваш запис підтверджено!*\n\n📅 ${fmtDate(booking.date)}\n💅 ${booking.service}\n\n💳 Не забудьте про передоплату 300 ₴ — реквізити надішле майстер.`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  }

  // Відхилити запис
  if (data.startsWith('reject_')) {
    const bookingId = parseInt(data.split('_')[1]);
    const booking = bookings.find(b => b.id === bookingId);
    if (booking) {
      booking.status = 'cancelled';
      bot.editMessageText(
        `❌ *Запис відхилено*\n\n👤 ${booking.name}\n📅 ${fmtDate(booking.date)}`,
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
      const client = Object.values(clients).find(c => c.bookingId === bookingId);
      if (client) {
        bot.sendMessage(client.telegramId,
          `❌ *На жаль, ваш запис не підтверджено.*\n\nЦей час недоступний. Будь ласка, оберіть інший час на сайті.`,
          { parse_mode: 'Markdown' }
        );
      }
    }
  }

  // Підтвердити перенесення
  if (data.startsWith('reschedule_ok_')) {
    const parts = data.split('_');
    const clientChatId = parseInt(parts[2]);
    const newDate = parts[3];
    const newTime = parts[4];
    bot.editMessageText(
      `✅ Перенесення підтверджено: ${newDate} о ${newTime}`,
      { chat_id: chatId, message_id: query.message.message_id }
    );
    bot.sendMessage(clientChatId,
      `✅ *Запис перенесено!*\n\n📅 ${newDate} о ${newTime}\n\nЧекаємо вас! 🌸`,
      { parse_mode: 'Markdown' }
    );
  }

  // Відхилити перенесення
  if (data === 'reschedule_no_' || data.startsWith('reschedule_no_')) {
    const clientChatId = parseInt(data.split('_')[2]);
    bot.editMessageText(
      `❌ Перенесення відхилено`,
      { chat_id: chatId, message_id: query.message.message_id }
    );
    if (clientChatId) {
      bot.sendMessage(clientChatId,
        `❌ *На жаль, перенесення неможливе.*\n\nОберіть інший час або зв'яжіться з майстром.`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  // Скасування запису клієнтом
  if (data.startsWith('cancel_booking_')) {
    const clientChatId = parseInt(data.split('_')[2]);
    const client = Object.values(clients).find(c => c.telegramId === clientChatId);
    bot.editMessageText('✅ Запис скасовано', { chat_id: chatId, message_id: query.message.message_id });
    bot.sendMessage(clientChatId, '✅ Ваш запис скасовано. До зустрічі наступного разу! 🌸');
    // Повідомляємо майстра
    bot.sendMessage(MASTER_ID,
      `⚠️ *Клієнт скасував запис*\n\n👤 ${client ? client.name : 'Невідомий'}`,
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'keep_booking') {
    bot.editMessageText('👍 Запис залишено!', { chat_id: chatId, message_id: query.message.message_id });
  }

  bot.answerCallbackQuery(query.id);
});

// ==========================================
// API ДЛЯ САЙТУ
// Сайт надсилає запис сюди → бот повідомляє майстра
// ==========================================
app.post('/new-booking', (req, res) => {
  const booking = req.body;
  const code = generateCode();
  booking.id = Date.now();
  booking.status = 'pending';
  booking.code = code;
  bookings.push(booking);
  pendingCodes[code] = booking;

  // Повідомляємо майстра
  bot.sendMessage(MASTER_ID,
    `🌸 *Новий запис!*\n\n` +
    `👤 ${booking.name}\n` +
    `📱 ${booking.phone}\n` +
    `💅 ${booking.services}\n` +
    `📅 ${booking.date} о ${booking.time}\n` +
    `⏱ Тривалість: ${booking.duration}\n` +
    `💰 Сума: ${booking.price} ₴\n` +
    `🔑 Код: *${code}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Підтвердити', callback_data: `confirm_${booking.id}` },
          { text: '❌ Відхилити', callback_data: `reject_${booking.id}` }
        ]]
      }
    }
  );

  res.json({ success: true, code });
});

// ==========================================
// НАГАДУВАННЯ (запускається кожну годину)
// ==========================================
setInterval(() => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  bookings.forEach(booking => {
    if (booking.status !== 'confirmed' || booking.reminderSent) return;
    const bookingDate = new Date(booking.date);
    const diff = bookingDate.getTime() - now.getTime();
    const hours = diff / (1000 * 60 * 60);

    if (hours > 20 && hours < 26) {
      const client = Object.values(clients).find(c => c.code === booking.code);
      if (client) {
        bot.sendMessage(client.telegramId,
          `🌸 *Нагадування!*\n\nЗавтра о ${booking.time} у вас ${booking.services}.\n\nЧекаємо вас в Ideals! 💅`,
          { parse_mode: 'Markdown' }
        );
        booking.reminderSent = true;
      }
      // Нагадування майстру
      bot.sendMessage(MASTER_ID,
        `⏰ *Нагадування на завтра:*\n\n👤 ${booking.name}\n⏰ ${booking.time}\n💅 ${booking.services}`,
        { parse_mode: 'Markdown' }
      );
    }
  });
}, 60 * 60 * 1000); // кожну годину

// ==========================================
// СЕРВЕР
// ==========================================
app.get('/', (req, res) => res.send('Ideals Bot is running 🌸'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

console.log('🌸 Ideals Bot запущено!');
