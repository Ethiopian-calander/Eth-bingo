const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');

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

const BOT_TOKEN    = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;
const ENTRY_FEE    = 10;
const WINNER_CUT   = 0.80;
const MIN_DEPOSIT  = 50;
const ADMIN_ID     = 5733202009;

const BANKS = {
  cbe:       { name: 'CBE Bank',          emoji: '🏦', account: '1000605418159', holder: 'Dawit Mamo' },
  telebirr:  { name: 'Telebirr',          emoji: '📱', account: '0980462375',    holder: 'Dawit Mamo' },
  abyssinia: { name: 'Bank of Abyssinia', emoji: '🏛️', account: '206543108',     holder: 'Dawit Mamo' }
};

// ─────────────────────────────────────────────────────────────────────────────
// BOT MANAGER — bingo-playing bots with real money
// ─────────────────────────────────────────────────────────────────────────────

const BOTS = [
  { id: -1,  name: 'Abebe'   },
  { id: -2,  name: 'Meron'   },
  { id: -3,  name: 'Dawit B' },
  { id: -4,  name: 'Sara'    },
  { id: -5,  name: 'Yonas'   },
  { id: -6,  name: 'Tigist'  },
  { id: -7,  name: 'Bereket' },
  { id: -8,  name: 'Hana'    },
  { id: -9,  name: 'Kaleab'  },
  { id: -10, name: 'Lidya'   },
];

function getBotCount(realPlayerCount) {
  if (realPlayerCount >= 20) return 0;
  if (realPlayerCount >= 10) return 5;
  if (realPlayerCount >= 5)  return 8;
  if (realPlayerCount >= 2)  return 10;
  return 12;
}

async function initBots() {
  for (const bot of BOTS) {
    const ref = db.ref(`users/${bot.id}`);
    const snap = await ref.once('value');
    if (!snap.exists()) {
      await ref.set({
        telegramId: bot.id, name: bot.name,
        username: bot.name.toLowerCase().replace(' ', ''),
        balance: 10000, isBot: true,
        gamesPlayed: 0, gamesWon: 0,
        totalDeposited: 10000, totalWon: 0,
        joinedAt: Date.now()
      });
    } else if ((snap.val().balance || 0) < 100) {
      await ref.update({ balance: 10000 });
    }
  }
  console.log('✅ All bots ready');
}

async function botJoinGame(botId) {
  const botRef = db.ref(`users/${botId}`);
  const bot = (await botRef.once('value')).val();
  if (!bot) return false;
  if ((bot.balance || 0) < ENTRY_FEE) {
    await botRef.update({ balance: 10000 });
  }
  await botRef.update({
    balance: (bot.balance || 10000) - ENTRY_FEE,
    gamesPlayed: (bot.gamesPlayed || 0) + 1
  });
  const potSnap = await db.ref('game/pot').once('value');
  await db.ref('game/pot').set((potSnap.val() || 0) + ENTRY_FEE);
  console.log(`🤖 Bot ${bot.name} joined game`);
  return true;
}

async function botWinGame(botId) {
  const paidSnap = await db.ref('game/paidOut').once('value');
  if (paidSnap.val()) return;
  const pot = (await db.ref('game/pot').once('value')).val() || 0;
  const winnings = Math.floor(pot * WINNER_CUT);
  const botRef = db.ref(`users/${botId}`);
  const bot = (await botRef.once('value')).val();
  await botRef.update({
    balance: (bot.balance || 0) + winnings,
    gamesWon: (bot.gamesWon || 0) + 1,
    totalWon: (bot.totalWon || 0) + winnings
  });
  await db.ref('game/paidOut').set(true);
  await db.ref('game/winner').set({ isBot: true, botId, winnings });
  console.log(`🤖 Bot ${bot.name} won ${winnings} ETB`);
}

