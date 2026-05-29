// ─────────────────────────────────────────────────────────────────────────────
// bot-manager.js — Add this file to your Eth-bingo project
// Bingo-playing bots that pay real entry fees and can win real games
// ─────────────────────────────────────────────────────────────────────────────

const admin = require('firebase-admin');

const db = admin.database(); // reuses your existing firebase init

const ENTRY_FEE  = 10;
const WINNER_CUT = 0.80;
const MINI_APP_URL = process.env.MINI_APP_URL;

// ── Bot accounts stored in Firebase under users/ ──────────────────────────────
// Each bot is a real "user" with a balance, just like a human player.
// Bot IDs use negative numbers so they never clash with real Telegram IDs.
const BOTS = [
  { id: -1, name: 'Abebe',   emoji: '🤖' },
  { id: -2, name: 'Meron',   emoji: '🤖' },
  { id: -3, name: 'Dawit',   emoji: '🤖' },
  { id: -4, name: 'Sara',    emoji: '🤖' },
  { id: -5, name: 'Yonas',   emoji: '🤖' },
  { id: -6, name: 'Tigist',  emoji: '🤖' },
  { id: -7, name: 'Bereket', emoji: '🤖' },
  { id: -8, name: 'Hana',    emoji: '🤖' },
  { id: -9, name: 'Kaleab',  emoji: '🤖' },
  { id: -10, name: 'Lidya',  emoji: '🤖' },
];

// ── How many bots to add based on real player count ───────────────────────────
function getBotCount(realPlayerCount) {
  if (realPlayerCount >= 20) return 0;   // enough real players, no bots needed
  if (realPlayerCount >= 10) return 5;   // top up to ~15
  if (realPlayerCount >= 5)  return 8;   // top up to ~13
  if (realPlayerCount >= 2)  return 10;  // top up to ~12
  return 12;                             // very few players, add 12 bots
}

// ── Initialize bot accounts in Firebase (run once on server start) ───────────
async function initBots() {
  for (const bot of BOTS) {
    const ref = db.ref(`users/${bot.id}`);
    const snap = await ref.once('value');
    if (!snap.exists()) {
      await ref.set({
        telegramId: bot.id,
        name: bot.name,
        username: bot.name.toLowerCase(),
        balance: 10000,        // give each bot 10,000 ETB starting balance
        isBot: true,
        gamesPlayed: 0,
        gamesWon: 0,
        totalDeposited: 10000,
        totalWon: 0,
        joinedAt: Date.now()
      });
      console.log(`Bot ${bot.name} initialized`);
    } else {
      // Top up bot balance if running low
      const balance = snap.val().balance || 0;
      if (balance < 100) {
        await ref.update({ balance: 10000 });
        console.log(`Bot ${bot.name} topped up`);
      }
    }
  }
  console.log('All bots ready');
}

// ── Bot joins game — deducts 10 ETB from bot balance, adds to pot ─────────────
async function botJoinGame(botId) {
  const botRef = db.ref(`users/${botId}`);
  const bot = (await botRef.once('value')).val();
  if (!bot || bot.balance < ENTRY_FEE) {
    await botRef.update({ balance: 10000 }); // auto top up
    return false;
  }
  await botRef.update({
    balance: bot.balance - ENTRY_FEE,
    gamesPlayed: (bot.gamesPlayed || 0) + 1
  });
  const potSnap = await db.ref('game/pot').once('value');
  const newPot = (potSnap.val() || 0) + ENTRY_FEE;
  await db.ref('game/pot').set(newPot);
  console.log(`Bot ${bot.name} joined. Pot now: ${newPot} ETB`);
  return true;
}

// ── Bot wins — gets paid just like a real player ──────────────────────────────
async function botWinGame(botId) {
  const paidSnap = await db.ref('game/paidOut').once('value');
  if (paidSnap.val()) return; // already paid out

  const pot = (await db.ref('game/pot').once('value')).val() || 0;
  const winnings = Math.floor(pot * WINNER_CUT);

  const botRef = db.ref(`users/${botId}`);
  const bot = (await botRef.once('value')).val();
  const newBalance = (bot.balance || 0) + winnings;

  await botRef.update({
    balance: newBalance,
    gamesWon: (bot.gamesWon || 0) + 1,
    totalWon: (bot.totalWon || 0) + winnings
  });
  await db.ref('game/paidOut').set(true);
  console.log(`Bot ${bot.name} won ${winnings} ETB. New balance: ${newBalance} ETB`);
}

