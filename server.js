const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));
app.get('/', (req, res) => res.sendFile(path.resolve('./index.html')));

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
const LOBBY_SECS   = 30;
const BALL_MS      = 1800;

const BANKS = {
  cbe:       { name: 'CBE Bank',          emoji: '🏦', account: '1000605418159', holder: 'Dawit Mamo' },
  telebirr:  { name: 'Telebirr',          emoji: '📱', account: '0980462375',    holder: 'Dawit Mamo' },
  abyssinia: { name: 'Bank of Abyssinia', emoji: '🏛️', account: '206543108',     holder: 'Dawit Mamo' }
};

// ─────────────────────────────────────────────────────────────────────────────
// BOTS
// ─────────────────────────────────────────────────────────────────────────────
const BOTS = [
  { id:-1,  name:'Abebe',   num:7  },
  { id:-2,  name:'Meron',   num:14 },
  { id:-3,  name:'Dawit B', num:23 },
  { id:-4,  name:'Sara',    num:31 },
  { id:-5,  name:'Yonas',   num:45 },
  { id:-6,  name:'Tigist',  num:52 },
  { id:-7,  name:'Bereket', num:63 },
  { id:-8,  name:'Hana',    num:71 },
  { id:-9,  name:'Kaleab',  num:82 },
  { id:-10, name:'Lidya',   num:91 },
];

async function ensureBots() {
  for (const b of BOTS) {
    const ref  = db.ref(`users/${b.id}`);
    const snap = await ref.once('value');
    if (!snap.exists()) {
      await ref.set({ telegramId:b.id, name:b.name, username:b.name.toLowerCase(),
        balance:50000, isBot:true, gamesPlayed:0, gamesWon:0,
        totalDeposited:50000, totalWon:0, joinedAt:Date.now() });
    } else if ((snap.val().balance||0) < 500) {
      await ref.update({ balance:50000 });
    }
  }
}

function mkCartela() {
  const sh = a=>{const b=[...a];for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];}return b;};
  const rng= (a,b)=>Array.from({length:b-a+1},(_,i)=>i+a);
  const c = [sh(rng(1,15)).slice(0,5), sh(rng(16,30)).slice(0,5),
             sh(rng(31,45)).slice(0,5), sh(rng(46,60)).slice(0,5),
             sh(rng(61,75)).slice(0,5)];
  c[2][2]='FREE'; return c;
}