async function addBotsToLobby(realPlayerCount) {
  const needed = getBotCount(realPlayerCount);
  if (needed === 0) return [];
  const botsToAdd = BOTS.slice(0, needed);
  const joinedBots = [];
  for (const bot of botsToAdd) {
    await new Promise(r => setTimeout(r, Math.random() * 1500 + 300));
    const joined = await botJoinGame(bot.id);
    if (joined) joinedBots.push(bot.id);
  }
  console.log(`✅ Added ${joinedBots.length} bots to lobby`);
  return joinedBots;
}

function generateBotCartela() {
  const shuffle = arr => { const b=[...arr]; for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];} return b; };
  const range  = (a,b) => Array.from({length:b-a+1},(_,i)=>i+a);
  const cols = [
    shuffle(range(1,15)).slice(0,5),  shuffle(range(16,30)).slice(0,5),
    shuffle(range(31,45)).slice(0,5), shuffle(range(46,60)).slice(0,5),
    shuffle(range(61,75)).slice(0,5),
  ];
  cols[2][2] = 'FREE';
  return cols;
}

function checkBotBingo(cartela, called) {
  const hit = (c,r) => cartela[c][r] === 'FREE' || called.includes(cartela[c][r]);
  for(let r=0;r<5;r++) if([0,1,2,3,4].every(c=>hit(c,r))) return true;
  for(let c=0;c<5;c++) if([0,1,2,3,4].every(r=>hit(c,r))) return true;
  if([0,1,2,3,4].every(i=>hit(i,i))) return true;
  if([0,1,2,3,4].every(i=>hit(i,4-i))) return true;
  return false;
}

function checkBotsForWin(botCartelas, calledNumbers) {
  for (const [botId, cartela] of Object.entries(botCartelas)) {
    if (checkBotBingo(cartela, calledNumbers)) return parseInt(botId);
  }
  return null;
}

// Active game state (in memory)
let activeGame = {
  running: false,
  calledNumbers: [],
  botCartelas: {},    // { botId: cartela }
  joinedBotIds: [],
  interval: null
};

async function startGameLoop() {
  if (activeGame.running) return;
  activeGame.running = true;
  activeGame.calledNumbers = [];

  const allNumbers = Array.from({length: 75}, (_, i) => i + 1);

  activeGame.interval = setInterval(async () => {
    const remaining = allNumbers.filter(n => !activeGame.calledNumbers.includes(n));
    if (remaining.length === 0) {
      clearInterval(activeGame.interval);
      activeGame.running = false;
      await db.ref('game/status').set('finished_no_winner');
      return;
    }

    // Call a random number
    const n = remaining[Math.floor(Math.random() * remaining.length)];
    activeGame.calledNumbers.push(n);
    await db.ref('game/calledNumbers').set(activeGame.calledNumbers);
    await db.ref('game/lastCalled').set(n);

    // Check if any bot won
    const paidSnap = await db.ref('game/paidOut').once('value');
    if (!paidSnap.val()) {
      const winningBotId = checkBotsForWin(activeGame.botCartelas, activeGame.calledNumbers);
      if (winningBotId) {
        clearInterval(activeGame.interval);
        activeGame.running = false;
        await botWinGame(winningBotId);
        await db.ref('game/status').set('finished_bot_won');
        console.log(`Game over — bot won`);
      }
    } else {
      // Real player already won, stop calling
      clearInterval(activeGame.interval);
      activeGame.running = false;
    }
  }, 1800); // call a number every 1.8 seconds
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM BOT
// ─────────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: { autoStart: false, params: { timeout: 10 } } });

bot.stopPolling().then(() => {
  return new Promise(resolve => setTimeout(resolve, 2000));
}).then(() => {
  return bot.startPolling();
}).then(() => {
  console.log('Bot polling started. Admin ID:', ADMIN_ID);
  initBots(); // initialize bots on startup
}).catch(err => {
  console.error('Polling error:', err.message);
  setTimeout(() => bot.startPolling(), 5000);
});

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const firstName = msg.from.first_name || 'Player';
  const userRef = db.ref(`users/${userId}`);
  const snap = await userRef.once('value');
  if (!snap.exists()) {
    await userRef.set({
      telegramId: userId, name: firstName,
      username: msg.from.username || '',
      balance: 0, inviteBonus: 0,
      gamesPlayed: 0, gamesWon: 0,
      totalDeposited: 0, totalWon: 0,
      joinedAt: Date.now()
    });
  }
  const startParam = msg.text?.split(' ')[1];
  if (startParam && startParam.startsWith('ref_') && !snap.exists()) {
    const referrerId = startParam.replace('ref_', '');
    if (referrerId !== String(userId)) {
      const refRef = db.ref(`users/${referrerId}`);
      const refSnap = await refRef.once('value');
      if (refSnap.exists()) {
        const newBonus = (refSnap.val().inviteBonus || 0) + 2;
        await refRef.update({ inviteBonus: newBonus });
        try { bot.sendMessage(parseInt(referrerId), `Someone joined with your invite! +2 ETB bonus. Total invite bonus: ${newBonus} ETB`); } catch(e) {}
      }
    }
  }
  const user = (await userRef.once('value')).val();
  await bot.sendMessage(userId,
    `🎰 *Welcome to Ethbingo, ${firstName}!*\n\n💰 Balance: *${user.balance} ETB*\n🎮 Entry fee: *${ENTRY_FEE} ETB per game*\n🏆 Winner takes: *${WINNER_CUT * 100}% of the pot*\n\nDeposit ETB to start playing!`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '🎯 Play Bingo', web_app: { url: MINI_APP_URL } }],
      [{ text: '💰 Deposit ETB', callback_data: 'deposit' }, { text: '💳 My Balance', callback_data: 'balance' }],
      [{ text: '🏆 Leaderboard', callback_data: 'leaderboard' }, { text: '📋 Instructions', callback_data: 'instructions' }],
      [{ text: '👥 Invite Friends +2 ETB', callback_data: 'invite' }]
    ]}}
  );
});

