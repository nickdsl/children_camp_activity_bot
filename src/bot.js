process.env.NTBA_FIX_350 = '1'; // Buffer + filename for sendDocument/sendPhoto etc.
const TelegramBot = require('node-telegram-bot-api');
const {
  getDepartments,
  getDepartmentSlotsWithAvailability,
  getSlotLabel,
  getRegistrationByUserId,
  getRegistrationsGroupedByDepartment,
  updateRegistrationUsername,
  deleteRegistration,
  loadRegistrations,
  addDepartment,
  updateDepartment,
  deleteDepartment,
  registerChild,
  validateAndImportDepartments,
  parseAndImportDepartments,
  analyzeImportImpact,
  applyImport,
  getAvailableSlotsForReregister,
  replaceBrokenSlotWithNew,
  getRegistrationsExportRows,
  getDepartmentsExportCSV,
  getCommandLabels,
  setCommandLabel,
  getMessageTemplate,
  setMessageTemplate,
  getAllMessageTemplates,
  MESSAGE_TEMPLATE_KEYS,
  MESSAGE_TEMPLATE_LABELS,
  DEFAULT_MESSAGE_TEMPLATES,
  COMMAND_KEYS,
  DEFAULT_COMMAND_LABELS,
  slotKey,
  MAX_CHOICES_PER_CHILD,
  SLOT_COUNT,
} = require('./data/store');
const https = require('https');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const os = require('os');

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Missing BOT_TOKEN in environment');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const MAX_DESC_LENGTH = 4000;
const ADMIN_COMMAND = (process.env.ADMIN_COMMAND || '').trim() || null;
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim() || null;
const ADMIN_SESSION_MINUTES = 60;
const adminSessions = new Map(); // userId -> expiry timestamp

function isAdmin(userId) {
  const exp = adminSessions.get(userId);
  if (!exp) return false;
  if (Date.now() > exp) {
    adminSessions.delete(userId);
    return false;
  }
  return true;
}

function setAdminSession(userId) {
  adminSessions.set(userId, Date.now() + ADMIN_SESSION_MINUTES * 60 * 1000);
}

function clearAdminSession(userId) {
  adminSessions.delete(userId);
}

const adminMenuKeyboard = {
  inline_keyboard: [
    [{ text: '📋 Список по направлениям', callback_data: 'admin_list' }],
    [{ text: '👤 Выбрать ребёнка', callback_data: 'admin_select_child' }],
    [{ text: '📁 Управление направлениями', callback_data: 'admin_depts_menu' }],
    [{ text: '📤 Выгрузить направления', callback_data: 'admin_export_depts' }],
    [{ text: '📥 Импорт направлений', callback_data: 'admin_import_depts' }],
    [{ text: '📊 Выгрузить регистрации', callback_data: 'admin_export_regs' }],
    [{ text: '⚙️ Настроить команды', callback_data: 'admin_commands_menu' }],
    [{ text: '✉️ Шаблоны сообщений', callback_data: 'admin_templates_menu' }],
    [{ text: '🔄 Сброс настроек', callback_data: 'admin_reset_menu' }],
    [{ text: '🚪 Выход', callback_data: 'admin_exit' }],
  ],
};

/** Только кнопки пользователя (без админки). */
function getUserReplyKeyboard() {
  const labels = getCommandLabels();
  const buttons = COMMAND_KEYS.map((k) => labels[k] || k);
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

/** Внизу в режиме админа — только две кнопки (все команды через inline-меню). */
const ADMIN_REPLY_BUTTONS = ['⚙️ Команды администратора', '🚪 Выход из администрирования'];

function getAdminReplyKeyboard() {
  const rows = ADMIN_REPLY_BUTTONS.map((label) => [label]);
  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

/** Клавиатура: в режиме админа — только админ-кнопки, иначе — только пользовательские. */
function getMainMenuReplyKeyboard(userId) {
  if (userId && isAdmin(userId)) return getAdminReplyKeyboard();
  return getUserReplyKeyboard();
}

/** Триггеры команд (как в onText): строка без / совпадает с одной из этих — считаем командой. */
const COMMAND_TRIGGERS = {
  start: ['start', 'начать'],
  departments: ['departments', 'направления'],
  about: ['about', 'описание', 'описания'],
  my: ['my', 'мое'],
  unsubscribe: ['unsubscribe', 'отменить'],
  subscribe: ['subscribe', 'выбрать', 'регистрация'],
};

/** По тексту сообщения вернуть ключ команды, если это нажатие кнопки (русское название). */
function getCommandKeyByLabel(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const labels = getCommandLabels();
  for (const key of COMMAND_KEYS) {
    if (labels[key] === trimmed) return key;
  }
  return null;
}

/** Проверка: строка без / — это известная команда? (добавляем / и сравниваем с триггерами.) */
function getCommandKeyByTrigger(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  for (const key of COMMAND_KEYS) {
    const triggers = COMMAND_TRIGGERS[key];
    if (triggers && triggers.some((t) => t.toLowerCase() === normalized)) return key;
  }
  return null;
}

function sendAdminMenu(chatId, userId) {
  bot.sendMessage(chatId, '🔐 Режим администратора', { reply_markup: adminMenuKeyboard });
  bot.sendMessage(chatId, '📌 Кнопки внизу — админ-меню:', getAdminReplyKeyboard());
}

// Conversation state: { userId -> { step, camp?, squad?, selectedSlots? } } — selectedSlots: [{ departmentId, slotIndex }]
const userState = new Map();

function getState(userId) {
  if (!userState.has(userId)) {
    userState.set(userId, { step: 'idle' });
  }
  return userState.get(userId);
}

function setState(userId, state) {
  userState.set(userId, { ...getState(userId), ...state });
}

function clearState(userId) {
  userState.delete(userId);
}

/** Ответ на callback_query без падения при устаревшем/невалидном query (например после перезапуска бота). */
function answerCallbackQuerySafe(queryId, options) {
  bot.answerCallbackQuery(queryId, options).catch((err) => {
    const msg = String((err && err.message) || '');
    if (msg.includes('query is too old') || msg.includes('query ID is invalid') || (err && err.code === 'ETELEGRAM')) {
      return;
    }
    console.error('answerCallbackQuery error:', err);
  });
}

/** Редактирование сообщения; при «message is not modified» возвращаем false, иначе true. */
function editMessageTextSafe(text, options) {
  return bot.editMessageText(text, options).then(() => true).catch((err) => {
    if (err && err.message && err.message.includes('message is not modified')) return false;
    throw err;
  });
}

/** Escape Telegram Markdown special chars so user/department names don't break parse. */
function escapeMarkdown(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/_/g, '\\_').replace(/\*/g, '\\*').replace(/`/g, '\\`').replace(/\[/g, '\\[');
}

/** Подпись ребёнка для списков: лагерь, отряд, при наличии — никнейм. */
function formatChildLabel(reg) {
  const base = `${reg.camp || '?'} № ${reg.squad || '?'}`;
  return reg.telegramUsername ? `${base} @${reg.telegramUsername}` : base;
}

/** Убрать из выбранных слотов те, что в fullSlots (заняты). */
function dropFullSlots(selectedSlots, fullSlots) {
  if (!fullSlots || fullSlots.length === 0) return selectedSlots || [];
  const fullKeys = new Set((fullSlots || []).map((s) => slotKey(s.departmentId, s.slotIndex)));
  return (selectedSlots || []).filter((s) => !fullKeys.has(slotKey(s.departmentId, s.slotIndex)));
}

/** Format department+slot choices as one line (for short messages). */
function formatDepartmentSlotsQuoted(departmentSlots) {
  const departments = getDepartments();
  const byId = new Map(departments.map((d) => [d.id, d.name]));
  return (departmentSlots || [])
    .map(({ departmentId, slotIndex }) => {
      const name = byId.get(departmentId) || '?';
      const slot = getSlotLabel(slotIndex);
      return `«${name}» ${slot}`;
    })
    .join(', ');
}

/** Format department+slot choices as vertical list, sorted by time (earliest first). Double newline for Telegram. */
function formatDepartmentSlotsAsList(departmentSlots) {
  const departments = getDepartments();
  const byId = new Map(departments.map((d) => [d.id, d.name]));
  const sorted = (departmentSlots || []).slice().sort((a, b) => a.slotIndex - b.slotIndex);
  return sorted
    .map(({ departmentId, slotIndex }) => {
      const name = escapeMarkdown(byId.get(departmentId) || '?');
      const slot = getSlotLabel(slotIndex);
      return `▸ **«${name}»** — ${slot}`;
    })
    .join('\n\n');
}

/** Format for /start "already registered": bold name + code time for contrast. */
function formatDepartmentSlotsForStart(departmentSlots) {
  const departments = getDepartments();
  const byId = new Map(departments.map((d) => [d.id, d.name]));
  const sorted = (departmentSlots || []).slice().sort((a, b) => a.slotIndex - b.slotIndex);
  return sorted
    .map(({ departmentId, slotIndex }) => {
      const name = escapeMarkdown(byId.get(departmentId) || '?');
      const slot = getSlotLabel(slotIndex);
      return `**«${name}»** — \`${slot}\``;
    })
    .join('\n\n');
}

function formatDepartmentsList() {
  const list = getDepartmentSlotsWithAvailability();
  const byDept = new Map();
  for (const s of list) {
    if (!byDept.has(s.departmentId)) {
      byDept.set(s.departmentId, { name: s.departmentName, freeSlotCount: 0 });
    }
    if (s.hasSpace) byDept.get(s.departmentId).freeSlotCount += 1;
  }
  return [...byDept.values()]
    .map((d) => `▸ **${d.name}** (слоты: ${d.freeSlotCount}/${SLOT_COUNT})`)
    .join('\n');
}

/** Клавиатура: только направления (уже выбранные не показываем — 4 разных направления). */
function buildDepartmentKeyboard(selectedSlots) {
  const list = getDepartmentSlotsWithAvailability();
  const chosenDeptIds = new Set((selectedSlots || []).map((s) => s.departmentId));
  const byDept = new Map();
  for (const s of list) {
    if (chosenDeptIds.has(s.departmentId)) continue;
    if (!byDept.has(s.departmentId)) {
      byDept.set(s.departmentId, { name: s.departmentName, free: 0, hasAny: false });
    }
    const entry = byDept.get(s.departmentId);
    if (s.hasSpace) {
      entry.free += s.freeSlots;
      entry.hasAny = true;
    }
  }
  const rows = [];
  for (const [departmentId, entry] of byDept) {
    const label = entry.hasAny ? `📁 ${entry.name} (${entry.free} мест)` : `${entry.name} (заполнено)`;
    rows.push([{
      text: label,
      callback_data: entry.hasAny ? `pickdept_${departmentId}` : `pickdept_full_${departmentId}`,
    }]);
  }
  return { inline_keyboard: rows };
}

/** Клавиатура экрана проверки выбора (4 слота выбрано): Отмена, Изменить, Подтвердить. */
function buildConfirmChoiceKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '❌ Отмена', callback_data: 'dept_confirm_cancel' }],
      [{ text: '✏️ Изменить', callback_data: 'dept_confirm_edit' }],
      [{ text: '✅ Подтвердить запись', callback_data: 'dept_confirm_final' }],
    ],
  };
}