function hasBingo(card, called) {
  // card is column-major: card[col][row]
  // card[col] is an array of 5 numbers for that column
  // called is a flat array of called numbers

  const hit = (col, row) => {
    const val = card[col][row];
    return val === 'FREE' || called.includes(val);
  };

  // Check 5 rows (horizontal lines)
  for (let row = 0; row < 5; row++) {
    if ([0,1,2,3,4].every(col => hit(col, row))) return true;
  }
  // Check 5 columns (vertical lines)
  for (let col = 0; col < 5; col++) {
    if ([0,1,2,3,4].every(row => hit(col, row))) return true;
  }
  // Top-left to bottom-right diagonal
  if ([0,1,2,3,4].every(i => hit(i, i))) return true;
  // Top-right to bottom-left diagonal
  if ([0,1,2,3,4].every(i => hit(i, 4-i))) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// GAME ENGINE — one function that runs the whole cycle forever
// ─────────────────────────────────────────────────────────────────────────────
let engine = { running:false, botCards:{}, called:[], won:false, ballTimer:null };

async function runGameCycle() {
  if (engine.running) return;
  engine.running = true;

  try {
    await doLobby();
    if (!engine.won) await doGame();
  } catch(e) {
    console.error('Engine error:', e.message);
  }

  engine.running = false;
  // Always restart — 5 second gap between games
  console.log('♻️  Next game in 5s...');
  setTimeout(runGameCycle, 5000);
}

// ── PHASE 1: LOBBY ────────────────────────────────────────────────────────────
async function doLobby() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━');
  engine.botCards = {};
  engine.called   = [];
  engine.won      = false;
  if (engine.ballTimer) { clearInterval(engine.ballTimer); engine.ballTimer=null; }

  // Increment game counter
  const cSnap = await db.ref('gameCounter').once('value');
  const gameNum = (cSnap.val()||0) + 1;
  await db.ref('gameCounter').set(gameNum);

  // Clear previous game data
  await db.ref('game').remove();
  await db.ref('lobby').remove();

  // Set initial state — game NOT started yet so players CAN join
  await db.ref('game').set({
    started: false, paidOut: false, winner: null,
    pot: 0, balls: null, ballCount: 0,
    countdown: LOBBY_SECS, gameNum,
    phase: 'lobby'
  });

  // Add bots to lobby (all 10) — they show in lobby/players so frontend sees them
  let pot = 0;
  for (const b of BOTS) {
    // Deduct fee from bot
    const ref  = db.ref(`users/${b.id}`);
    const snap = await ref.once('value');
    const bal  = snap.val()?.balance || 50000;
    await ref.update({ balance: Math.max(0, bal - ENTRY_FEE), gamesPlayed:(snap.val()?.gamesPlayed||0)+1 });
    pot += ENTRY_FEE;

    // Write to lobby so frontend picker shows them as taken
    await db.ref(`lobby/players/${b.num}`).set({
      boardNum: b.num, telegramId: b.id, name: b.name,
      isBot: true, joinedAt: Date.now(), lastSeen: Date.now()
    });
    await db.ref(`lobby/taken/${b.num}`).set(b.num);
    engine.botCards[b.id] = mkCartela();
  }

  await db.ref('game/pot').set(pot);
  console.log(`🎰 Game #${gameNum} lobby open — 10 bots joined — pot: ${pot} ETB`);

  // Countdown: tick every second, write to Firebase so all frontends sync
  await new Promise(resolve => {
    let secs = LOBBY_SECS;
    const tick = setInterval(async () => {
      secs--;
      await db.ref('game/countdown').set(secs);
      if (secs % 10 === 0) console.log(`⏱  Countdown: ${secs}s`);
      if (secs <= 0) {
        clearInterval(tick);
        resolve();
      }
    }, 1000);
  });
}

// ── PHASE 2: GAME ─────────────────────────────────────────────────────────────
async function doGame() {
  // Get current pot (may have real players added)
  const potSnap = await db.ref('game/pot').once('value');
  const pot     = potSnap.val() || 0;

  await db.ref('game').update({
    started: true, startedAt: Date.now(),
    lastBallAt: Date.now()-1500, ballCount: 0,
    pot, phase: 'playing'
  });

  const playersSnap = await db.ref('lobby/players').once('value');
  const playerCount = Object.keys(playersSnap.val()||{}).length;
  console.log(`▶️  Game started — ${playerCount} players — pot: ${pot} ETB`);

  const pool = Array.from({length:75},(_,i)=>i+1);
  engine.called = [];
  engine.won    = false;

  await new Promise(resolve => {
    engine.ballTimer = setInterval(async () => {
      if (engine.won) { resolve(); return; }

      // Check if real player already won
      const paidSnap = await db.ref('game/paidOut').once('value');
      if (paidSnap.val()) { engine.won=true; resolve(); return; }

      const remaining = pool.filter(n => !engine.called.includes(n));
      if (!remaining.length) { resolve(); return; }

      const n = remaining[Math.floor(Math.random()*remaining.length)];
      engine.called.push(n);

      // Write ball to Firebase — frontend reads this
      await db.ref('game/balls').push(n);
      await db.ref('game').update({ lastBallAt:Date.now(), ballCount:engine.called.length });

      // Check bots for win — need at least 4 called numbers for any possible bingo
      // (FREE counts as 1, so minimum 4 more needed for a line of 5)
      if (engine.called.length < 4) return;
      for (const [botId, card] of Object.entries(engine.botCards)) {
        if (hasBingo(card, engine.called)) {
          engine.won = true;
          clearInterval(engine.ballTimer);
          engine.ballTimer = null;
          await payBot(parseInt(botId), pot);
          resolve();
          return;
        }
      }
    }, BALL_MS);
  });

  if (engine.ballTimer) { clearInterval(engine.ballTimer); engine.ballTimer=null; }
}

