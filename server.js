const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

app.get('/', (req, res) => {
  res.sendFile(path.resolve('./index.html'));
});

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://bingo-4c196-default-rtdb.firebaseio.com'
});
const db = admin.database();

const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;
const ENTRY_FEE = 10;
const WINNER_CUT = 0.9;
const STARTING_CREDITS = 100;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'Player';
  const userRef = db.ref(`users/${userId}`);
  const snap = await userRef.once('value');
  if (!snap.exists()) {
    await userRef.set({ telegramId: userId, name: firstName, credits: STARTING_CREDITS, gamesPlayed: 0, gamesWon: 0, joinedAt: Date.now() });
  }
  const userData = (await userRef.once('value')).val();
  await bot.sendMessage(userId,
    `🎰 *Welcome to Ethbingo, ${firstName}!*\n\n💰 Balance: *$${userData.credits} demo credits*\n🎮 Entry fee: *$${ENTRY_FEE} per game*\n🏆 Winner takes: *${WINNER_CUT * 100}% of the pot*\n\nTap below to play!`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎯 Play Bingo', web_app: { url: MINI_APP_URL } }],[{ text: '💰 My Balance', callback_data: 'balance' },{ text: '🏆 Leaderboard', callback_data: 'leaderboard' }]] } }
  );
});

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  if (query.data === 'balance') {
    const snap = await db.ref(`users/${userId}`).once('value');
    const user = snap.val();
    if (!user) { bot.answerCallbackQuery(query.id, { text: 'Send /start first' }); return; }
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(userId, `💰 *Balance*\n\nCredits: *$${user.credits}*\nGames Played: *${user.gamesPlayed||0}*\nGames Won: *${user.gamesWon||0}*`, { parse_mode: 'Markdown' });
  }
  if (query.data === 'leaderboard') {
    bot.answerCallbackQuery(query.id);
    const snap = await db.ref('users').orderByChild('credits').limitToLast(10).once('value');
    const sorted = Object.values(snap.val()||{}).sort((a,b)=>b.credits-a.credits);
    let msg = '🏆 *Top Players*\n\n';
    sorted.forEach((u,i) => { msg += `${['🥇','🥈','🥉'][i]||i+1+'.'} ${u.name} — *$${u.credits}*\n`; });
    bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
  }
});

app.post('/api/user', async (req, res) => {
  const { telegramId, name } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'No telegramId' });
  const userRef = db.ref(`users/${telegramId}`);
  const snap = await userRef.once('value');
  if (!snap.exists()) await userRef.set({ telegramId, name: name||'Player', credits: STARTING_CREDITS, gamesPlayed: 0, gamesWon: 0, joinedAt: Date.now() });
  res.json((await userRef.once('value')).val());
});

app.post('/api/join', async (req, res) => {
  const { telegramId } = req.body;
  const userRef = db.ref(`users/${telegramId}`);
  const user = (await userRef.once('value')).val();
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.credits < ENTRY_FEE) return res.status(400).json({ error: 'Not enough credits' });
  await userRef.update({ credits: user.credits - ENTRY_FEE, gamesPlayed: (user.gamesPlayed||0)+1 });
  const potSnap = await db.ref('game/pot').once('value');
  await db.ref('game/pot').set((potSnap.val()||0) + ENTRY_FEE);
  res.json({ success: true, newBalance: user.credits - ENTRY_FEE });
});

app.post('/api/payout', async (req, res) => {
  const { telegramId } = req.body;
  const paidSnap = await db.ref('game/paidOut').once('value');
  if (paidSnap.val()) return res.status(400).json({ error: 'Already paid out' });
  const pot = (await db.ref('game/pot').once('value')).val() || 0;
  const winnings = Math.floor(pot * WINNER_CUT);
  const userRef = db.ref(`users/${telegramId}`);
  const user = (await userRef.once('value')).val();
  if (!user) return res.status(404).json({ error: 'User not found' });
  await userRef.update({ credits: user.credits + winnings, gamesWon: (user.gamesWon||0)+1 });
  await db.ref('game/paidOut').set(true);
  bot.sendMessage(telegramId, `🎉 *BINGO! You won $${winnings}!*\n\nNew balance: *$${user.credits+winnings}*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎯 Play Again', web_app: { url: MINI_APP_URL } }]] } });
  res.json({ success: true, winnings, newBalance: user.credits + winnings });
});

app.get('/api/balance/:telegramId', async (req, res) => {
  const snap = await db.ref(`users/${req.params.telegramId}`).once('value');
  if (!snap.exists()) return res.status(404).json({ error: 'User not found' });
  res.json({ credits: snap.val().credits, name: snap.val().name });
});

app.listen(process.env.PORT || 3000, () => console.log('🎰 Ethbingo running!'));  const paidSnap = await paidRef.once('value');
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