bot.on('callback_query', async (query) => {
  const userId = query.from.id;
  const data = query.data;
  await bot.answerCallbackQuery(query.id);

  if (data === 'balance') {
    const snap = await db.ref(`users/${userId}`).once('value');
    const user = snap.val();
    if (!user) { bot.sendMessage(userId, 'Please send /start first.'); return; }
    bot.sendMessage(userId,
      `💳 *Your Account*\n\nBalance: *${user.balance} ETB*\nInvite Bonus: *${user.inviteBonus || 0} ETB*\nGames Played: *${user.gamesPlayed || 0}*\nGames Won: *${user.gamesWon || 0}*\nTotal Deposited: *${user.totalDeposited || 0} ETB*\nTotal Won: *${user.totalWon || 0} ETB*`,
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'deposit') {
    bot.sendMessage(userId,
      `💰 *Make a Deposit*\n\nMinimum: *${MIN_DEPOSIT} ETB*\n\nChoose your bank:`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🏦 CBE Bank',          callback_data: 'bank_cbe'       }],
        [{ text: '📱 Telebirr',          callback_data: 'bank_telebirr'  }],
        [{ text: '🏛️ Bank of Abyssinia', callback_data: 'bank_abyssinia' }]
      ]}}
    );
  }

  if (data.startsWith('bank_')) {
    const bankKey = data.replace('bank_', '');
    const bank = BANKS[bankKey];
    if (!bank) return;
    await db.ref(`pendingDeposit/${userId}`).set({ bankKey, step: 'awaiting_amount', ts: Date.now() });
    bot.sendMessage(userId,
      `${bank.emoji} *${bank.name}*\n\nAccount: \`${bank.account}\`\nName: *${bank.holder}*\n\n1. Send at least *${MIN_DEPOSIT} ETB* to the account above\n2. Reply with the amount you sent\n\nExample: 100`,
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'invite') {
    const inviteLink = `https://t.me/Ethbingo_bot?start=ref_${userId}`;
    const snap = await db.ref(`users/${userId}`).once('value');
    const invBonus = snap.val()?.inviteBonus || 0;
    bot.sendMessage(userId,
      `👥 *Invite Friends and Earn!*\n\nFor every friend who joins you get +2 ETB bonus!\n\nYour bonus so far: *${invBonus} ETB*\n\nYour link:\n${inviteLink}`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '📤 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent('Join me on Ethbingo and win ETB!')}` }
      ]]}}
    );
  }

  if (data === 'leaderboard') {
    const snap = await db.ref('users').orderByChild('totalWon').limitToLast(10).once('value');
    const users = Object.values(snap.val() || {})
      .filter(u => !u.isBot) // hide bots from leaderboard
      .sort((a, b) => (b.totalWon || 0) - (a.totalWon || 0));
    let msg = '🏆 *Top Winners*\n\n';
    ['🥇','🥈','🥉'].forEach((m, i) => { if (users[i]) msg += `${m} ${users[i].name} — ${users[i].totalWon || 0} ETB\n`; });
    users.slice(3, 10).forEach((u, i) => { msg += `${i + 4}. ${u.name} — ${u.totalWon || 0} ETB\n`; });
    bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
  }

  if (data === 'instructions') {
    bot.sendMessage(userId,
      `📋 *How to Play Ethbingo*\n\n1. Deposit ETB to your account\n2. Tap Play Bingo\n3. Pick a number 1-100 (costs ${ENTRY_FEE} ETB)\n4. Wait for other players\n5. Balls called every 1.8 seconds\n6. First to complete a line wins ${WINNER_CUT * 100}% of the pot!\n\nDerash = how much the winner takes`,
      { parse_mode: 'Markdown' }
    );
  }

  if (data.startsWith('approve_')) {
    if (userId !== ADMIN_ID) return;
    const parts = data.split('_');
    const targetUserId = parts[1];
    const amount = parseInt(parts[2]);
    const depositId = parts[3];
    const userRef = db.ref(`users/${targetUserId}`);
    const user = (await userRef.once('value')).val();
    if (!user) return;
    const newBalance = (user.balance || 0) + amount;
    await userRef.update({ balance: newBalance, totalDeposited: (user.totalDeposited || 0) + amount });
    await db.ref(`deposits/${depositId}`).update({ status: 'approved', approvedAt: Date.now() });
    try { bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id }); } catch(e) {}
    bot.sendMessage(ADMIN_ID, `✅ Approved ${amount} ETB for ${user.name}. New balance: ${newBalance} ETB`);
    bot.sendMessage(parseInt(targetUserId),
      `✅ *Deposit Approved!*\n\nAmount: *${amount} ETB*\nNew Balance: *${newBalance} ETB*\n\nTap below to play!`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎯 Play Now', web_app: { url: MINI_APP_URL } }]] }}
    );
  }

  if (data.startsWith('reject_')) {
    if (userId !== ADMIN_ID) return;
    const parts = data.split('_');
    const targetUserId = parts[1];
    const depositId = parts[2];
    await db.ref(`deposits/${depositId}`).update({ status: 'rejected', rejectedAt: Date.now() });
    try { bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id }); } catch(e) {}
    bot.sendMessage(ADMIN_ID, `❌ Deposit rejected.`);
    bot.sendMessage(parseInt(targetUserId), `Your deposit was rejected. Contact support if you believe this is an error.`);
  }
});

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return;
  const userId = msg.from.id;
  const text = msg.text?.trim();
  if (!text) return;
  const pendingSnap = await db.ref(`pendingDeposit/${userId}`).once('value');
  const pending = pendingSnap.val();
  if (!pending) return;

  if (pending.step === 'awaiting_amount') {
    const amount = parseInt(text);
    if (isNaN(amount) || amount < MIN_DEPOSIT) {
      bot.sendMessage(userId, `Minimum is ${MIN_DEPOSIT} ETB. Please enter a valid amount.`);
      return;
    }
    await db.ref(`pendingDeposit/${userId}`).update({ step: 'awaiting_txn', amount });
    bot.sendMessage(userId, `Amount: ${amount} ETB confirmed.\n\nNow send your transaction reference or SMS confirmation.\n\nExample: FT25160PLPSH88713517`);
    return;
  }

  if (pending.step === 'awaiting_txn') {
    const bank = BANKS[pending.bankKey];
    const user = (await db.ref(`users/${userId}`).once('value')).val();
    const depositId = `dep_${userId}_${Date.now()}`;
    await db.ref(`deposits/${depositId}`).set({
      depositId, userId,
      userName: user?.name || msg.from.first_name,
      bankKey: pending.bankKey, bankName: bank.name,
      amount: pending.amount, txnRef: text,
      status: 'pending', submittedAt: Date.now()
    });
    await db.ref(`pendingDeposit/${userId}`).remove();
    bot.sendMessage(userId,
      `📋 *Deposit Submitted!*\n\nBank: ${bank.name}\nAmount: ${pending.amount} ETB\nReference: ${text}\n\n⏳ Will be verified within 5-15 minutes.`,
      { parse_mode: 'Markdown' }
    );
    try {
      await bot.sendMessage(ADMIN_ID,
        `🆕 *NEW DEPOSIT*\n\nPlayer: ${user?.name || msg.from.first_name} (@${msg.from.username || 'none'})\nBank: ${bank.name}\nAmount: ${pending.amount} ETB\nRef: ${text}\nUserID: ${userId}`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '✅ Approve ' + pending.amount + ' ETB', callback_data: 'approve_' + userId + '_' + pending.amount + '_' + depositId },
          { text: '❌ Reject', callback_data: 'reject_' + userId + '_' + depositId }
        ]]}}
      );
    } catch(err) {
      console.error('Admin notify failed:', err.message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/user', async (req, res) => {
  const { telegramId, name, username } = req.body;
  if (!telegramId) return res.status(400).json({ error: 'No telegramId' });
  const userRef = db.ref(`users/${telegramId}`);
  const snap = await userRef.once('value');
  if (!snap.exists()) {
    await userRef.set({ telegramId, name: name || 'Player', username: username || '', balance: 0, inviteBonus: 0, gamesPlayed: 0, gamesWon: 0, totalDeposited: 0, totalWon: 0, joinedAt: Date.now() });
  }
  res.json((await userRef.once('value')).val());
});