async function payBot(botId, pot) {
  const paidSnap = await db.ref('game/paidOut').once('value');
  if (paidSnap.val()) return; // real player won first

  // Double-verify the bot actually has bingo before paying
  const botCard = engine.botCards[botId];
  if (!botCard || !hasBingo(botCard, engine.called)) {
    console.log(`⚠️  Bot ${botId} bingo double-check FAILED — skipping payout`);
    return;
  }

  const winnings = Math.floor(pot * WINNER_CUT);
  const bot      = BOTS.find(b => b.id === botId);
  const ref      = db.ref(`users/${botId}`);
  const snap     = await ref.once('value');

  await ref.update({
    balance: (snap.val()?.balance||0) + winnings,
    gamesWon: (snap.val()?.gamesWon||0) + 1,
    totalWon: (snap.val()?.totalWon||0) + winnings
  });

  // Write winner info including the bot's cartela so frontend can display it
  await db.ref('game').update({
    paidOut: true,
    winner: {
      boardNum:   bot.num,
      telegramId: botId,
      name:       bot.name,
      isBot:      true,
      winnings,
      ts:         Date.now(),
      card:       botCard,          // bot's full cartela
      calledNums: engine.called     // all called numbers at time of win
    }
  });

  console.log(`🤖 Bot ${bot.name} won ${winnings} ETB`);
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM BOT
// ─────────────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling:{autoStart:false, params:{timeout:10}} });

bot.stopPolling()
  .then(() => new Promise(r=>setTimeout(r,2000)))
  .then(() => bot.startPolling())
  .then(async () => {
    console.log('✅ Bot started. Admin:', ADMIN_ID);
    await ensureBots();
    runGameCycle(); // 🚀 Start game engine
  })
  .catch(err => { console.error('Poll error:', err.message); setTimeout(()=>bot.startPolling(),5000); });

bot.onText(/\/start/, async msg => {
  const uid = msg.from.id, name = msg.from.first_name||'Player';
  const ref = db.ref(`users/${uid}`);
  const sn  = await ref.once('value');
  if (!sn.exists()) await ref.set({ telegramId:uid, name, username:msg.from.username||'',
    balance:0, inviteBonus:0, gamesPlayed:0, gamesWon:0, totalDeposited:0, totalWon:0, joinedAt:Date.now() });
  const startParam = msg.text?.split(' ')[1];
  if (startParam?.startsWith('ref_') && !sn.exists()) {
    const rid = startParam.replace('ref_','');
    if (rid !== String(uid)) {
      const rref = db.ref(`users/${rid}`), rsnap = await rref.once('value');
      if (rsnap.exists()) {
        await rref.update({ inviteBonus:(rsnap.val().inviteBonus||0)+2 });
        try { bot.sendMessage(parseInt(rid),`Someone joined with your invite! +2 ETB bonus`); } catch(e){}
      }
    }
  }
  const user = (await ref.once('value')).val();
  await bot.sendMessage(uid,
    `🎰 *Welcome to Ethbingo, ${name}!*\n\n💰 Balance: *${user.balance} ETB*\n🎮 Entry fee: *${ENTRY_FEE} ETB per game*\n🏆 Winner takes: *${WINNER_CUT*100}% of the pot*\n\nDeposit ETB to start playing!`,
    { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
      [{text:'🎯 Play Bingo', web_app:{url:MINI_APP_URL}}],
      [{text:'💰 Deposit ETB',callback_data:'deposit'},{text:'💳 My Balance',callback_data:'balance'}],
      [{text:'🏆 Leaderboard',callback_data:'leaderboard'},{text:'📋 Instructions',callback_data:'instructions'}],
      [{text:'👥 Invite Friends +2 ETB',callback_data:'invite'}]
    ]}}
  );
});