// ── Main function: called when a new game lobby opens ────────────────────────
// Pass in the real player count and the list of already-joined bot IDs
async function addBotsToLobby(realPlayerCount, alreadyJoinedBotIds = []) {
  const needed = getBotCount(realPlayerCount);
  if (needed === 0) return [];

  // Pick bots not already in this game
  const availableBots = BOTS.filter(b => !alreadyJoinedBotIds.includes(b.id));
  const botsToAdd = availableBots.slice(0, needed);

  const joinedBots = [];
  for (const bot of botsToAdd) {
    // Add small random delay so bots don't all join at exactly the same time
    await new Promise(r => setTimeout(r, Math.random() * 2000 + 500));
    const joined = await botJoinGame(bot.id);
    if (joined) joinedBots.push(bot.id);
  }
  console.log(`Added ${joinedBots.length} bots to lobby`);
  return joinedBots;
}

// ── Generate a random bingo cartela for a bot ─────────────────────────────────
function generateBotCartela() {
  const shuffle = arr => { const b=[...arr]; for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];} return b; };
  const range = (a,b) => Array.from({length:b-a+1},(_,i)=>i+a);
  const cols = [
    shuffle(range(1,15)).slice(0,5),
    shuffle(range(16,30)).slice(0,5),
    shuffle(range(31,45)).slice(0,5),
    shuffle(range(46,60)).slice(0,5),
    shuffle(range(61,75)).slice(0,5),
  ];
  cols[2][2] = 'FREE';
  return cols;
}

// ── Check if a cartela has bingo given called numbers ─────────────────────────
function checkBotBingo(cartela, called) {
  const hit = (c,r) => cartela[c][r] === 'FREE' || called.includes(cartela[c][r]);
  for(let r=0;r<5;r++) if([0,1,2,3,4].every(c=>hit(c,r))) return true;
  for(let c=0;c<5;c++) if([0,1,2,3,4].every(r=>hit(c,r))) return true;
  if([0,1,2,3,4].every(i=>hit(i,i))) return true;
  if([0,1,2,3,4].every(i=>hit(i,4-i))) return true;
  return false;
}

// ── Simulate bot playing a game ───────────────────────────────────────────────
// Call this when game starts. Pass calledNumbers as they come in.
// Returns the winning botId if a bot wins, or null.
function checkBotsForWin(botCartelas, calledNumbers) {
  for (const [botId, cartela] of Object.entries(botCartelas)) {
    if (checkBotBingo(cartela, calledNumbers)) {
      return parseInt(botId);
    }
  }
  return null;
}

// ── Example: how to use in a game round ──────────────────────────────────────
// 
// STEP 1: When lobby opens, count real players then add bots:
//   const joinedBotIds = await addBotsToLobby(realPlayerCount);
//
// STEP 2: Generate cartelas for each joined bot:
//   const botCartelas = {};
//   for (const botId of joinedBotIds) {
//     botCartelas[botId] = generateBotCartela();
//   }
//
// STEP 3: As numbers are called, check if any bot won:
//   const winningBotId = checkBotsForWin(botCartelas, calledNumbersSoFar);
//   if (winningBotId && !gameEnded) {
//     gameEnded = true;
//     await botWinGame(winningBotId);
//     // tell frontend game is over
//   }
//
// STEP 4: If a REAL player wins before any bot:
//   // just call your existing /api/payout endpoint as normal
//   // bot money stays in the pot and goes to the real winner — that's the point!

module.exports = {
  initBots,
  addBotsToLobby,
  botJoinGame,
  botWinGame,
  generateBotCartela,
  checkBotsForWin,
  getBotCount,
  BOTS
};