app.post('/api/join', async (req, res) => {
  const { telegramId } = req.body;
  const userRef = db.ref(`users/${telegramId}`);
  const user = (await userRef.once('value')).val();
  if (!user) return res.status(404).json({ error: 'User not found' });
  if ((user.balance || 0) < ENTRY_FEE) return res.status(400).json({ error: `Not enough ETB! Need ${ENTRY_FEE} ETB. Deposit first.` });

  // Deduct entry fee from real player
  await userRef.update({ balance: user.balance - ENTRY_FEE, gamesPlayed: (user.gamesPlayed || 0) + 1 });
  const potSnap = await db.ref('game/pot').once('value');
  const newPot = (potSnap.val() || 0) + ENTRY_FEE;
  await db.ref('game/pot').set(newPot);

  // Count real players and add bots if needed
  const playersSnap = await db.ref('lobby/players').once('value');
  const realCount = playersSnap.val() ? Object.keys(playersSnap.val()).filter(k => parseInt(k) > 0).length : 1;

  // Only add bots once (when first real player joins)
  if (realCount === 1 && activeGame.joinedBotIds.length === 0) {
    const joinedBotIds = await addBotsToLobby(realCount);
    activeGame.joinedBotIds = joinedBotIds;
    // Generate cartelas for bots
    for (const botId of joinedBotIds) {
      activeGame.botCartelas[botId] = generateBotCartela();
    }
  }

  console.log(`Real player ${telegramId} joined. Pot: ${newPot}`);
  res.json({ success: true, newBalance: user.balance - ENTRY_FEE });
});