bot.on('callback_query', async query => {
  const uid=query.from.id, data=query.data;
  await bot.answerCallbackQuery(query.id);

  if (data==='balance') {
    const sn=await db.ref(`users/${uid}`).once('value'), u=sn.val();
    if (!u){bot.sendMessage(uid,'Please send /start first.');return;}
    bot.sendMessage(uid,
      `💳 *Your Account*\n\nBalance: *${u.balance} ETB*\nInvite Bonus: *${u.inviteBonus||0} ETB*\nGames Played: *${u.gamesPlayed||0}*\nGames Won: *${u.gamesWon||0}*\nTotal Deposited: *${u.totalDeposited||0} ETB*\nTotal Won: *${u.totalWon||0} ETB*`,
      {parse_mode:'Markdown'});
  }
  if (data==='deposit') {
    bot.sendMessage(uid,`💰 *Make a Deposit*\n\nMinimum: *${MIN_DEPOSIT} ETB*\n\nChoose your bank:`,
      {parse_mode:'Markdown', reply_markup:{inline_keyboard:[
        [{text:'🏦 CBE Bank',callback_data:'bank_cbe'}],
        [{text:'📱 Telebirr',callback_data:'bank_telebirr'}],
        [{text:'🏛️ Bank of Abyssinia',callback_data:'bank_abyssinia'}]
      ]}});
  }
  if (data.startsWith('bank_')) {
    const bk=data.replace('bank_',''), bank=BANKS[bk]; if (!bank) return;
    await db.ref(`pendingDeposit/${uid}`).set({bankKey:bk, step:'awaiting_amount', ts:Date.now()});
    bot.sendMessage(uid,`${bank.emoji} *${bank.name}*\n\nAccount: \`${bank.account}\`\nName: *${bank.holder}*\n\n1. Send at least *${MIN_DEPOSIT} ETB* to the account above\n2. Reply with the amount you sent\n\nExample: 100`,{parse_mode:'Markdown'});
  }
  if (data==='invite') {
    const lnk=`https://t.me/Ethbingo_bot?start=ref_${uid}`;
    const sn=await db.ref(`users/${uid}`).once('value');
    bot.sendMessage(uid,`👥 *Invite Friends and Earn!*\n\nFor every friend who joins you get +2 ETB!\n\nYour bonus: *${sn.val()?.inviteBonus||0} ETB*\n\nYour link:\n${lnk}`,
      {parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:'📤 Share Link',url:`https://t.me/share/url?url=${encodeURIComponent(lnk)}&text=${encodeURIComponent('Join me on Ethbingo and win ETB!')}`}]]}});
  }
  if (data==='leaderboard') {
    const sn=await db.ref('users').orderByChild('totalWon').limitToLast(10).once('value');
    const list=Object.values(sn.val()||{}).filter(u=>!u.isBot).sort((a,b)=>(b.totalWon||0)-(a.totalWon||0));
    let msg='🏆 *Top Winners*\n\n';
    ['🥇','🥈','🥉'].forEach((m,i)=>{if(list[i])msg+=`${m} ${list[i].name} — ${list[i].totalWon||0} ETB\n`;});
    list.slice(3,10).forEach((u,i)=>{msg+=`${i+4}. ${u.name} — ${u.totalWon||0} ETB\n`;});
    bot.sendMessage(uid,msg,{parse_mode:'Markdown'});
  }
  if (data==='instructions') {
    bot.sendMessage(uid,`📋 *How to Play Ethbingo*\n\n1. Deposit ETB to your account\n2. Tap Play Bingo\n3. Pick a number 1-100 (costs ${ENTRY_FEE} ETB)\n4. Wait for game to start (30s)\n5. Balls called every 1.8 seconds\n6. First to complete a line wins ${WINNER_CUT*100}% of the pot!\n\nGames run 24/7 automatically!`,{parse_mode:'Markdown'});
  }
  if (data.startsWith('approve_')) {
    if (uid!==ADMIN_ID) return;
    const p=data.split('_'), tuid=p[1], amt=parseInt(p[2]), did=p[3];
    const uref=db.ref(`users/${tuid}`), u=(await uref.once('value')).val(); if (!u) return;
    const nb=(u.balance||0)+amt;
    await uref.update({balance:nb, totalDeposited:(u.totalDeposited||0)+amt});
    await db.ref(`deposits/${did}`).update({status:'approved',approvedAt:Date.now()});
    try{bot.editMessageReplyMarkup({inline_keyboard:[]},{chat_id:ADMIN_ID,message_id:query.message.message_id});}catch(e){}
    bot.sendMessage(ADMIN_ID,`✅ Approved ${amt} ETB for ${u.name}. New balance: ${nb} ETB`);
    bot.sendMessage(parseInt(tuid),`✅ *Deposit Approved!*\n\nAmount: *${amt} ETB*\nNew Balance: *${nb} ETB*\n\nTap below to play!`,
      {parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:'🎯 Play Now',web_app:{url:MINI_APP_URL}}]]}});
  }
  if (data.startsWith('reject_')) {
    if (uid!==ADMIN_ID) return;
    const p=data.split('_'), tuid=p[1], did=p[2];
    await db.ref(`deposits/${did}`).update({status:'rejected',rejectedAt:Date.now()});
    try{bot.editMessageReplyMarkup({inline_keyboard:[]},{chat_id:ADMIN_ID,message_id:query.message.message_id});}catch(e){}
    bot.sendMessage(ADMIN_ID,'❌ Deposit rejected.');
    bot.sendMessage(parseInt(tuid),'Your deposit was rejected. Contact support if you believe this is an error.');
  }
});

