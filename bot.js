#!/usr/bin/env node

const axios = require('axios');
const mime = require('mime-types');
const FormData = require('form-data');
const { randomUUID } = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const BASE_URL = 'https://claude.ai';
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const MODELS = {
  '1': { key: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6',            thinking: false },
  '2': { key: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6 + Thinking', thinking: true  },
  '3': { key: 'claude-sonnet-5',           label: 'Claude Sonnet 5',              thinking: false },
  '4': { key: 'claude-sonnet-5',           label: 'Claude Sonnet 5 + Thinking',   thinking: true  },
  '5': { key: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',             thinking: false },
};

const CLIENT_HEADERS = {
  'user-agent': 'Claude com.anthropic.claude/1.260902.20 (Android 29) Claude/1.260902.20',
  'anthropic-client-platform': 'android',
  'anthropic-client-app': 'com.anthropic.claude',
  'anthropic-client-version': '1.260902.20',
  'anthropic-client-build': '26090220',
  'anthropic-client-os-version': '29',
  'accept-language': 'id-ID',
};

function loadSession() {
  try {
    return JSON.parse(process.env.CLAUDE_SESSION);
  } catch {
    return null;
  }
}

function buildCookieHeader(session) {
  const cookies = [
    `sessionKey=${session.sessionKey}`,
    `sessionKeyLC=${session.sessionKeyLC}`,
  ];
  if (session.routingHint) cookies.push(`routingHint=${session.routingHint}`);
  if (session.cfuvid) cookies.push(`_cfuvid=${session.cfuvid}`);
  if (session.cfBm) cookies.push(`__cf_bm=${session.cfBm}`);
  return cookies.join('; ');
}

function makeHeaders(session = null, extra = {}) {
  const h = {
    ...CLIENT_HEADERS,
    'anthropic-device-id': session?.deviceId || randomUUID(),
    ...extra,
  };
  if (session) h['cookie'] = buildCookieHeader(session);
  return h;
}

async function uploadFile(session, convId, fileBuffer, fileName, mimeType) {
  const form = new FormData();
  form.append('file', fileBuffer, {
    filename: fileName,
    contentType: mimeType,
    knownLength: fileBuffer.length,
  });

  const { data } = await axios.post(
    `${BASE_URL}/api/organizations/${session.orgUuid}/conversations/${convId}/wiggle/upload-file`,
    form,
    {
      headers: makeHeaders(session, {
        ...form.getHeaders(),
        'content-length': String(form.getLengthSync()),
      }),
    }
  );

  if (data?.uuid) return data;
  throw new Error(data?.message || 'Upload file gagal');
}

async function sendCompletion(session, convId, prompt, parentUuid = null, fileUuids = []) {
  const body = {
    prompt,
    timezone: 'Asia/Jakarta',
    model: session.model,
    files: fileUuids,
    rendering_mode: 'messages',
    input_mode: 'text',
    tools: [
      { name: 'repl', type: 'repl_v0' },
      { name: 'web_search', type: 'web_search_v0' },
    ],
    parent_message_uuid: parentUuid,
    effort: 'max',
    thinking_mode: session.thinkingMode ? 'extended' : 'off',
    completion_request_id: randomUUID(),
    turn_message_uuids: {
      human_message_uuid: randomUUID(),
      assistant_message_uuid: randomUUID(),
    },
    ...(parentUuid === null ? {
      create_conversation_params: {
        uuid: convId,
        name: '',
        model: session.model,
        is_temporary: false,
        include_conversation_preferences: true,
        enabled_imagine: true,
        chat_memory_mode: 'enabled',
      },
    } : {}),
  };

  const res = await axios.post(
    `${BASE_URL}/api/organizations/${session.orgUuid}/chat_conversations/${convId}/completion`,
    body,
    {
      headers: makeHeaders(session, {
        'content-type': 'application/json; charset=UTF8',
        accept: 'text/event-stream',
      }),
      responseType: 'stream',
      decompress: true,
      timeout: 0,
    }
  );

  return new Promise((resolve, reject) => {
    let buf = '';
    let fullText = '';
    let lastAssistantUuid = null;

    res.data.setEncoding('utf8');

    res.data.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const raw = trimmed.slice(5).trim();
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        if (parsed.type === 'message_start' && parsed.message?.uuid) {
          lastAssistantUuid = parsed.message.uuid;
        }

        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
          fullText += parsed.delta.text || '';
        }
      }
    });

    res.data.on('end', () => resolve({ text: fullText.trim(), assistantUuid: lastAssistantUuid }));
    res.data.on('error', reject);
  });
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function formatResponse(text) {
  return text
    .replace(/^### (.+)$/gm, '*$1*')
    .replace(/^## (.+)$/gm, '*$1*')
    .replace(/^# (.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/`{3}(\w*)\n([\s\S]*?)`{3}/g, (_, lang, code) => `\`\`\`\n${code.trim()}\n\`\`\``)
    .replace(/^[-*] (.+)$/gm, '• $1')
    .replace(/^\d+\. (.+)$/gm, (m) => m);
}

async function sendLongMessage(bot, chatId, text, replyToId = null) {
  const MAX_LENGTH = 4096;
  const opts = { parse_mode: 'Markdown' };
  if (replyToId) opts.reply_to_message_id = replyToId;

  if (text.length <= MAX_LENGTH) {
    await bot.sendMessage(chatId, text, opts);
    return;
  }

  const fileName = `response_${Date.now()}.txt`;
  const fileBuffer = Buffer.from(text, 'utf8');

  await bot.sendChatAction(chatId, 'upload_document');

  await bot.sendDocument(
    chatId,
    fileBuffer,
    {
      caption: '📄 Respons terlalu panjang, dikirim sebagai file.',
      ...(replyToId ? { reply_to_message_id: replyToId } : {}),
    },
    {
      filename: fileName,
      contentType: 'text/plain',
    }
  );
}

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const userSessions = {};

function getUserSession(userId) {
  if (!userSessions[userId]) {
    const base = loadSession();
    if (!base) return null;
    userSessions[userId] = {
      ...base,
      model: MODELS['1'].key,
      thinkingMode: MODELS['1'].thinking,
      modelLabel: MODELS['1'].label,
      convId: randomUUID(),
      parentUuid: null,
    };
  }
  return userSessions[userId];
}

bot.setMyCommands([
  { command: 'start', description: 'Mulai bot' },
  { command: 'model', description: 'Pilih model Claude' },
  { command: 'reset', description: 'Reset percakapan baru' },
]);

bot.onText(/\/start/, (msg) => {
  const session = getUserSession(msg.from.id);
  if (!session) return;
  bot.sendMessage(
    msg.chat.id,
    `Halo *${escapeMarkdown(msg.from.first_name)}*\\! 👋\n\nBot Claude AI siap digunakan\\.\nModel aktif: *${escapeMarkdown(session.modelLabel)}*\n\nKirim pesan atau file untuk mulai chat\\. Gunakan /model untuk ganti model\\.`,
    { parse_mode: 'MarkdownV2' }
  );
});

bot.onText(/\/reset/, (msg) => {
  const userId = msg.from.id;
  if (userSessions[userId]) {
    userSessions[userId].convId = randomUUID();
    userSessions[userId].parentUuid = null;
  }
  bot.sendMessage(msg.chat.id, '🔄 Percakapan direset\\. Mulai chat baru\\!', { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/model/, (msg) => {
  const keyboard = {
    inline_keyboard: Object.entries(MODELS).map(([k, v]) => ([{
      text: v.label,
      callback_data: `model_${k}`,
    }])),
  };
  bot.sendMessage(msg.chat.id, '🤖 Pilih model Claude:', { reply_markup: keyboard });
});

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;

  if (data.startsWith('model_')) {
    const key = data.replace('model_', '');
    const chosen = MODELS[key];
    if (!chosen) return;

    const session = getUserSession(userId);
    if (!session) return;

    session.model = chosen.key;
    session.thinkingMode = chosen.thinking;
    session.modelLabel = chosen.label;
    session.convId = randomUUID();
    session.parentUuid = null;

    await bot.answerCallbackQuery(query.id, { text: `Model diganti ke ${chosen.label}` });
    await bot.editMessageText(
      `✅ Model aktif: *${escapeMarkdown(chosen.label)}*\n🔄 Percakapan direset otomatis\\.`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'MarkdownV2',
      }
    );
  }
});

async function handleMessage(msg, fileBuffer = null, fileName = null, mimeType = null) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const session = getUserSession(userId);

  if (!session) return;

  const prompt = msg.text || msg.caption || '';
  if (!prompt && !fileBuffer) return;

  try {
    let currentAction = 'typing';
    await bot.sendChatAction(chatId, currentAction);

    const typingInterval = setInterval(() => {
      bot.sendChatAction(chatId, currentAction).catch(() => {});
    }, 4000);

    let fileUuids = [];

    if (fileBuffer) {
      currentAction = 'upload_document';
      await bot.sendChatAction(chatId, currentAction);
      const uploaded = await uploadFile(session, session.convId, fileBuffer, fileName, mimeType);
      fileUuids.push(uploaded.uuid);
      currentAction = 'typing';
      await bot.sendChatAction(chatId, currentAction);
    }

    const result = await sendCompletion(session, session.convId, prompt, session.parentUuid, fileUuids);

    clearInterval(typingInterval);

    if (!result?.text) return;

    session.parentUuid = result.assistantUuid;

    const formatted = formatResponse(result.text);
    await sendLongMessage(bot, chatId, formatted, msg.message_id);
  } catch (err) {
    console.error('Error:', err.message);
    await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
  }
}

bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;

  if (msg.text) {
    return handleMessage(msg);
  }

  const fileObj = msg.photo
    ? msg.photo[msg.photo.length - 1]
    : msg.document || msg.audio || msg.video || msg.voice || msg.sticker || msg.animation;

  if (!fileObj) return;

  try {
    const fileInfo = await bot.getFile(fileObj.file_id);
    const ext = fileInfo.file_path.split('.').pop();
    const mimeType = mime.lookup(ext) || 'application/octet-stream';
    const fileName = msg.document?.file_name || `file_${Date.now()}.${ext}`;

    const fileLink = await bot.getFileLink(fileObj.file_id);
    const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
    const fileBuffer = Buffer.from(response.data);

    if (fileBuffer.length > MAX_FILE_SIZE) {
      return bot.sendMessage(msg.chat.id, '❌ Ukuran file melebihi 10MB.');
    }

    return handleMessage(msg, fileBuffer, fileName, mimeType);
  } catch (err) {
    console.error('Error download file:', err.message);
    await bot.sendMessage(msg.chat.id, `❌ Gagal mengunduh file: ${err.message}`);
  }
});

console.log('ClaudeAI started...');

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});