app.post('/api/startgame', async (req, res) => {
  // Called by frontend when countdown finishes and game begins
  await db.ref('game').update({ started: true, startedAt: Date.now(), status: 'running', paidOut: false, winner: null });
  startGameLoop();
  res.json({ success: true });
});

app.post('/api/refund', async (req, res) => {
  const { telegramId } = req.body;
  const userRef = db.ref(`users/${telegramId}`);
  const user = (await userRef.once('value')).val();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const gameSnap = await db.ref('game/started').once('value');
  if (gameSnap.val()) return res.status(400).json({ error: 'Game already started' });
  const potSnap = await db.ref('game/pot').once('value');
  const pot = potSnap.val() || 0;
  if (pot < ENTRY_FEE) return res.status(400).json({ error: 'Nothing to refund' });
  const newBalance = (user.balance || 0) + ENTRY_FEE;
  await userRef.update({ balance: newBalance, gamesPlayed: Math.max(0, (user.gamesPlayed || 1) - 1) });
  await db.ref('game/pot').set(Math.max(0, pot - ENTRY_FEE));
  try { bot.sendMessage(parseInt(telegramId), `💸 *${ENTRY_FEE} ETB Refunded*\n\nThe game didn't start. Your entry fee has been returned.\n\nNew balance: ${newBalance} ETB`, { parse_mode: 'Markdown' }); } catch(e) {}
  res.json({ success: true, newBalance });
});