/** Текст сводки выбранных направлений и слотов для экрана проверки. */
function formatConfirmSummary(selectedSlots, camp, squad) {
  const deptList = formatDepartmentSlotsAsList(selectedSlots);
  return `📋 **Проверьте выбор**\n\n🏕 **Лагерь:** ${escapeMarkdown(camp)}\n👥 **№ отряда:** ${escapeMarkdown(squad)}\n\n📁 **Направления и слоты:**\n${deptList}\n\nВсё верно?`;
}

/** Клавиатура: слоты для выбранного направления (уже занятые пользователем слоты не показываем — 4 разных слота). */
function buildSlotKeyboard(departmentId, departmentName, selectedSlots) {
  const chosenSlotIndices = new Set((selectedSlots || []).map((s) => s.slotIndex));
  const list = getDepartmentSlotsWithAvailability().filter(
    (s) => s.departmentId === departmentId && s.hasSpace && !chosenSlotIndices.has(s.slotIndex)
  );
  const rows = list.map((s) => [{
    text: `🕐 ${s.slotLabel} (${s.freeSlots} мест)`,
    callback_data: `pickslot_${departmentId}_${s.slotIndex}`,
  }]);
  rows.push([{ text: '← К направлениям', callback_data: 'slot_back' }]);
  return { inline_keyboard: rows };
}

/** Клавиатура: направления, в которых свободен заданный слот. callbackPrefix: 'user_pick_new_dept_' или 'confirm_pick_dept_'. */
function buildDepartmentKeyboardForSlot(slotIndex, excludeDeptIds, callbackPrefix) {
  const prefix = callbackPrefix || 'user_pick_new_dept_';
  const exclude = new Set(excludeDeptIds || []);
  const list = getDepartmentSlotsWithAvailability().filter(
    (s) => s.slotIndex === slotIndex && s.hasSpace && !exclude.has(s.departmentId)
  );
  const byDept = new Map();
  for (const s of list) {
    if (!byDept.has(s.departmentId)) byDept.set(s.departmentId, { name: s.departmentName, free: 0 });
    byDept.get(s.departmentId).free += s.freeSlots;
  }
  const rows = [...byDept.entries()].map(([departmentId, entry]) => [
    { text: `📁 ${entry.name} (${entry.free} мест)`, callback_data: `${prefix}${departmentId}` },
  ]);
  rows.push([{ text: '← Отмена', callback_data: prefix === 'confirm_pick_dept_' ? 'dept_confirm_edit_back' : 'user_reg_edit_back' }]);
  return { inline_keyboard: rows };
}

function buildAboutKeyboard() {
  const list = getDepartments();
  const rows = [];
  for (const d of list) {
    const label = d.description ? `ℹ️ ${d.name}` : d.name;
    rows.push([{ text: label, callback_data: `desc_${d.id}` }]);
  }
  return { inline_keyboard: rows };
}

function handleStart(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const existing = getRegistrationByUserId(userId);
  clearState(userId);
  if (existing && msg.from.username) updateRegistrationUsername(userId, msg.from.username);
  let text = getMessageTemplate('start_intro');
  if (existing) {
    const nickname = existing.telegramUsername ? ` · @${escapeMarkdown(existing.telegramUsername)}` : '';
    const deptList = formatDepartmentSlotsForStart(existing.departmentSlots);
    text += getMessageTemplate('start_already_block', {
      camp: escapeMarkdown(existing.camp),
      squad: escapeMarkdown(existing.squad),
      nickname,
      deptList,
    });
  }
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...getMainMenuReplyKeyboard(msg.from.id) });
}

function handleDepartments(msg) {
  const chatId = msg.chat.id;
  const listText = formatDepartmentsList();
  const text = getMessageTemplate('departments_header', { listText });
  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '📄 Описания направлений', callback_data: 'about_list' }]] },
  });
}

function handleAbout(msg) {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, getMessageTemplate('about_choose'), {
    parse_mode: 'Markdown',
    reply_markup: buildAboutKeyboard(),
  });
}

function handleMy(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const existing = getRegistrationByUserId(userId);
  if (!existing) {
    bot.sendMessage(chatId, getMessageTemplate('my_not_registered'), {
      parse_mode: 'Markdown',
      ...getMainMenuReplyKeyboard(msg.from.id),
    });
    return;
  }
  const deptList = formatDepartmentSlotsAsList(existing.departmentSlots);
  bot.sendMessage(
    chatId,
    getMessageTemplate('my_record', {
      camp: escapeMarkdown(existing.camp),
      squad: escapeMarkdown(existing.squad),
      deptList,
    }),
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🗑 Удалить мою запись', callback_data: 'user_unsubscribe' }]] },
    }
  );
}

function handleUnsubscribe(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  clearState(userId);
  const removed = deleteRegistration(userId);
  if (removed) {
    bot.sendMessage(chatId, getMessageTemplate('unsubscribe_done'), {
      parse_mode: 'Markdown',
      ...getMainMenuReplyKeyboard(msg.from.id),
    });
  } else {
    bot.sendMessage(chatId, getMessageTemplate('unsubscribe_not_found'), {
      parse_mode: 'Markdown',
      ...getMainMenuReplyKeyboard(msg.from.id),
    });
  }
}

function handleSubscribe(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const existing = getRegistrationByUserId(userId);
  if (existing) {
    if (msg.from.username) updateRegistrationUsername(userId, msg.from.username);
    const deptList = formatDepartmentSlotsAsList(existing.departmentSlots);
    bot.sendMessage(
      chatId,
      getMessageTemplate('my_record', {
        camp: escapeMarkdown(existing.camp),
        squad: escapeMarkdown(existing.squad),
        deptList,
      }) +
        '\n\n❕ **Вы уже зарегистрированы.** Выберите действие:',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Отменить регистрацию', callback_data: 'user_unsubscribe' }],
            [{ text: '✏️ Изменить направление', callback_data: 'user_reg_edit' }],
          ],
        },
        ...getMainMenuReplyKeyboard(msg.from.id),
      }
    );
    return;
  }
  setState(userId, { step: 'camp' });
  bot.sendMessage(chatId, getMessageTemplate('subscribe_ask_camp'), {
    parse_mode: 'Markdown',
    ...getMainMenuReplyKeyboard(msg.from.id),
  });
}

// Команды по кнопкам (русские названия) и по /команде
bot.onText(/\/(start|начать)/, handleStart);
bot.onText(/\/(departments|направления)/, handleDepartments);
bot.onText(/\/(about|описание|описания)/, handleAbout);
bot.onText(/\/(my|мое)/, handleMy);
bot.onText(/\/(unsubscribe|отменить)/, handleUnsubscribe);
bot.onText(/\/(subscribe|выбрать|регистрация)/, handleSubscribe);

// Admin: вход только через on('message'), чтобы при шаге admin_password любой текст считался только паролем (без дублирования onText)

