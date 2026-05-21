const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── FIREBASE INIT ─────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://bingo-4c196-default-rtdb.firebaseio.com'
});
const db = admin.database();

// ── TELEGRAM BOT ──────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || '8887151299:AAFmyP4BSaMnUA-3k0Tp6WNSZ9qLrwCMXLM';
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-app.railway.app';
const ENTRY_FEE = 10;
const WINNER_CUT = 0.9;
const STARTING_CREDITS = 100;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ── BOT COMMANDS ──────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'Player';

  // Give new players starting credits
  const userRef = db.ref(`users/${userId}`);
  const snap = await userRef.once('value');
  if (!snap.exists()) {
    await userRef.set({
      telegramId: userId,
      name: firstName,
      credits: STARTING_CREDITS,
      gamesPlayed: 0,
      gamesWon: 0,
      joinedAt: Date.now()
    });
  }

  const userData = (await userRef.once('value')).val();

  await bot.sendMessage(userId,
    `🎰 *Welcome to Ethbingo, ${firstName}!*\n\n` +
    `💰 Your balance: *$${userData.credits} demo credits*\n` +
    `🎮 Entry fee: *$${ENTRY_FEE} per game*\n` +
    `🏆 Winner takes: *${WINNER_CUT * 100}% of the pot*\n\n` +
    `Tap the button below to start playing!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '🎯 Play Bingo', web_app: { url: MINI_APP_URL } }
        ], [
          { text: '💰 My Balance', callback_data: 'balance' },
          { text: '🏆 Leaderboard', callback_data: 'leaderboard' }
        ]]
      }
    }
  );
});

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;

  if (data === 'balance') {
    const snap = await db.ref(`users/${userId}`).once('value');
    const user = snap.val();
    if (!user) { bot.answerCallbackQuery(query.id, { text: 'Please start the bot first with /start' }); return; }
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(userId,
      `💰 *Your Balance*\n\n` +
      `Demo Credits: *$${user.credits}*\n` +
      `Games Played: *${user.gamesPlayed || 0}*\n` +
      `Games Won: *${user.gamesWon || 0}*`,
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'leaderboard') {
    bot.answerCallbackQuery(query.id);
    const snap = await db.ref('users').orderByChild('credits').limitToLast(10).once('value');
    const users = snap.val() || {};
    const sorted = Object.values(users).sort((a, b) => b.credits - a.credits);
    let msg = '🏆 *Top Players*\n\n';
    sorted.forEach((u, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
      msg += `${medal} ${u.name} — *$${u.credits}*\n`;
    });
    bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
  }
});

// ── API ROUTES ────────────────────────────────────────────────

// Validate user and get their data
app.post('/api/user', async (req, res) => {
  const { telegramId, name } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'No telegramId' });

  const userRef = db.ref(`users/${telegramId}`);
  const snap = await userRef.once('value');

  if (!snap.exists()) {
    await userRef.set({
      telegramId, name: name || 'Player',
      credits: STARTING_CREDITS,
      gamesPlayed: 0, gamesWon: 0,
      joinedAt: Date.now()
    });
  }

  res.json((await userRef.once('value')).val());
});

// Pay entry fee to join a game
app.post('/api/join', async (req, res) => {
  const { telegramId } = req.body;
  const userRef = db.ref(`users/${telegramId}`);
  const snap = await userRef.once('value');
  const user = snap.val();

  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.credits < ENTRY_FEE) return res.status(400).json({ error: 'Not enough credits' });

  await userRef.update({
    credits: user.credits - ENTRY_FEE,
    gamesPlayed: (user.gamesPlayed || 0) + 1
  });

  // Add to pot
  const potRef = db.ref('game/pot');
  const potSnap = await potRef.once('value');
  await potRef.set((potSnap.val() || 0) + ENTRY_FEE);

  res.json({ success: true, newBalance: user.credits - ENTRY_FEE });
});

// Pay out winner
app.post('/api/payout', async (req, res) => {
  const { telegramId, gameId } = req.body;

  // Check not already paid out
  const paidRef = db.ref(`game/paidOut`);
  const paidSnap = await paidRef.once('value');
  if (paidSnap.val()) return res.status(400).json({ error: 'Already paid out' });

  const potSnap = await db.ref('game/pot').once('value');
  const pot = potSnap.val() || 0;
  const winnings = Math.floor(pot * WINNER_CUT);

  const userRef = db.ref(`users/${telegramId}`);
  const snap = await userRef.once('value');
  const user = snap.val();
  if (!user) return res.status(404).json({ error: 'User not found' });

  await userRef.update({
    credits: user.credits + winnings,
    gamesWon: (user.gamesWon || 0) + 1
  });

  await paidRef.set(true);

  // Notify via bot
  bot.sendMessage(telegramId,
    `🎉 *BINGO! You won!*\n\n` +
    `💰 Winnings: *$${winnings} demo credits*\n` +
    `💳 New balance: *$${user.credits + winnings}*\n\n` +
    `Play again? Tap below!`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: '🎯 Play Again', web_app: { url: MINI_APP_URL } }]]
      }
    }
  );

  res.json({ success: true, winnings, newBalance: user.credits + winnings });
});

// Get user balance
app.get('/api/balance/:telegramId', async (req, res) => {
  const snap = await db.ref(`users/${req.params.telegramId}`).once('value');
  if (!snap.exists()) return res.status(404).json({ error: 'User not found' });
  const user = snap.val();
  res.json({ credits: user.credits, name: user.name });
});

app.listen(process.env.PORT || 3000, () => {
  console.log('🎰 Ethbingo server running!');
});