app.post('/api/payout', async (req, res) => {
  const { telegramId } = req.body;
  const paidSnap = await db.ref('game/paidOut').once('value');
  if (paidSnap.val()) return res.status(400).json({ error: 'Already paid out' });
  let pot = (await db.ref('game/pot').once('value')).val() || 0;
  if (!pot) {
    const ps = await db.ref('lobby/players').once('value');
    pot = (ps.val() ? Object.keys(ps.val()).length : 0) * ENTRY_FEE;
  }
  const winnings = Math.floor(pot * WINNER_CUT);
  const userRef = db.ref(`users/${telegramId}`);
  const user = (await userRef.once('value')).val();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const newBalance = (user.balance || 0) + winnings;
  await userRef.update({ balance: newBalance, gamesWon: (user.gamesWon || 0) + 1, totalWon: (user.totalWon || 0) + winnings });
  await db.ref('game/paidOut').set(true);
  await db.ref('game/winner').set({ isBot: false, telegramId, winnings });

  // Stop bot game loop since real player won
  if (activeGame.interval) {
    clearInterval(activeGame.interval);
    activeGame.running = false;
  }

  // Reset active game state for next round
  activeGame = { running: false, calledNumbers: [], botCartelas: {}, joinedBotIds: [], interval: null };

  try {
    bot.sendMessage(parseInt(telegramId),
      `🎉 *BINGO! You Won!*\n\n🏆 Winnings: *${winnings} ETB* (80% of ${pot} ETB pot)\n💳 New Balance: *${newBalance} ETB*\n\n🎊 Congratulations!`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🎯 Play Again', web_app: { url: MINI_APP_URL } }]] }}
    );
  } catch(e) {}
  res.json({ success: true, winnings, newBalance });
});

app.get('/api/balance/:telegramId', async (req, res) => {
  const snap = await db.ref(`users/${req.params.telegramId}`).once('value');
  if (!snap.exists()) return res.status(404).json({ error: 'Not found' });
  res.json({ balance: snap.val().balance, name: snap.val().name });
});

// Reset game state (called between games)
app.post('/api/resetgame', async (req, res) => {
  if (activeGame.interval) clearInterval(activeGame.interval);
  activeGame = { running: false, calledNumbers: [], botCartelas: {}, joinedBotIds: [], interval: null };
  await db.ref('game').set({ pot: 0, started: false, paidOut: false, status: 'waiting', calledNumbers: [], lastCalled: null, winner: null });
  res.json({ success: true });
});

app.listen(process.env.PORT || 3000, () => console.log('🎰 Ethbingo running!'));