function downloadTelegramFile(fileId) {
  return bot.getFile(fileId).then((f) => {
    const url = `https://api.telegram.org/file/bot${token}/${f.file_path}`;
    return new Promise((resolve, reject) => {
      https.get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  });
}

// Text messages for conversation flow
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = getState(userId);

  if (msg.document && state.step === 'admin_import_departments' && isAdmin(userId)) {
    const filename = msg.document.file_name || msg.document.file_unique_id || '';
    downloadTelegramFile(msg.document.file_id)
      .then((buf) => {
        const result = parseAndImportDepartments(buf, filename, { dryRun: true });
        if (!result.success) {
          clearState(userId);
          bot.sendMessage(chatId, '❌ Ошибки:\n\n' + result.errors.join('\n'));
          sendAdminMenu(chatId, userId);
          return;
        }
        const { newDepartments } = result;
        const { oldIdToNewId, affectedRegistrations } = analyzeImportImpact(newDepartments);
        if (affectedRegistrations.length === 0) {
          applyImport(newDepartments, oldIdToNewId, true);
          clearState(userId);
          bot.sendMessage(chatId, '✅ Импорт направлений выполнен. Записи сопоставлены по названиям.');
          sendAdminMenu(chatId, userId);
          return;
        }
        setState(userId, {
          step: 'admin_import_pending',
          newDepartments,
          oldIdToNewId: Array.from(oldIdToNewId.entries()),
          affectedRegistrations: affectedRegistrations.map((a) => ({
            registration: a.registration,
            brokenSlots: a.brokenSlots,
            mappedSlots: a.mappedSlots,
          })),
        });
        const lines = affectedRegistrations.map((a) => {
          const missing = [...new Set((a.brokenSlots || []).map((s) => s.departmentName).filter(Boolean))];
          const missingStr = missing.length ? ` — направлений нет в новом списке: «${missing.map((n) => escapeMarkdown(n)).join('», «')}»` : '';
          return `• ${formatChildLabel(a.registration)}${missingStr}`;
        });
        bot.sendMessage(
          chatId,
          `⚠️ **Внимание:** при импорте часть записей не удастся сопоставить с новыми направлениями (${affectedRegistrations.length} ребёнок/детей).\n\n` +
            `Затронутые:\n${lines.join('\n')}\n\nВыберите действие:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '❌ Отмена импорта', callback_data: 'admin_import_cancel' }],
                [{ text: '✅ Импорт с удалением несовпавших', callback_data: 'admin_import_force' }],
                [{ text: '📋 Список затронутых детей', callback_data: 'admin_import_affected' }],
              ],
            },
          }
        );
      })
      .catch((err) => {
        clearState(userId);
        bot.sendMessage(chatId, '❌ Не удалось загрузить файл: ' + (err.message || String(err)));
        sendAdminMenu(chatId, userId);
      });
    return;
  }

  const text = (msg.text || '').trim();
  // Текст без /: считаем командой, если строка совпадает с известной (как будто добавили /)
  if (text && !text.startsWith('/') && state.step !== 'admin_edit_cmd' && state.step !== 'admin_edit_template') {
    let cmdKey = getCommandKeyByLabel(text);
    if (!cmdKey) cmdKey = getCommandKeyByTrigger(text);
    if (cmdKey) {
      if (cmdKey === 'start') handleStart(msg);
      else if (cmdKey === 'departments') handleDepartments(msg);
      else if (cmdKey === 'about') handleAbout(msg);
      else if (cmdKey === 'my') handleMy(msg);
      else if (cmdKey === 'unsubscribe') handleUnsubscribe(msg);
      else if (cmdKey === 'subscribe') handleSubscribe(msg);
      return;
    }
  }
  if (!text) return;

  // Нажатие кнопок админки внизу (только две кнопки) — обрабатываем до шагов диалога
  if (isAdmin(userId) && ADMIN_REPLY_BUTTONS.includes(text)) {
    if (text === '🚪 Выход из администрирования') {
      clearAdminSession(userId);
      clearState(userId);
      bot.sendMessage(chatId, 'Вы вышли из режима администратора.', getUserReplyKeyboard());
      return;
    }
    if (text === '⚙️ Команды администратора') {
      bot.sendMessage(chatId, '🔐 Режим администратора', { reply_markup: adminMenuKeyboard });
      return;
    }
  }

  if (state.step === 'admin_password') {
    if (text === ADMIN_PASSWORD) {
      setAdminSession(userId);
      setState(userId, { step: 'idle' });
      sendAdminMenu(chatId, userId);
    } else {
      bot.sendMessage(chatId, '❌ Неверный пароль. Попробуйте снова.');
      setState(userId, { step: 'idle' });
    }
    return;
  }

  if (state.step === 'camp') {
    const camp = text.trim();
    if (!camp) {
      bot.sendMessage(chatId, getMessageTemplate('err_camp_empty'), { parse_mode: 'Markdown' });
      return;
    }
    setState(userId, { step: 'squad', camp });
    bot.sendMessage(chatId, getMessageTemplate('subscribe_ask_squad'), { parse_mode: 'Markdown' });
    return;
  }

  if (state.step === 'squad') {
    const squad = text.trim();
    if (!squad) {
      bot.sendMessage(chatId, getMessageTemplate('err_squad_empty'), { parse_mode: 'Markdown' });
      return;
    }
    setState(userId, {
      step: 'choose_dept',
      squad,
      selectedSlots: [],
    });
    bot.sendMessage(
      chatId,
      getMessageTemplate('subscribe_choose_dept', { current: '0', max: String(MAX_CHOICES_PER_CHILD) }),
      {
        parse_mode: 'Markdown',
        reply_markup: buildDepartmentKeyboard([]),
      }
    );
    return;
  }

  // Admin: add department — name step
  if (state.step === 'admin_add_dept_name') {
    setState(userId, { step: 'admin_add_dept_desc', adminDeptName: text });
    bot.sendMessage(chatId, 'Введите описание (или **-** чтобы пропустить):', { parse_mode: 'Markdown' });
    return;
  }

  // Admin: add department — description step
  if (state.step === 'admin_add_dept_desc') {
    const desc = text === '-' ? '' : text;
    const result = addDepartment(state.adminDeptName, desc);
    clearState(userId);
    if (result.success) {
      bot.sendMessage(chatId, `✅ Направление «${result.department.name}» добавлено.`);
    } else {
      bot.sendMessage(chatId, `❌ ${result.error}`);
    }
    sendAdminMenu(chatId);
    return;
  }

  // Admin: edit department description
  if (state.step === 'admin_edit_dept_desc') {
    const desc = text === '-' ? '' : text;
    const result = updateDepartment(state.adminEditDeptId, { description: desc });
    clearState(userId);
    if (result.success) {
      bot.sendMessage(chatId, `✅ Описание направления «${result.department.name}» обновлено.`);
    } else {
      bot.sendMessage(chatId, `❌ ${result.error}`);
    }
    sendAdminMenu(chatId, userId);
    return;
  }

  if (state.step === 'admin_edit_cmd') {
    const key = state.adminEditCmdKey;
    if (COMMAND_KEYS.includes(key)) {
      const newLabel = text.trim() || key;
      setCommandLabel(key, newLabel);
      clearState(userId);
      const labels = getCommandLabels();
      const rows = COMMAND_KEYS.map((k) => [
        { text: `${k}: «${labels[k] || k}» — Изменить`, callback_data: `admin_cmd_edit_${k}` },
      ]);
      rows.push([{ text: '← Назад', callback_data: 'admin_back_menu' }]);
      bot.sendMessage(chatId, `✅ Сохранено. Кнопка для \`${key}\`: «${escapeMarkdown(newLabel)}».\n\n⚙️ Настроить команды:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      });
      bot.sendMessage(chatId, '📌 Кнопки меню обновлены (ниже — актуальные названия).', getMainMenuReplyKeyboard(userId));
    } else {
      clearState(userId);
      sendAdminMenu(chatId, userId);
    }
    return;
  }

  if (state.step === 'admin_edit_template') {
    const key = state.adminTemplateKey;
    if (MESSAGE_TEMPLATE_KEYS.includes(key)) {
      setMessageTemplate(key, text);
      clearState(userId);
      const rows = MESSAGE_TEMPLATE_KEYS.map((k) => [
        { text: (MESSAGE_TEMPLATE_LABELS[k] || k).slice(0, 40), callback_data: `admin_template_edit_${k}` },
      ]);
      rows.push([{ text: '← Назад', callback_data: 'admin_back_menu' }]);
      bot.sendMessage(chatId, `✅ Шаблон «${(MESSAGE_TEMPLATE_LABELS[key] || key).replace(/\*/g, '')}» сохранён.`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      });
    } else {
      clearState(userId);
      sendAdminMenu(chatId, userId);
    }
    return;
  }

  // Вызов входа в админку: только здесь (не onText), чтобы при шаге admin_password любой текст был только паролем
  if (ADMIN_COMMAND && ADMIN_PASSWORD) {
    const adminBase = ADMIN_COMMAND.replace(/^\//, '').trim();
    const adminCmdRegex = new RegExp('^\\/?' + adminBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
    if (adminCmdRegex.test(text)) {
      clearState(userId);
      setState(userId, { step: 'admin_password' });
      bot.sendMessage(chatId, '🔐 **Режим администратора**\n\nВведите пароль:');
      return;
    }
  }

  // Сообщения с / — не показывать «неизвестная команда», если это известная пользовательская команда
  if (text.startsWith('/')) {
    const afterSlash = text.slice(1).trim();
    if (getCommandKeyByTrigger(afterSlash)) return;
  }

  // Неизвестная команда или текст — предупреждение и запуск с начала
  clearState(userId);
  bot.sendMessage(chatId, getMessageTemplate('unknown_cmd'), {
    parse_mode: 'Markdown',
    ...getMainMenuReplyKeyboard(userId),
  });
  handleStart(msg);
});

// Inline button callbacks
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;
  const state = getState(userId);

  // ——— Admin callbacks (require admin session) ———
  if (data === 'admin_list') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id, { text: 'Сессия истекла. Войдите снова.' });
      return;
    }
    const grouped = getRegistrationsGroupedByDepartment();
    let text = '📋 **Записи по направлениям**\n\n';
    for (const g of grouped) {
      if (g.children.length === 0) continue;
      text += `▸ **${g.departmentName}** ${g.slotLabel} (${g.children.length} чел.):\n`;
      for (const c of g.children) {
        const contact = c.telegramUsername ? ` @${c.telegramUsername}` : '';
        text += `   • ${c.camp} № ${c.squad}${contact}\n`;
      }
      text += '\n';
    }
    if (text === '📋 **Записи по направлениям**\n\n') text = '❕ Нет записей.';
    editMessageTextSafe(text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '← Меню', callback_data: 'admin_back_menu' }]] },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_back_menu') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    clearState(userId);
    editMessageTextSafe('🔐 Режим администратора', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: adminMenuKeyboard,
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_commands_menu') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    setState(userId, { step: 'idle', adminEditCmdKey: undefined });
    const labels = getCommandLabels();
    const rows = COMMAND_KEYS.map((key) => [
      {
        text: `${key}: «${labels[key] || key}» — Изменить`,
        callback_data: `admin_cmd_edit_${key}`,
      },
    ]);
    rows.push([{ text: '← Назад', callback_data: 'admin_back_menu' }]);
    editMessageTextSafe(
      '⚙️ **Настроить команды**\n\nДля каждой команды задаётся русское название кнопки. Пользователи видят только кнопки; команда входа в админ-панель без кнопки и скрыта.',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data && data.startsWith('admin_cmd_edit_')) {
    const key = data.replace('admin_cmd_edit_', '');
    if (!isAdmin(userId) || !COMMAND_KEYS.includes(key)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const labels = getCommandLabels();
    setState(userId, { step: 'admin_edit_cmd', adminEditCmdKey: key });
    editMessageTextSafe(
      `Введите **новое название кнопки** для команды \`${key}\`.\n\nСейчас: «${labels[key] || key}»`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '← Отмена', callback_data: 'admin_commands_menu' }]] },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_templates_menu') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    clearState(userId);
    const rows = MESSAGE_TEMPLATE_KEYS.map((key) => [
      { text: (MESSAGE_TEMPLATE_LABELS[key] || key).slice(0, 40), callback_data: `admin_template_edit_${key}` },
    ]);
    rows.push([{ text: '← Назад', callback_data: 'admin_back_menu' }]);
    editMessageTextSafe(
      '✉️ **Шаблоны сообщений**\n\nВыберите шаблон для редактирования. Подстановки в тексте: `{{имя}}` (например {{camp}}, {{max}}).',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data && data.startsWith('admin_template_edit_')) {
    const key = data.replace('admin_template_edit_', '');
    if (!isAdmin(userId) || !MESSAGE_TEMPLATE_KEYS.includes(key)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const templates = getAllMessageTemplates();
    const current = (templates[key] || '').slice(0, 500);
    setState(userId, { step: 'admin_edit_template', adminTemplateKey: key });
    editMessageTextSafe(
      `✏️ Редактирование шаблона: **${(MESSAGE_TEMPLATE_LABELS[key] || key).replace(/\*/g, '')}**\n\nОтправьте новое сообщение — его текст заменит шаблон.\nПодстановки: \`{{camp}}\`, \`{{squad}}\`, \`{{deptList}}\`, \`{{max}}\`, \`{{current}}\` и др.\n\nТекущий текст (начало):\n\`\`\`\n${current.replace(/`/g, '`\u200b')}\n\`\`\``,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '← Отмена', callback_data: 'admin_templates_menu' }]] },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  function getResetMenuKeyboard() {
    return {
      inline_keyboard: [
        [{ text: '✉️ Сбросить все шаблоны сообщений', callback_data: 'admin_reset_templates_all' }],
        [{ text: '✉️ Сбросить один шаблон…', callback_data: 'admin_reset_templates_one' }],
        [{ text: '⚙️ Сбросить названия всех команд', callback_data: 'admin_reset_commands_all' }],
        [{ text: '⚙️ Сбросить одну команду…', callback_data: 'admin_reset_commands_one' }],
        [{ text: '← Назад', callback_data: 'admin_back_menu' }],
      ],
    };
  }

  if (data === 'admin_reset_menu') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    clearState(userId);
    editMessageTextSafe(
      '🔄 **Сброс настроек по умолчанию**\n\nВыберите, что сбросить:',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: getResetMenuKeyboard(),
      }
    ).then((edited) => {
      if (!edited) bot.sendMessage(chatId, '✅ Настройки уже по умолчанию. Всё в порядке.');
    });
    answerCallbackQuerySafe(query.id, { text: 'Меню сброса' });
    return;
  }

  if (data === 'admin_reset_templates_all') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    for (const key of MESSAGE_TEMPLATE_KEYS) {
      setMessageTemplate(key, DEFAULT_MESSAGE_TEMPLATES[key]);
    }
    editMessageTextSafe(
      '✅ Все шаблоны сообщений сброшены к значениям по умолчанию.',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: getResetMenuKeyboard(),
      }
    ).then((edited) => {
      if (!edited) bot.sendMessage(chatId, '✅ Настройки уже по умолчанию. Всё в порядке.');
    });
    answerCallbackQuerySafe(query.id, { text: 'Шаблоны сброшены' });
    return;
  }

  if (data === 'admin_reset_templates_one') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const rows = MESSAGE_TEMPLATE_KEYS.map((key) => [
      { text: (MESSAGE_TEMPLATE_LABELS[key] || key).slice(0, 40), callback_data: `admin_reset_template_${key}` },
    ]);
    rows.push([{ text: '← Назад', callback_data: 'admin_reset_menu' }]);
    editMessageTextSafe(
      '✉️ **Сбросить один шаблон**\n\nВыберите шаблон — он будет восстановлен к тексту по умолчанию:',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      }
    ).then((edited) => {
      if (!edited) bot.sendMessage(chatId, '✅ Настройки уже по умолчанию. Всё в порядке.');
    });
    answerCallbackQuerySafe(query.id, { text: 'Готово' });
    return;
  }

  if (data && data.startsWith('admin_reset_template_')) {
    const key = data.replace('admin_reset_template_', '');
    if (!isAdmin(userId) || !MESSAGE_TEMPLATE_KEYS.includes(key)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    setMessageTemplate(key, DEFAULT_MESSAGE_TEMPLATES[key]);
    editMessageTextSafe(
      `✅ Шаблон «${(MESSAGE_TEMPLATE_LABELS[key] || key).replace(/\*/g, '')}» сброшен к значению по умолчанию.`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: getResetMenuKeyboard(),
      }
    ).then((edited) => {
      if (!edited) bot.sendMessage(chatId, '✅ Настройки уже по умолчанию. Всё в порядке.');
    });
    answerCallbackQuerySafe(query.id, { text: 'Сброшено' });
    return;
  }

  if (data === 'admin_reset_commands_all') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    for (const k of COMMAND_KEYS) {
      setCommandLabel(k, DEFAULT_COMMAND_LABELS[k]);
    }
    editMessageTextSafe(
      '✅ Названия всех команд (кнопок меню) сброшены к значениям по умолчанию.',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: getResetMenuKeyboard(),
      }
    ).then((edited) => {
      if (!edited) bot.sendMessage(chatId, '✅ Настройки уже по умолчанию. Всё в порядке.');
    });
    answerCallbackQuerySafe(query.id, { text: 'Команды сброшены' });
    return;
  }

  if (data === 'admin_reset_commands_one') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const labels = getCommandLabels();
    const rows = COMMAND_KEYS.map((key) => [
      {
        text: `${key}: «${labels[key] || key}» → по умолчанию`,
        callback_data: `admin_reset_cmd_${key}`,
      },
    ]);
    rows.push([{ text: '← Назад', callback_data: 'admin_reset_menu' }]);
    editMessageTextSafe(
      '⚙️ **Сбросить одну команду**\n\nВыберите команду — название кнопки будет восстановлено по умолчанию:',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      }
    ).then((edited) => {
      if (!edited) bot.sendMessage(chatId, '✅ Настройки уже по умолчанию. Всё в порядке.');
    });
    answerCallbackQuerySafe(query.id, { text: 'Готово' });
    return;
  }

  if (data && data.startsWith('admin_reset_cmd_')) {
    const key = data.replace('admin_reset_cmd_', '');
    if (!isAdmin(userId) || !COMMAND_KEYS.includes(key)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    setCommandLabel(key, DEFAULT_COMMAND_LABELS[key]);
    const defaultLabel = DEFAULT_COMMAND_LABELS[key] || key;
    editMessageTextSafe(
      `✅ Команда \`${key}\`: название кнопки сброшено на «${escapeMarkdown(defaultLabel)}».`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: getResetMenuKeyboard(),
      }
    ).then((edited) => {
      if (!edited) bot.sendMessage(chatId, '✅ Настройки уже по умолчанию. Всё в порядке.');
    });
    answerCallbackQuerySafe(query.id, { text: 'Сброшено' });
    return;
  }

  if (data === 'admin_export_depts') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    editMessageTextSafe('📤 **Выгрузка направлений**\n\nВыберите формат:', {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'CSV', callback_data: 'admin_export_depts_csv' },
            { text: 'JSON', callback_data: 'admin_export_depts_json' },
            { text: 'PDF', callback_data: 'admin_export_depts_pdf' },
          ],
          [{ text: '← Назад', callback_data: 'admin_back_menu' }],
        ],
      },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  function sendDepartmentsExport(chatId, format, queryId) {
    const list = getDepartments();
    const tmpDir = path.join(os.tmpdir(), `bot-export-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const cleanup = () => {
      try {
        const filePath = path.join(tmpDir, format === 'csv' ? 'направления.csv' : format === 'json' ? 'направления.json' : 'направления.pdf');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        fs.rmdirSync(tmpDir);
      } catch (_) {}
    };
    if (format === 'csv') {
      const csv = getDepartmentsExportCSV();
      const filePath = path.join(tmpDir, 'направления.csv');
      fs.writeFileSync(filePath, csv, 'utf8');
      bot.sendDocument(chatId, filePath).finally(cleanup);
    } else if (format === 'json') {
      const json = JSON.stringify(list, null, 2);
      const filePath = path.join(tmpDir, 'направления.json');
      fs.writeFileSync(filePath, json, 'utf8');
      bot.sendDocument(chatId, filePath).finally(cleanup);
    } else {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => {
        const filePath = path.join(tmpDir, 'направления.pdf');
        fs.writeFileSync(filePath, Buffer.concat(chunks));
        bot.sendDocument(chatId, filePath).finally(cleanup);
      });
      const fontDir = path.join(__dirname, '..', 'node_modules', 'dejavu-fonts-ttf', 'ttf');
      const fontBold = path.join(fontDir, 'DejaVuSans-Bold.ttf');
      const fontRegular = path.join(fontDir, 'DejaVuSans.ttf');
      if (fs.existsSync(fontBold)) doc.font(fontBold);
      else doc.font('Helvetica-Bold');
      doc.fontSize(14).text('Направления', { continued: false }).moveDown(0.5);
      if (fs.existsSync(fontRegular)) doc.font(fontRegular);
      else doc.font('Helvetica');
      doc.fontSize(10);
      list.forEach((d, i) => {
        doc.text(`${i + 1}. ${d.name}`, { continued: false });
        if (d.description) doc.text(d.description, { indent: 20, continued: false }).moveDown(0.3);
        else doc.moveDown(0.3);
      });
      doc.end();
      return;
    }
  }

  if (data === 'admin_export_depts_csv' || data === 'admin_export_depts_json' || data === 'admin_export_depts_pdf') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const format = data === 'admin_export_depts_csv' ? 'csv' : data === 'admin_export_depts_json' ? 'json' : 'pdf';
    sendDepartmentsExport(chatId, format, query.id);
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_import_depts') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    setState(userId, { step: 'admin_import_departments' });
    editMessageTextSafe(
      '📥 **Импорт направлений**\n\nОтправьте файл в формате **JSON** или **CSV** (формат определится автоматически).\n\n• **JSON:** массив объектов с полями **name** (название), **description** (необяз.). Поле **id** необязательно — сгенерируется из названия.\n• **CSV:** две колонки — название направления и описание (разделитель ; или ,). Id генерируется из названия автоматически.\n\nТекущий список направлений будет заменён после успешной проверки.',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '← Отмена', callback_data: 'admin_back_menu' }]] },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_import_cancel') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    clearState(userId);
    editMessageTextSafe('Импорт отменён. Список направлений не изменён.', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: '← Меню', callback_data: 'admin_back_menu' }]] },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_import_force') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const s = getState(userId);
    if (s.step !== 'admin_import_pending' || !s.newDepartments || !s.oldIdToNewId) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const oldIdToNewId = new Map(s.oldIdToNewId);
    applyImport(s.newDepartments, oldIdToNewId, true);
    clearState(userId);
    editMessageTextSafe('✅ Импорт выполнен. Несовпавшие записи удалены.', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [[{ text: '← Меню', callback_data: 'admin_back_menu' }]] },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_import_affected' || data === 'admin_import_aback') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const s = getState(userId);
    if (s.step !== 'admin_import_pending' && s.step !== 'admin_import_rereg') {
      answerCallbackQuerySafe(query.id);
      return;
    }
    let affected = s.affectedRegistrations || [];
    if (data === 'admin_import_aback') {
      setState(userId, { ...s, step: 'admin_import_pending', reregChildIndex: undefined, reregBrokenSlots: undefined, reregAvailableByDept: undefined });
      const lines = affected.map((a) => {
        const missing = [...new Set((a.brokenSlots || []).map((s) => s.departmentName).filter(Boolean))];
        const missingStr = missing.length ? ` — направлений нет в новом списке: «${missing.map((n) => escapeMarkdown(n)).join('», «')}»` : '';
        return `• ${formatChildLabel(a.registration)}${missingStr}`;
      });
      editMessageTextSafe(
        `⚠️ **Внимание:** при импорте часть записей не удастся сопоставить с новыми направлениями (${affected.length} ребёнок/детей).\n\nЗатронутые:\n${lines.join('\n')}\n\nВыберите действие:`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '❌ Отмена импорта', callback_data: 'admin_import_cancel' }],
              [{ text: '✅ Импорт с удалением несовпавших', callback_data: 'admin_import_force' }],
              [{ text: '📋 Список затронутых детей', callback_data: 'admin_import_affected' }],
            ],
          },
        }
      );
      answerCallbackQuerySafe(query.id);
      return;
    }
    if (s.step === 'admin_import_rereg') {
      setState(userId, { ...s, step: 'admin_import_pending', reregChildIndex: undefined, reregBrokenSlots: undefined, reregAvailableByDept: undefined });
    }
    if (affected.length === 0) {
      const oldIdToNewId = new Map(s.oldIdToNewId);
      applyImport(s.newDepartments, oldIdToNewId, true);
      clearState(userId);
      editMessageTextSafe('✅ Все затронутые обработаны. Импорт применён.', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '← Меню', callback_data: 'admin_back_menu' }]] },
      });
      answerCallbackQuerySafe(query.id);
      return;
    }
    const rows = affected.map((a, i) => [
      { text: formatChildLabel(a.registration), callback_data: `admin_import_child_${i}` },
    ]);
    rows.push([{ text: '← Назад', callback_data: 'admin_import_aback' }]);
    editMessageTextSafe('📋 Затронутые дети. Выберите ребёнка:', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: rows },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data && data.startsWith('admin_import_child_') && !data.includes('_cdel_') && !data.includes('_creg_')) {
    const idx = parseInt(data.replace('admin_import_child_', ''), 10);
    if (!isAdmin(userId) || isNaN(idx)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const s = getState(userId);
    if (s.step !== 'admin_import_pending' && s.step !== 'admin_import_rereg') {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const affected = s.affectedRegistrations || [];
    if (idx < 0 || idx >= affected.length) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const item = affected[idx];
    const missingNames = [...new Set((item.brokenSlots || []).map((s) => s.departmentName).filter(Boolean))];
    const missingStr = missingNames.length ? `\nНаправления, которых нет в новом списке: «${missingNames.map((n) => escapeMarkdown(n)).join('», «')}»` : '';
    editMessageTextSafe(
      `Ребёнок: ${escapeMarkdown(formatChildLabel(item.registration))}\nНесовпавших слотов: ${item.brokenSlots.length}.${missingStr}\n\nВыберите действие:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Удалить регистрацию', callback_data: `admin_import_cdel_${idx}` }],
            [{ text: '✏️ Перерегистрировать вручную', callback_data: `admin_import_creg_${idx}` }],
            [{ text: '← Назад', callback_data: 'admin_import_affected' }],
          ],
        },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data && data.startsWith('admin_import_cdel_')) {
    const idx = parseInt(data.replace('admin_import_cdel_', ''), 10);
    if (!isAdmin(userId) || isNaN(idx)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const s = getState(userId);
    if (s.step !== 'admin_import_pending' && s.step !== 'admin_import_rereg') {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const affected = [...(s.affectedRegistrations || [])];
    if (idx < 0 || idx >= affected.length) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const item = affected[idx];
    deleteRegistration(item.registration.telegramUserId);
    affected.splice(idx, 1);
    setState(userId, { ...s, affectedRegistrations: affected, step: 'admin_import_pending' });
    if (affected.length === 0) {
      const oldIdToNewId = new Map(s.oldIdToNewId);
      applyImport(s.newDepartments, oldIdToNewId, true);
      clearState(userId);
      editMessageTextSafe('✅ Регистрация удалена. Затронутых не осталось. Импорт применён.', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '← Меню', callback_data: 'admin_back_menu' }]] },
      });
    } else {
      const rows = affected.map((a, i) => [
        { text: formatChildLabel(a.registration), callback_data: `admin_import_child_${i}` },
      ]);
      rows.push([{ text: '← Назад', callback_data: 'admin_import_affected' }]);
      editMessageTextSafe('📋 Затронутые дети. Выберите ребёнка:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: rows },
      });
    }
    answerCallbackQuerySafe(query.id);
    return;
  }

  function buildAvailableByDept(available) {
    const byDept = new Map();
    for (const av of available) {
      if (!byDept.has(av.departmentId)) {
        byDept.set(av.departmentId, { departmentId: av.departmentId, departmentName: av.departmentName, slots: [] });
      }
      const entry = byDept.get(av.departmentId);
      if (!entry.slots.some((s) => s.slotIndex === av.slotIndex)) {
        entry.slots.push({ slotIndex: av.slotIndex, slotLabel: av.slotLabel });
      }
    }
    return Array.from(byDept.values()).map((d) => ({ ...d, slots: d.slots.sort((a, b) => a.slotIndex - b.slotIndex) }));
  }

  if (data && data.startsWith('admin_import_creg_')) {
    const idx = parseInt(data.replace('admin_import_creg_', ''), 10);
    if (!isAdmin(userId) || isNaN(idx)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const s = getState(userId);
    if (s.step !== 'admin_import_pending' && s.step !== 'admin_import_rereg') {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const affected = s.affectedRegistrations || [];
    if (idx < 0 || idx >= affected.length) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const item = affected[idx];
    const slotIndexToReplace = item.brokenSlots[0].slotIndex;
    const oldIdToNewId = new Map(s.oldIdToNewId);
    let available = getAvailableSlotsForReregister(s.newDepartments, oldIdToNewId, item.registration.telegramUserId);
    available = available.filter((a) => a.slotIndex === slotIndexToReplace);
    if (available.length === 0) {
      bot.answerCallbackQuery(query.id, {
        text: `Нет свободных направлений в выбранное время (${getSlotLabel(slotIndexToReplace)}). Ребёнок не может быть в двух местах одновременно.`,
        show_alert: true,
      });
      return;
    }
    const availableByDept = buildAvailableByDept(available);
    setState(userId, {
      ...s,
      step: 'admin_import_rereg',
      reregChildIndex: idx,
      reregBrokenSlots: [...item.brokenSlots],
      reregAvailableByDept: availableByDept,
    });
    const deptRows = availableByDept.map((d, di) => [
      { text: d.departmentName, callback_data: `admin_import_dept_${idx}_${di}` },
    ]);
    deptRows.push([{ text: '← Назад', callback_data: 'admin_import_affected' }]);
    editMessageTextSafe(
      `Выберите **направление** для слота **${getSlotLabel(slotIndexToReplace)}** (ребёнок не может быть в двух местах в одно время; осталось заменить: ${item.brokenSlots.length}):`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: deptRows },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data && data.startsWith('admin_import_dept_')) {
    const parts = data.replace('admin_import_dept_', '').split('_');
    const idx = parseInt(parts[0], 10);
    const deptIdx = parseInt(parts[1], 10);
    if (!isAdmin(userId) || isNaN(idx) || isNaN(deptIdx)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const s = getState(userId);
    if (s.step !== 'admin_import_rereg' || s.reregChildIndex !== idx) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const availableByDept = s.reregAvailableByDept || [];
    if (deptIdx < 0 || deptIdx >= availableByDept.length) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const dept = availableByDept[deptIdx];
    const slotRows = dept.slots.map((slot, si) => [
      { text: slot.slotLabel, callback_data: `admin_import_pick_${idx}_${deptIdx}_${si}` },
    ]);
    slotRows.push([{ text: '← Назад', callback_data: `admin_import_creg_${idx}` }]);
    editMessageTextSafe(`Направление **${escapeMarkdown(dept.departmentName)}**. Выберите **временной слот** (есть свободные места):`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: slotRows },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data && data.startsWith('admin_import_pick_')) {
    const parts = data.replace('admin_import_pick_', '').split('_');
    const idx = parseInt(parts[0], 10);
    const deptIdx = parseInt(parts[1], 10);
    const slotIdx = parseInt(parts[2], 10);
    if (!isAdmin(userId) || isNaN(idx) || isNaN(deptIdx) || isNaN(slotIdx)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const s = getState(userId);
    if (s.step !== 'admin_import_rereg' || s.reregChildIndex !== idx) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const availableByDept = s.reregAvailableByDept || [];
    if (deptIdx < 0 || deptIdx >= availableByDept.length) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const dept = availableByDept[deptIdx];
    if (slotIdx < 0 || slotIdx >= dept.slots.length) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const slot = dept.slots[slotIdx];
    const broken = s.reregBrokenSlots || [];
    if (broken.length === 0) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const affected = s.affectedRegistrations || [];
    const item = affected[idx];
    const result = replaceBrokenSlotWithNew(
      item.registration.telegramUserId,
      broken[0].departmentId,
      broken[0].slotIndex,
      dept.departmentId,
      slot.slotIndex
    );
    if (!result.success) {
      if (result.error === 'slot_taken') {
        bot.answerCallbackQuery(query.id, {
          text: 'Выбранное направление и слот уже заняты. Ниже — актуальный список с учётом новых регистраций.',
          show_alert: true,
        });
        const oldIdToNewId = new Map(s.oldIdToNewId);
        let newAvailable = getAvailableSlotsForReregister(s.newDepartments, oldIdToNewId, item.registration.telegramUserId);
        newAvailable = newAvailable.filter((a) => a.slotIndex === broken[0].slotIndex);
        const newAvailableByDept = buildAvailableByDept(newAvailable);
        setState(userId, { ...s, reregAvailableByDept: newAvailableByDept });
        const deptRows = newAvailableByDept.map((d, di) => [
          { text: d.departmentName, callback_data: `admin_import_dept_${idx}_${di}` },
        ]);
        deptRows.push([{ text: '← Назад', callback_data: `admin_import_creg_${idx}` }]);
        const timeLabel = getSlotLabel(broken[0].slotIndex);
        const mainText =
          newAvailableByDept.length > 0
            ? `⚠️ **Выбранное направление и слот уже заняты** (кто-то успел записаться).\n\nНиже — **актуальный список направлений** с свободными местами на время **${timeLabel}** (с учётом новых регистраций):`
            : `⚠️ **Выбранное направление и слот уже заняты.** Пока вы выбирали, все свободные места на время **${timeLabel}** заняли. Нажмите «Назад» и попробуйте снова позже.`;
        editMessageTextSafe(mainText, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: deptRows },
        });
      }
      answerCallbackQuerySafe(query.id);
      return;
    }
    const remaining = broken.slice(1);
    if (remaining.length === 0) {
      const newAffected = affected.filter((_, i) => i !== idx);
      setState(userId, {
        ...s,
        step: 'admin_import_pending',
        affectedRegistrations: newAffected,
        reregChildIndex: undefined,
        reregBrokenSlots: undefined,
        reregAvailableByDept: undefined,
      });
      if (newAffected.length === 0) {
        const oldIdToNewId = new Map(s.oldIdToNewId);
        applyImport(s.newDepartments, oldIdToNewId, true);
        clearState(userId);
        editMessageTextSafe('✅ Перерегистрация завершена. Все затронутые обработаны. Импорт применён.', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: [[{ text: '← Меню', callback_data: 'admin_back_menu' }]] },
        });
      } else {
        const rows = newAffected.map((a, i) => [
          { text: formatChildLabel(a.registration), callback_data: `admin_import_child_${i}` },
        ]);
        rows.push([{ text: '← Назад', callback_data: 'admin_import_affected' }]);
        editMessageTextSafe('📋 Затронутые дети. Выберите ребёнка:', {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: { inline_keyboard: rows },
        });
      }
      answerCallbackQuerySafe(query.id);
      return;
    }
    const oldIdToNewId = new Map(s.oldIdToNewId);
    const nextSlotIndexToReplace = remaining[0].slotIndex;
    let newAvailable = getAvailableSlotsForReregister(s.newDepartments, oldIdToNewId, item.registration.telegramUserId);
    newAvailable = newAvailable.filter((a) => a.slotIndex === nextSlotIndexToReplace);
    const newAvailableByDept = buildAvailableByDept(newAvailable);
    setState(userId, { ...s, reregBrokenSlots: remaining, reregAvailableByDept: newAvailableByDept });
    const deptRows = newAvailableByDept.map((d, di) => [
      { text: d.departmentName, callback_data: `admin_import_dept_${idx}_${di}` },
    ]);
    deptRows.push([{ text: '← Назад', callback_data: 'admin_import_affected' }]);
    editMessageTextSafe(
      `Выберите **направление** для замены следующего несовпавшего слота — время **${getSlotLabel(nextSlotIndexToReplace)}** (осталось: ${remaining.length}):`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: deptRows },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_export_regs') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const rows = getRegistrationsExportRows();
    const header = 'Направление;Временной слот;Записано\n';
    const body = rows.map((r) => `${r.departmentName};${r.slotLabel};${r.count}`).join('\n');
    const csv = '\uFEFF' + header + body;
    const tmpDir = path.join(os.tmpdir(), `bot-export-${Date.now()}`);
    const filePath = path.join(tmpDir, 'регистрации.csv');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(filePath, csv, 'utf8');
    bot
      .sendDocument(chatId, filePath)
      .finally(() => {
        try {
          fs.unlinkSync(filePath);
          fs.rmdirSync(tmpDir);
        } catch (_) {}
      });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_select_child') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id, { text: 'Сессия истекла.' });
      return;
    }
    const registrations = loadRegistrations();
    if (registrations.length === 0) {
      answerCallbackQuerySafe(query.id, { text: 'Нет записей.' });
      return;
    }
    // One button per row: название лагеря и № отряда + @username
    const rows = registrations.map((r) => {
      const label = r.telegramUsername
        ? `${r.camp} № ${r.squad} · @${r.telegramUsername}`
        : `${r.camp} № ${r.squad}`;
      return [{ text: label, callback_data: `child_${r.telegramUserId}` }];
    });
    rows.push([{ text: '← Меню', callback_data: 'admin_back_menu' }]);
    editMessageTextSafe(
      '👤 **Выберите ребёнка**\n\n_Нажмите на запись, чтобы открыть карточку_',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('child_')) {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const childId = data.replace('child_', '');
    const reg = getRegistrationByUserId(childId);
    if (!reg) {
      answerCallbackQuerySafe(query.id, { text: 'Запись не найдена.' });
      return;
    }
    setState(userId, { adminSelectedChild: childId });
    const deptList = formatDepartmentSlotsAsList(reg.departmentSlots);
    const contactLine = reg.telegramUsername
      ? `💬 **Связаться:** [@${escapeMarkdown(reg.telegramUsername)}](https://t.me/${reg.telegramUsername})`
      : '💬 **Связаться:** _не указан_';
    const keyboard = {
      inline_keyboard: [
        [{ text: '✏️ Изменить запись', callback_data: `admin_resub_${childId}` }],
        [{ text: '🗑 Удалить запись', callback_data: `admin_unsub_${childId}` }],
        [{ text: '← К списку детей', callback_data: 'admin_select_child' }],
      ],
    };
    editMessageTextSafe(
      `👤 **Название лагеря:** ${escapeMarkdown(reg.camp)} · **№ отряда:** ${escapeMarkdown(reg.squad)}\n\n📁 **Направления и слоты:**\n${deptList}\n\n${contactLine}`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('admin_resub_')) {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const childId = data.replace('admin_resub_', '');
    const reg = getRegistrationByUserId(childId);
    if (!reg) {
      answerCallbackQuerySafe(query.id, { text: 'Запись не найдена.' });
      return;
    }
    setState(userId, {
      step: 'admin_resubscribe',
      adminSelectedChild: childId,
      selectedSlots: [],
    });
    editMessageTextSafe(`Изменить запись: ${escapeMarkdown(reg.camp)} № ${escapeMarkdown(reg.squad)}. Выберите **направление**, затем слот:\n\n(выбрано: 0 из ${MAX_CHOICES_PER_CHILD})`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: buildDepartmentKeyboard([]),
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('admin_unsub_yes_')) {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const childId = data.replace('admin_unsub_yes_', '');
    const reg = getRegistrationByUserId(childId);
    const label = reg
      ? (reg.telegramUsername ? `${reg.camp} № ${reg.squad} @${reg.telegramUsername}` : `${reg.camp} № ${reg.squad}`)
      : childId;
    const removed = deleteRegistration(childId);
    clearState(userId);
    editMessageTextSafe(removed ? `✅ Запись (${label}) удалена.` : 'Запись не найдена.', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: '📋 Список по направлениям', callback_data: 'admin_list' }],
          [{ text: '👤 Выбрать ребёнка', callback_data: 'admin_select_child' }],
          [{ text: '📁 Управление направлениями', callback_data: 'admin_depts_menu' }],
          [{ text: '🚪 Выход', callback_data: 'admin_exit' }],
        ],
      },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('admin_unsub_')) {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const childId = data.replace('admin_unsub_', '');
    const reg = getRegistrationByUserId(childId);
    if (!reg) {
      answerCallbackQuerySafe(query.id, { text: 'Запись не найдена.' });
      return;
    }
    setState(userId, { adminSelectedChild: childId });
    const confirmLine = reg.telegramUsername
      ? `${reg.camp} № ${reg.squad} @${reg.telegramUsername}`
      : `${reg.camp} № ${reg.squad}`;
    editMessageTextSafe(`Удалить запись: ${confirmLine}?`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Да, удалить', callback_data: `admin_unsub_yes_${childId}` }],
          [{ text: 'Нет', callback_data: `child_${childId}` }],
        ],
      },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  // ——— Admin: manage departments ———
  if (data === 'admin_depts_menu') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    editMessageTextSafe('📁 Управление направлениями', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: '➕ Добавить направление', callback_data: 'admin_dept_add' }],
          [{ text: '✏️ Редактировать описание', callback_data: 'admin_dept_edit_list' }],
          [{ text: '🗑 Удалить направление', callback_data: 'admin_dept_del_list' }],
          [{ text: '← Меню', callback_data: 'admin_back_menu' }],
        ],
      },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_dept_add') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    setState(userId, { step: 'admin_add_dept_name' });
    editMessageTextSafe('Введите **название** нового направления:', {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_dept_edit_list') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const list = getDepartments();
    const rows = list.map((d) => [{ text: d.name, callback_data: `admin_edit_dept_${d.id}` }]);
    rows.push([{ text: '← Назад', callback_data: 'admin_depts_menu' }]);
    editMessageTextSafe('Выберите направление для редактирования описания:', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: rows },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('admin_edit_dept_')) {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const deptId = data.replace('admin_edit_dept_', '');
    const dept = getDepartments().find((d) => d.id === deptId);
    if (!dept) {
      answerCallbackQuerySafe(query.id, { text: 'Направление не найдено.' });
      return;
    }
    setState(userId, { step: 'admin_edit_dept_desc', adminEditDeptId: deptId });
    editMessageTextSafe(
      `Введите новое **описание** для «${escapeMarkdown(dept.name)}» (или отправьте **-** чтобы очистить):`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_dept_del_list') {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const list = getDepartments();
    const rows = list.map((d) => [{ text: d.name, callback_data: `admin_del_dept_${d.id}` }]);
    rows.push([{ text: '← Назад', callback_data: 'admin_depts_menu' }]);
    editMessageTextSafe('Выберите направление для удаления (записи на него будут отменены, дети получат уведомление):', {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: rows },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('admin_del_dept_') && !data.startsWith('admin_del_dept_yes_')) {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const deptId = data.replace('admin_del_dept_', '');
    const dept = getDepartments().find((d) => d.id === deptId);
    if (!dept) {
      answerCallbackQuerySafe(query.id, { text: 'Направление не найдено.' });
      return;
    }
    editMessageTextSafe(`Удалить направление **«${escapeMarkdown(dept.name)}»**?\n\nВсе записи на это направление будут отменены, дети получат уведомление.`, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Да, удалить', callback_data: `admin_del_dept_yes_${deptId}` }],
          [{ text: 'Нет', callback_data: 'admin_dept_del_list' }],
        ],
      },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('admin_del_dept_yes_')) {
    if (!isAdmin(userId)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const deptId = data.replace('admin_del_dept_yes_', '');
    const result = deleteDepartment(deptId);
    if (!result.success) {
      answerCallbackQuerySafe(query.id, { text: result.error || 'Ошибка.' });
      return;
    }
    const notifyText = getMessageTemplate('notify_dept_removed');
    let notified = 0;
    for (const telegramUserId of result.affectedTelegramUserIds || []) {
      try {
        bot.sendMessage(telegramUserId, notifyText, { parse_mode: 'Markdown' });
        notified++;
      } catch (e) {
        // user may have blocked bot
      }
    }
    editMessageTextSafe(
      `✅ Направление «${result.departmentName}» удалено. Уведомлено детей: ${notified}.`,
      { chat_id: chatId, message_id: query.message.message_id }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'admin_exit') {
    clearAdminSession(userId);
    clearState(userId);
    editMessageTextSafe('Вы вышли из режима администратора.', {
      chat_id: chatId,
      message_id: query.message.message_id,
    });
    bot.sendMessage(chatId, 'Кнопки меню обновлены.', getUserReplyKeyboard());
    answerCallbackQuerySafe(query.id);
    return;
  }

  // User: confirm unsubscribe (from "Удалить мою запись" button)
  if (data === 'user_unsubscribe') {
    editMessageTextSafe(getMessageTemplate('user_unsub_confirm'), {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Да, удалить', callback_data: 'user_unsub_yes' }],
          [{ text: 'Нет', callback_data: 'user_unsub_no' }],
        ],
      },
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'user_unsub_yes') {
    const removed = deleteRegistration(userId);
    clearState(userId);
    editMessageTextSafe(
      removed ? getMessageTemplate('user_unsub_done') : getMessageTemplate('user_unsub_not_found'),
      {
        chat_id: chatId,
        message_id: query.message.message_id,
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'user_unsub_no') {
    editMessageTextSafe(getMessageTemplate('user_unsub_cancelled'), {
      chat_id: chatId,
      message_id: query.message.message_id,
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  // Пользователь нажал «Изменить направление» (уже зарегистрирован)
  if (data === 'user_reg_edit') {
    const existing = getRegistrationByUserId(userId);
    if (!existing || !existing.departmentSlots || existing.departmentSlots.length === 0) {
      answerCallbackQuerySafe(query.id, { text: 'Запись не найдена.' });
      return;
    }
    const departments = getDepartments();
    const byId = new Map(departments.map((d) => [d.id, d.name]));
    const withIndex = existing.departmentSlots.map((s, i) => ({ ...s, originalIndex: i }));
    const sorted = withIndex.slice().sort((a, b) => a.slotIndex - b.slotIndex);
    const rows = sorted.map((s) => {
      const name = byId.get(s.departmentId) || '?';
      const slot = getSlotLabel(s.slotIndex);
      return [{ text: `${s.originalIndex + 1}. ${name} — ${slot}`, callback_data: `user_change_slot_${s.originalIndex}` }];
    });
    rows.push([{ text: '← Назад', callback_data: 'user_reg_edit_back' }]);
    editMessageTextSafe(
      '✏️ **Какое направление хотите изменить?**\n\nВремя слота останется тем же — выберите только новое направление.',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'user_reg_edit_back') {
    const existing = getRegistrationByUserId(userId);
    if (!existing) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    clearState(userId);
    const deptList = formatDepartmentSlotsAsList(existing.departmentSlots);
    editMessageTextSafe(
      getMessageTemplate('my_record', {
        camp: escapeMarkdown(existing.camp),
        squad: escapeMarkdown(existing.squad),
        deptList,
      }) + '\n\n❕ **Вы уже зарегистрированы.** Выберите действие:',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗑 Отменить регистрацию', callback_data: 'user_unsubscribe' }],
            [{ text: '✏️ Изменить направление', callback_data: 'user_reg_edit' }],
          ],
        },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('user_change_slot_')) {
    const idx = parseInt(data.replace('user_change_slot_', ''), 10);
    const existing = getRegistrationByUserId(userId);
    if (!existing || !existing.departmentSlots || idx < 0 || idx >= existing.departmentSlots.length) {
      answerCallbackQuerySafe(query.id, { text: 'Ошибка.' });
      return;
    }
    const slot = existing.departmentSlots[idx];
    const otherDeptIds = existing.departmentSlots.filter((_, i) => i !== idx).map((s) => s.departmentId);
    setState(userId, {
      step: 'user_choose_new_dept',
      changeSlotIndex: idx,
      existingSlots: existing.departmentSlots.map((s) => ({ departmentId: s.departmentId, slotIndex: s.slotIndex })),
    });
    const deptName = getDepartments().find((d) => d.id === slot.departmentId)?.name || '?';
    editMessageTextSafe(
      `🕐 Слот **${getSlotLabel(slot.slotIndex)}** сейчас: «${escapeMarkdown(deptName)}».\n\nВыберите **новое направление** на то же время:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: buildDepartmentKeyboardForSlot(slot.slotIndex, otherDeptIds),
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('user_pick_new_dept_')) {
    const newDeptId = data.replace('user_pick_new_dept_', '');
    const st = getState(userId);
    if (st.step !== 'user_choose_new_dept' || st.changeSlotIndex == null || !st.existingSlots) {
      answerCallbackQuerySafe(query.id, { text: 'Сессия истекла. Начните снова.' });
      return;
    }
    const existing = getRegistrationByUserId(userId);
    if (!existing) {
      clearState(userId);
      answerCallbackQuerySafe(query.id, { text: 'Запись не найдена.' });
      return;
    }
    const newSlots = st.existingSlots.map((s, i) =>
      i === st.changeSlotIndex ? { departmentId: newDeptId, slotIndex: s.slotIndex } : s
    );
    const result = registerChild(userId, existing.camp, existing.squad, newSlots, query.from.username);
    clearState(userId);
    if (result.success) {
      const deptList = formatDepartmentSlotsAsList(newSlots);
      editMessageTextSafe(
        getMessageTemplate('register_success', {
          camp: escapeMarkdown(existing.camp),
          squad: escapeMarkdown(existing.squad),
          nickname: existing.telegramUsername ? ` · @${escapeMarkdown(existing.telegramUsername)}` : '',
          deptList,
        }),
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
        }
      );
      bot.sendMessage(chatId, getMessageTemplate('menu_use_buttons'), getMainMenuReplyKeyboard(userId));
    } else {
      const fullList = (result.fullSlots || [])
        .map((s) => `• **«${escapeMarkdown(s.departmentName)}»** ${s.slotLabel}`)
        .join('\n');
      const msg = fullList
        ? `❌ **Кто-то уже занял это место.**\n\n${fullList}\n\n▶️ Выберите другое направление или попробуйте позже.`
        : getMessageTemplate('register_error', { error: result.error || 'Ошибка' });
      editMessageTextSafe(msg, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '✏️ Изменить направление снова', callback_data: 'user_reg_edit' }]],
        },
      });
    }
    answerCallbackQuerySafe(query.id);
    return;
  }

  // "Описания направлений" from /departments
  if (data === 'about_list') {
    editMessageTextSafe(getMessageTemplate('about_choose'), {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: buildAboutKeyboard(),
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  // Show description for department
  if (data.startsWith('desc_')) {
    const deptId = data.replace('desc_', '');
    const dept = getDepartments().find((d) => d.id === deptId);
    if (!dept) {
      answerCallbackQuerySafe(query.id, { text: 'Направление не найдено.' });
      return;
    }
    const desc = dept.description || getMessageTemplate('desc_no_description');
    const out = desc.length > MAX_DESC_LENGTH ? desc.slice(0, MAX_DESC_LENGTH) + '…' : desc;
    bot.sendMessage(chatId, getMessageTemplate('dept_description', { name: dept.name, description: out }));
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'dept_confirm_cancel') {
    const st = getState(userId);
    if (st.step !== 'confirm_choices' && st.step !== 'admin_confirm_choices') {
      answerCallbackQuerySafe(query.id);
      return;
    }
    clearState(userId);
    editMessageTextSafe('❌ Регистрация отменена. Чтобы начать заново — нажмите кнопку «Регистрация».', {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'dept_confirm_edit') {
    const st = getState(userId);
    if ((st.step !== 'confirm_choices' && st.step !== 'admin_confirm_choices') || !st.selectedSlots || st.selectedSlots.length !== MAX_CHOICES_PER_CHILD) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const departments = getDepartments();
    const byId = new Map(departments.map((d) => [d.id, d.name]));
    const withIndex = st.selectedSlots.map((s, i) => ({ ...s, originalIndex: i }));
    const sorted = withIndex.slice().sort((a, b) => a.slotIndex - b.slotIndex);
    const rows = sorted.map((s) => {
      const name = byId.get(s.departmentId) || '?';
      const slot = getSlotLabel(s.slotIndex);
      return [{ text: `${s.originalIndex + 1}. ${name} — ${slot}`, callback_data: `dept_confirm_change_${s.originalIndex}` }];
    });
    rows.push([{ text: '← Назад', callback_data: 'dept_confirm_edit_back' }]);
    editMessageTextSafe(
      '✏️ **Какое направление хотите изменить?**\n\nВыберите пункт — затем выберете другое направление на то же время.',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: rows },
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'dept_confirm_edit_back') {
    const st = getState(userId);
    if (!['confirm_choices', 'admin_confirm_choices', 'confirm_change_slot'].includes(st.step)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const step = st.adminSelectedChild ? 'admin_confirm_choices' : 'confirm_choices';
    setState(userId, { step, changeSlotIndex: undefined });
    const summaryText = st.adminSelectedChild
      ? (() => {
          const reg = getRegistrationByUserId(st.adminSelectedChild);
          return reg ? formatConfirmSummary(st.selectedSlots, reg.camp, reg.squad) : formatConfirmSummary(st.selectedSlots, '', '');
        })()
      : formatConfirmSummary(st.selectedSlots, st.camp, st.squad);
    editMessageTextSafe(summaryText, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: buildConfirmChoiceKeyboard(),
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('dept_confirm_change_')) {
    const idx = parseInt(data.replace('dept_confirm_change_', ''), 10);
    const st = getState(userId);
    if ((st.step !== 'confirm_choices' && st.step !== 'admin_confirm_choices') || !st.selectedSlots || idx < 0 || idx >= st.selectedSlots.length) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const slot = st.selectedSlots[idx];
    const otherDeptIds = st.selectedSlots.filter((_, i) => i !== idx).map((s) => s.departmentId);
    setState(userId, { ...st, step: 'confirm_change_slot', changeSlotIndex: idx });
    const deptName = getDepartments().find((d) => d.id === slot.departmentId)?.name || '?';
    editMessageTextSafe(
      `🕐 Слот **${getSlotLabel(slot.slotIndex)}** сейчас: «${escapeMarkdown(deptName)}».\n\nВыберите **новое направление** на то же время:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: buildDepartmentKeyboardForSlot(slot.slotIndex, otherDeptIds, 'confirm_pick_dept_'),
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('confirm_pick_dept_')) {
    const newDeptId = data.replace('confirm_pick_dept_', '');
    const st = getState(userId);
    if (st.step !== 'confirm_change_slot' || st.changeSlotIndex == null || !st.selectedSlots) {
      answerCallbackQuerySafe(query.id, { text: 'Сессия истекла.' });
      return;
    }
    const newSlots = st.selectedSlots.map((s, i) =>
      i === st.changeSlotIndex ? { departmentId: newDeptId, slotIndex: s.slotIndex } : s
    );
    const step = st.adminSelectedChild ? 'admin_confirm_choices' : 'confirm_choices';
    setState(userId, { selectedSlots: newSlots, step, changeSlotIndex: undefined });
    const summaryText = st.adminSelectedChild
      ? (() => {
          const reg = getRegistrationByUserId(st.adminSelectedChild);
          return reg ? formatConfirmSummary(newSlots, reg.camp, reg.squad) : formatConfirmSummary(newSlots, '', '');
        })()
      : formatConfirmSummary(newSlots, st.camp, st.squad);
    editMessageTextSafe(summaryText, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: buildConfirmChoiceKeyboard(),
    });
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'dept_confirm_final') {
    const st = getState(userId);
    const isAdminResub = st.step === 'admin_resubscribe' || st.step === 'admin_confirm_choices';
    const isConfirmStep = st.step === 'confirm_choices' || st.step === 'admin_confirm_choices';
    if (
      (st.step !== 'choose_dept' && !isAdminResub && !isConfirmStep) ||
      !st.selectedSlots ||
      st.selectedSlots.length !== MAX_CHOICES_PER_CHILD
    ) {
      answerCallbackQuerySafe(query.id, {
        text: getMessageTemplate('choose_count', { max: String(MAX_CHOICES_PER_CHILD) }),
      });
      return;
    }

    if (isAdminResub) {
      const reg = getRegistrationByUserId(st.adminSelectedChild);
      if (!reg) {
        answerCallbackQuerySafe(query.id, { text: 'Запись не найдена.' });
        return;
      }
      const result = registerChild(st.adminSelectedChild, reg.camp, reg.squad, st.selectedSlots, reg.telegramUsername);
      if (result.success) {
        clearState(userId);
        const deptList = formatDepartmentSlotsAsList(st.selectedSlots);
        editMessageTextSafe(
          getMessageTemplate('admin_resub_updated', {
            camp: escapeMarkdown(reg.camp),
            squad: escapeMarkdown(reg.squad),
            deptList,
          }),
          { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
        );
      } else {
        const remaining = dropFullSlots(st.selectedSlots, result.fullSlots);
        const countText = `(выбрано: ${remaining.length} из ${MAX_CHOICES_PER_CHILD})`;
        setState(userId, { selectedSlots: remaining });
        const fullList = (result.fullSlots || []).map((s) => `• **«${escapeMarkdown(s.departmentName)}»** ${s.slotLabel}`).join('\n');
        const msg = fullList
          ? getMessageTemplate('slots_partial', { fullList, countText })
          : getMessageTemplate('register_error', { error: result.error });
        editMessageTextSafe(msg, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: buildDepartmentKeyboard(remaining),
        });
      }
      answerCallbackQuerySafe(query.id);
      return;
    }

    if (!st.camp || !st.squad) {
      answerCallbackQuerySafe(query.id, { text: 'Ошибка: укажите название лагеря и номер отряда.' });
      return;
    }
    const telegramUsername = query.from.username || undefined;
    const result = registerChild(userId, st.camp, st.squad, st.selectedSlots, telegramUsername);

    if (result.success) {
      clearState(userId);
      const deptList = formatDepartmentSlotsAsList(st.selectedSlots);
      const nickname = telegramUsername ? ` · @${escapeMarkdown(telegramUsername)}` : '';
      editMessageTextSafe(
        getMessageTemplate('register_success', {
          camp: escapeMarkdown(st.camp),
          squad: escapeMarkdown(st.squad),
          nickname,
          deptList,
        }),
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
      bot.sendMessage(chatId, getMessageTemplate('menu_use_buttons'), getMainMenuReplyKeyboard(userId));
    } else {
      const remaining = dropFullSlots(st.selectedSlots, result.fullSlots);
      const countText = `(выбрано: ${remaining.length} из ${MAX_CHOICES_PER_CHILD})`;
      setState(userId, { selectedSlots: remaining });
      const fullList = (result.fullSlots || []).map((s) => `• **«${escapeMarkdown(s.departmentName)}»** ${s.slotLabel}`).join('\n');
      const msg = fullList
        ? getMessageTemplate('slots_full', { fullList, countText })
        : getMessageTemplate('register_error', { error: result.error });
      editMessageTextSafe(msg, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: buildDepartmentKeyboard(remaining),
      });
    }
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('pickdept_full_')) {
    answerCallbackQuerySafe(query.id, { text: 'В этом направлении нет свободных слотов.' });
    return;
  }

  if (data.startsWith('pickdept_')) {
    const departmentId = data.replace('pickdept_', '');
    const st = getState(userId);
    const isChooseDept = st.step === 'choose_dept' || st.step === 'admin_resubscribe';
    if (!isChooseDept || (st.selectedSlots || []).length >= MAX_CHOICES_PER_CHILD) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const departments = getDepartments();
    const dept = departments.find((d) => d.id === departmentId);
    const slots = getDepartmentSlotsWithAvailability().filter(
      (s) => s.departmentId === departmentId && s.hasSpace
    );
    if (!dept || slots.length === 0) {
      answerCallbackQuerySafe(query.id, { text: 'Нет свободных слотов в этом направлении.' });
      return;
    }
    setState(userId, { step: 'choose_slot', pendingDeptId: departmentId });
    editMessageTextSafe(
      `🕐 **Выберите время для направления «${dept.name}»:**\n\n(выбрано: ${(st.selectedSlots || []).length} из ${MAX_CHOICES_PER_CHILD})`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: buildSlotKeyboard(departmentId, dept.name, st.selectedSlots),
      }
    );
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data.startsWith('pickslot_')) {
    const rest = data.replace('pickslot_', '');
    const parts = rest.split('_');
    const slotIndex = parseInt(parts[parts.length - 1], 10);
    const departmentId = parts.slice(0, -1).join('_');
    if (parts.length < 2 || isNaN(slotIndex)) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const st = getState(userId);
    if (st.step !== 'choose_slot' || st.pendingDeptId !== departmentId) {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const selected = (st.selectedSlots || []).slice();
    selected.push({ departmentId, slotIndex });
    if (selected.length === MAX_CHOICES_PER_CHILD) {
      const step = st.adminSelectedChild ? 'admin_confirm_choices' : 'confirm_choices';
      setState(userId, { selectedSlots: selected, step, pendingDeptId: undefined });
      const summaryText = st.adminSelectedChild
        ? (() => {
            const reg = getRegistrationByUserId(st.adminSelectedChild);
            return reg
              ? formatConfirmSummary(selected, reg.camp, reg.squad)
              : `📋 **Проверьте выбор**\n\n📁 **Направления и слоты:**\n${formatDepartmentSlotsAsList(selected)}\n\nВсё верно?`;
          })()
        : formatConfirmSummary(selected, st.camp, st.squad);
      editMessageTextSafe(summaryText, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: buildConfirmChoiceKeyboard(),
      });
    } else {
      const nextStep = st.adminSelectedChild ? 'admin_resubscribe' : 'choose_dept';
      setState(userId, { selectedSlots: selected, step: nextStep, pendingDeptId: undefined });
      const countText = `(выбрано: ${selected.length} из ${MAX_CHOICES_PER_CHILD})`;
      const isAdmin = !!st.adminSelectedChild;
      const text = isAdmin
        ? (() => {
            const reg = getRegistrationByUserId(st.adminSelectedChild);
            return `Изменить запись: ${reg ? `${escapeMarkdown(reg.camp)} № ${escapeMarkdown(reg.squad)}` : '…'}. Выберите направление, затем слот\n\n${countText}`;
          })()
        : `📁 **Выберите направление** (потом — время)\n\n${countText}`;
      editMessageTextSafe(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: buildDepartmentKeyboard(selected),
      });
    }
    answerCallbackQuerySafe(query.id);
    return;
  }

  if (data === 'slot_back') {
    const st = getState(userId);
    if (st.step !== 'choose_slot') {
      answerCallbackQuerySafe(query.id);
      return;
    }
    const nextStep = st.adminSelectedChild ? 'admin_resubscribe' : 'choose_dept';
    setState(userId, { step: nextStep, pendingDeptId: undefined });
    const countText = `(выбрано: ${(st.selectedSlots || []).length} из ${MAX_CHOICES_PER_CHILD})`;
    const isAdmin = !!st.adminSelectedChild;
    const text = isAdmin
      ? (() => {
          const reg = getRegistrationByUserId(st.adminSelectedChild);
          return `Изменить запись: ${reg ? `${escapeMarkdown(reg.camp)} № ${escapeMarkdown(reg.squad)}` : '…'}. Выберите направление, затем слот\n\n${countText}`;
        })()
      : `📁 **Выберите направление** (потом — время)\n\n${countText}`;
    editMessageTextSafe(text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: 'Markdown',
      reply_markup: buildDepartmentKeyboard(st.selectedSlots || []),
    });
    answerCallbackQuerySafe(query.id);
  }
});

module.exports = bot;