bot.on('message', async msg => {
  if (msg.text?.startsWith('/')) return;
  const uid=msg.from.id, text=msg.text?.trim(); if (!text) return;
  const psn=await db.ref(`pendingDeposit/${uid}`).once('value'), pend=psn.val(); if (!pend) return;
  if (pend.step==='awaiting_amount') {
    const amt=parseInt(text);
    if (isNaN(amt)||amt<MIN_DEPOSIT){bot.sendMessage(uid,`Minimum is ${MIN_DEPOSIT} ETB. Please enter a valid amount.`);return;}
    await db.ref(`pendingDeposit/${uid}`).update({step:'awaiting_txn',amount:amt});
    bot.sendMessage(uid,`Amount: ${amt} ETB confirmed.\n\nNow send your transaction reference or SMS confirmation.\n\nExample: FT25160PLPSH88713517`);
    return;
  }
  if (pend.step==='awaiting_txn') {
    const bank=BANKS[pend.bankKey], user=(await db.ref(`users/${uid}`).once('value')).val();
    const did=`dep_${uid}_${Date.now()}`;
    await db.ref(`deposits/${did}`).set({depositId:did,userId:uid,userName:user?.name||msg.from.first_name,
      bankKey:pend.bankKey,bankName:bank.name,amount:pend.amount,txnRef:text,status:'pending',submittedAt:Date.now()});
    await db.ref(`pendingDeposit/${uid}`).remove();
    bot.sendMessage(uid,`📋 *Deposit Submitted!*\n\nBank: ${bank.name}\nAmount: ${pend.amount} ETB\nReference: ${text}\n\n⏳ Will be verified within 5-15 minutes.`,{parse_mode:'Markdown'});
    try {
      await bot.sendMessage(ADMIN_ID,
        `🆕 *NEW DEPOSIT*\n\nPlayer: ${user?.name||msg.from.first_name} (@${msg.from.username||'none'})\nBank: ${bank.name}\nAmount: ${pend.amount} ETB\nRef: ${text}\nUserID: ${uid}`,
        {parse_mode:'Markdown', reply_markup:{inline_keyboard:[[
          {text:`✅ Approve ${pend.amount} ETB`,callback_data:`approve_${uid}_${pend.amount}_${did}`},
          {text:'❌ Reject',callback_data:`reject_${uid}_${did}`}
        ]]}});
    } catch(e){console.error('Admin notify failed:',e.message);}
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/user', async (req,res) => {
  const {telegramId,name,username}=req.body;
  if (!telegramId) return res.status(400).json({error:'No telegramId'});
  const ref=db.ref(`users/${telegramId}`), sn=await ref.once('value');
  if (!sn.exists()) await ref.set({telegramId,name:name||'Player',username:username||'',
    balance:0,inviteBonus:0,gamesPlayed:0,gamesWon:0,totalDeposited:0,totalWon:0,joinedAt:Date.now()});
  res.json((await ref.once('value')).val());
});

app.post('/api/join', async (req,res) => {
  const {telegramId}=req.body;

  // Don't allow joining if game already started
  const gSn=await db.ref('game/started').once('value');
  if (gSn.val()===true) return res.status(400).json({error:'Game already started. Wait for next game.'});

  const ref=db.ref(`users/${telegramId}`), u=(await ref.once('value')).val();
  if (!u) return res.status(404).json({error:'User not found'});
  if ((u.balance||0)<ENTRY_FEE) return res.status(400).json({error:`Not enough ETB! Need ${ENTRY_FEE} ETB.`});

  const nb=u.balance-ENTRY_FEE;
  await ref.update({balance:nb, gamesPlayed:(u.gamesPlayed||0)+1});

  // Add to pot
  const pSn=await db.ref('game/pot').once('value');
  await db.ref('game/pot').set((pSn.val()||0)+ENTRY_FEE);

  console.log(`👤 Real player ${u.name} joined. Balance: ${nb}`);
  res.json({success:true, newBalance:nb});
});

app.post('/api/payout', async (req,res) => {
  const {telegramId}=req.body;
  const pSn=await db.ref('game/paidOut').once('value');
  if (pSn.val()) return res.status(400).json({error:'Already paid out'});

  // Stop engine from paying a bot
  engine.won=true;
  if (engine.ballTimer){clearInterval(engine.ballTimer);engine.ballTimer=null;}

  const pot=(await db.ref('game/pot').once('value')).val()||0;
  const win=Math.floor(pot*WINNER_CUT);
  const ref=db.ref(`users/${telegramId}`), u=(await ref.once('value')).val();
  if (!u) return res.status(404).json({error:'User not found'});

  const nb=(u.balance||0)+win;
  await ref.update({balance:nb, gamesWon:(u.gamesWon||0)+1, totalWon:(u.totalWon||0)+win});
  await db.ref('game').update({paidOut:true,
    winner:{boardNum:null,telegramId,name:u.name,isBot:false,winnings:win,ts:Date.now()}});

  try {
    bot.sendMessage(parseInt(telegramId),
      `🎉 *BINGO! You Won!*\n\n🏆 Winnings: *${win} ETB*\n💳 New Balance: *${nb} ETB*\n\n🎊 Congratulations!`,
      {parse_mode:'Markdown', reply_markup:{inline_keyboard:[[{text:'🎯 Play Again',web_app:{url:MINI_APP_URL}}]]}});
  } catch(e){}

  console.log(`🎉 Real player ${u.name} won ${win} ETB!`);
  res.json({success:true, winnings:win, newBalance:nb});
});

app.post('/api/refund', async (req,res) => {
  const {telegramId}=req.body;
  const gSn=await db.ref('game/started').once('value');
  if (gSn.val()) return res.status(400).json({error:'Game already started'});
  const ref=db.ref(`users/${telegramId}`), u=(await ref.once('value')).val();
  if (!u) return res.status(404).json({error:'User not found'});
  const pSn=await db.ref('game/pot').once('value'), pot=pSn.val()||0;
  if (pot<ENTRY_FEE) return res.status(400).json({error:'Nothing to refund'});
  const nb=(u.balance||0)+ENTRY_FEE;
  await ref.update({balance:nb, gamesPlayed:Math.max(0,(u.gamesPlayed||1)-1)});
  await db.ref('game/pot').set(Math.max(0,pot-ENTRY_FEE));
  try{bot.sendMessage(parseInt(telegramId),`💸 ${ENTRY_FEE} ETB Refunded. New balance: ${nb} ETB`);}catch(e){}
  res.json({success:true, newBalance:nb});
});

app.get('/api/balance/:telegramId', async (req,res) => {
  const sn=await db.ref(`users/${req.params.telegramId}`).once('value');
  if (!sn.exists()) return res.status(404).json({error:'Not found'});
  res.json({balance:sn.val().balance, name:sn.val().name});
});

app.listen(process.env.PORT||3000, ()=>console.log('🎰 Ethbingo running!'));
