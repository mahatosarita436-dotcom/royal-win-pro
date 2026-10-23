const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname)));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/royalwin";
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas successfully!'))[cite: 3]
  .catch(err => console.error('❌ MongoDB Connection Error:', err));[cite: 3]

const userSchema = new mongoose.Schema({
  userId: String,
  name: String,
  phone: { type: String, unique: true },
  password: String,
  balance: { type: Number, default: 10 }
});
const User = mongoose.model('User', userSchema);

const txSchema = new mongoose.Schema({
  id: Number,
  phone: String,
  userName: String,
  type: String,
  amount: Number,
  tax: Number,
  totalDeducted: Number,
  details: String,
  status: String,
  time: String
});
const Transaction = mongoose.model('Transaction', txSchema);

const supportSchema = new mongoose.Schema({
  id: Number,
  phone: String,
  userName: String,
  message: String,
  status: { type: String, default: 'PENDING' },
  time: String
});
const SupportTicket = mongoose.model('SupportTicket', supportSchema);

let gameState = {
  period: 20261017001,
  timeLeft: 30,
  mode: 'MIN_PAYOUT',
  forcedNumber: null,
  history: [
    { period: 20261017000, number: 7, colours: ['GREEN'] },
    { period: 20261016999, number: 2, colours: ['RED'] }
  ]
};

let kismatState = {
  period: 20261017001,
  timeLeft: 30,
  history: []
};
let currentKismatBets = [];
let forcedKismatOption = null;

let rocketState = {
  status: 'WAITING',
  countdown: 5.0,
  multiplier: 1.00,
  crashPoint: 2.50,
  forcedNextCrash: null,
  history: [1.15, 1.05, 1.20, 1.02, 2.05]
};

let currentRoundBets = [];
let rocketBets = [];
let cachedUsers = new Map();
let allTransactions = [];
let allSupportTickets = [];

async function loadDataFromDB() {
  try {
    const usersList = await User.find({});
    usersList.forEach(u => cachedUsers.set(u.phone, u));
    allTransactions = await Transaction.find({}).sort({ id: -1 }).limit(100);
    allSupportTickets = await SupportTicket.find({}).sort({ id: -1 }).limit(100);
    console.log(`✅ Loaded ${cachedUsers.size} users, transactions, and support tickets from MongoDB.`);
  } catch (e) {
    console.log('Error loading DB data:', e);
  }
}
loadDataFromDB();

function getColoursForNumber(num) {
  if (num === 0) return ['RED', 'VIOLET'];
  if (num === 5) return ['GREEN', 'VIOLET'];
  return [1, 3, 7, 9].includes(num) ? ['GREEN'] : ['RED'];
}

function calculatePayoutForNumber(num) {
  const cols = getColoursForNumber(num);
  let totalPayout = 0;
  for (const b of currentRoundBets) {
    if (b.choice === String(num)) totalPayout += b.amount * 9;
    else if (cols.includes(b.choice)) totalPayout += b.amount * b.multiplier;
  }
  return totalPayout;
}

function getRoundSummary() {
  const summary = {
    totalBetsCount: currentRoundBets.length,
    totalPoolAmount: 0,
    stakes: { GREEN: 0, VIOLET: 0, RED: 0, 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0 },
    projectedPayouts: {}
  };
  for (const b of currentRoundBets) {
    summary.totalPoolAmount += b.amount;
    if (summary.stakes[b.choice] !== undefined) summary.stakes[b.choice] += b.amount;
  }
  for (let n = 0; n <= 9; n++) {
    summary.projectedPayouts[n] = Math.round(calculatePayoutForNumber(n));
  }
  return summary;
}

function getKismatSummary() {
  const stakes = {};
  for (let i = 1; i <= 10; i++) stakes[i] = 0;
  for (const b of currentKismatBets) {
    if (stakes[b.choice] !== undefined) stakes[b.choice] += b.amount;
  }
  return { period: kismatState.period, stakes };
}

setInterval(async () => {
  gameState.timeLeft -= 1;
  if (gameState.timeLeft <= 0) {
    let winNum = Math.floor(Math.random() * 10);
    
    if (gameState.mode === 'MANUAL' && gameState.forcedNumber !== null) {
      winNum = Number(gameState.forcedNumber);
    } else {
      let bestNums = [];
      let minPay = Infinity;
      for (let n = 0; n <= 9; n++) {
        const pay = calculatePayoutForNumber(n);
        if (pay < minPay) { minPay = pay; bestNums = [n]; }
        else if (pay === minPay) { bestNums.push(n); }
      }
      winNum = bestNums[Math.floor(Math.random() * bestNums.length)];
    }

    const winCols = getColoursForNumber(winNum);
    for (const b of currentRoundBets) {
      let won = false;
      let rawWin = 0;
      if (b.choice === String(winNum)) { won = true; rawWin = b.amount * 9; }
      else if (winCols.includes(b.choice)) { won = true; rawWin = b.amount * b.multiplier; }
      
      if (won) {
        const tax = +(rawWin * 0.01).toFixed(3);
        b.winAmount = +(rawWin - tax).toFixed(3);
        b.status = 'WON';
      } else {
        b.winAmount = 0;
        b.status = 'LOST';
      }

      if (won && cachedUsers.has(b.phone)) {
        const u = cachedUsers.get(b.phone);
        u.balance = +(u.balance + b.winAmount).toFixed(3);
        await User.updateOne({ phone: u.phone }, { balance: u.balance });
        io.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === u.phone) });
      }
    }

    gameState.history.unshift({ period: gameState.period, number: winNum, colours: winCols });
    if (gameState.history.length > 20) gameState.history.pop();
    
    io.emit('round_settled', { settledBets: currentRoundBets, winNumber: winNum, winColours: winCols });

    gameState.period += 1;
    gameState.timeLeft = 30;
    gameState.forcedNumber = null;
    if (gameState.mode === 'MANUAL') gameState.mode = 'MIN_PAYOUT';
    currentRoundBets = [];
  }

  io.emit('tick', { period: gameState.period, timeLeft: gameState.timeLeft, history: gameState.history, summary: getRoundSummary() });
  io.emit('admin_update', await getAdminPayload());
}, 1000);

setInterval(async () => {
  kismatState.timeLeft -= 1;
  if (kismatState.timeLeft <= 0) {
    let winOption = Math.floor(Math.random() * 10) + 1;
    if (forcedKismatOption !== null) {
      winOption = forcedKismatOption;
      forcedKismatOption = null;
    }
    
    for (const b of currentKismatBets) {
      if (b.choice === winOption) {
        b.status = 'WON';
        const rawWin = b.amount * 9;
        const tax = +(rawWin * 0.01).toFixed(3);
        b.winAmount = +(rawWin - tax).toFixed(3);
        
        const u = cachedUsers.get(b.phone);
        if (u) {
          u.balance = +(u.balance + b.winAmount).toFixed(3);
          await User.updateOne({ phone: u.phone }, { balance: u.balance });
          io.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === u.phone) });
        }
      } else {
        b.status = 'LOST';
        b.winAmount = 0;
      }
    }

    kismatState.history.unshift({ period: kismatState.period, winOption });
    if (kismatState.history.length > 20) kismatState.history.pop();

    io.emit('kismat_settled', { settledBets: currentKismatBets, winOption });

    kismatState.period += 1;
    kismatState.timeLeft = 30;
    currentKismatBets = [];
  }

  io.emit('kismat_tick', { period: kismatState.period, timeLeft: kismatState.timeLeft, history: kismatState.history });
  io.emit('admin_update', await getAdminPayload());
}, 1000);

function generateRocketCrashPoint() {
  if (rocketState.forcedNextCrash !== null) {
    const val = Number(rocketState.forcedNextCrash);
    rocketState.forcedNextCrash = null;
    return Math.max(1.01, val);
  }
  const r = Math.random();
  if (r < 0.90) {
    return +(1.01 + Math.random() * 0.34).toFixed(2);
  }
  return +(1.50 + Math.random() * 5.00).toFixed(2);
}

setInterval(async () => {
  if (rocketState.status === 'WAITING') {
    rocketState.countdown = +(rocketState.countdown - 0.1).toFixed(1);
    if (rocketState.countdown <= 0) {
      rocketState.status = 'FLYING';
      rocketState.multiplier = 1.00;
      rocketState.crashPoint = generateRocketCrashPoint();
    }
  } else if (rocketState.status === 'FLYING') {
    const speed = rocketState.multiplier < 2 ? 0.025 : 0.06;
    rocketState.multiplier = +(rocketState.multiplier + speed).toFixed(2);

    for (const b of rocketBets) {
      if (!b.cashedOut && b.targetX && rocketState.multiplier >= b.targetX) {
        b.cashedOut = true;
        b.cashoutMult = b.targetX;
        const rawWin = b.amount * b.targetX;
        const tax = +(rawWin * 0.01).toFixed(3);
        b.winAmount = +(rawWin - tax).toFixed(3);
        
        const u = cachedUsers.get(b.phone);
        if (u) {
          u.balance = +(u.balance + b.winAmount).toFixed(3);
          await User.updateOne({ phone: u.phone }, { balance: u.balance });
          io.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === u.phone) });
          io.emit('win_popup', { phone: u.phone, game: 'ROCKET CRASH', winAmount: b.winAmount, orderPoint: b.amount });
        }
      }
    }

    if (rocketState.multiplier >= rocketState.crashPoint) {
      rocketState.multiplier = rocketState.crashPoint;
      rocketState.status = 'CRASHED';
      rocketState.history.unshift(rocketState.crashPoint);
      if (rocketState.history.length > 12) rocketState.history.pop();

      setTimeout(() => {
        rocketState.status = 'WAITING';
        rocketState.countdown = 5.0;
        rocketState.multiplier = 1.00;
        rocketBets = [];
      }, 3000);
    }
  }

  io.emit('rocket_tick', {
    status: rocketState.status,
    countdown: rocketState.countdown,
    multiplier: rocketState.multiplier,
    history: rocketState.history,
    bets: rocketBets
  });
  io.emit('admin_update', await getAdminPayload());
}, 100);

io.on('connection', (socket) => {
  socket.on('user_register', async ({ name, phone, password }) => {
    try {
      let existingUser = await User.findOne({ phone });
      if (existingUser || cachedUsers.has(phone)) {
        socket.emit('auth_error', 'Phone number already registered!');
      } else {
        const userId = 'USR' + Math.floor(1000 + Math.random() * 9000);
        const newUser = { userId, name, phone, password, balance: 10 };
        await User.create(newUser);
        cachedUsers.set(phone, newUser);
        socket.emit('auth_success', { user: newUser });
        io.emit('admin_update', await getAdminPayload());
      }
    } catch (err) {
      socket.emit('auth_error', 'Registration failed!');
    }
  });

  socket.on('user_login', ({ phone, password }) => {
    const user = cachedUsers.get(phone);
    if (!user) {
      socket.emit('auth_error', 'Account not found or deleted!');
    } else if (user.password !== password) {
      socket.emit('auth_error', 'Invalid password!');
    } else {
      socket.emit('auth_success', { user });
      socket.emit('user_sync', { user, myTransactions: allTransactions.filter(t => t.phone === phone) });
    }
  });

  socket.on('place_bet', async ({ phone, name, choice, amount, multiplier }) => {
    if (gameState.timeLeft <= 5) return;
    const u = cachedUsers.get(phone);
    const amt = Number(amount);
    if (!u || amt < 10 || u.balance < amt) return;

    u.balance = +(u.balance - amt).toFixed(3);
    await User.updateOne({ phone }, { balance: u.balance });

    const bet = { id: Date.now(), phone, userName: u.name, period: gameState.period, choice, amount: amt, multiplier: Number(multiplier), status: 'PENDING', winAmount: 0 };
    currentRoundBets.push(bet);
    socket.emit('bet_confirmed', { balance: u.balance, bet });
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('kismat_place_bet', async ({ phone, option, amount }) => {
    if (kismatState.timeLeft <= 5) return;
    const u = cachedUsers.get(phone);
    const amt = Number(amount);
    if (!u || amt < 10 || u.balance < amt) return;

    if (currentKismatBets.find(b => b.phone === phone)) {
      return socket.emit('auth_error', 'You can bet on only ONE option per round!');
    }

    u.balance = +(u.balance - amt).toFixed(3);
    await User.updateOne({ phone }, { balance: u.balance });

    const bet = { id: Date.now(), phone, userName: u.name, period: kismatState.period, choice: Number(option), amount: amt, status: 'PENDING', winAmount: 0 };
    currentKismatBets.push(bet);
    socket.emit('kismat_bet_confirmed', { balance: u.balance, bet });
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('rocket_place_bet', async ({ phone, name, amount, targetX }) => {
    const u = cachedUsers.get(phone);
    const amt = Number(amount);
    if (!u || amt < 10 || u.balance < amt) return;
    if (rocketBets.find(b => b.phone === phone)) return;

    u.balance = +(u.balance - amt).toFixed(3);
    await User.updateOne({ phone }, { balance: u.balance });

    const rBet = { id: Date.now(), phone, userName: u.name, amount: amt, targetX: targetX ? Number(targetX) : null, cashedOut: false, cashoutMult: 0, winAmount: 0 };
    rocketBets.push(rBet);
    socket.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === phone) });
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('rocket_cashout', async ({ phone, name }) => {
    if (rocketState.status !== 'FLYING') return;
    const rBet = rocketBets.find(b => b.phone === phone && !b.cashedOut);
    if (!rBet) return;

    rBet.cashedOut = true;
    rBet.cashoutMult = rocketState.multiplier;
    const rawWin = rBet.amount * rocketState.multiplier;
    const tax = +(rawWin * 0.01).toFixed(3);
    rBet.winAmount = +(rawWin - tax).toFixed(3);

    const u = cachedUsers.get(phone);
    if (u) {
      u.balance = +(u.balance + rBet.winAmount).toFixed(3);
      await User.updateOne({ phone }, { balance: u.balance });
      socket.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === phone) });
    }
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('deposit_request', async ({ phone, name, amount, utr }) => {
    const u = cachedUsers.get(phone);
    const tx = { id: Date.now(), phone, userName: u ? u.name : phone, type: 'DEPOSIT', amount: Number(amount), details: `UTR: ${utr}`, status: 'PENDING', time: new Date().toLocaleTimeString() };
    await Transaction.create(tx);
    allTransactions.unshift(tx);
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('withdraw_request', async ({ phone, name, amount, account }) => {
    const u = cachedUsers.get(phone);
    const requestedAmt = Number(amount);
    if (!u || requestedAmt < 100) return socket.emit('auth_error', 'Minimum withdrawal is ₹100!');

    const todayStr = new Date().toDateString();
    const userTodayWithdraws = allTransactions.filter(t => t.phone === phone && t.type === 'WITHDRAW' && new Date(t.id).toDateString() === todayStr);
    if (userTodayWithdraws.length >= 3) return socket.emit('auth_error', 'Daily withdrawal limit reached!');

    const taxAmount = +(requestedAmt * 0.03).toFixed(2);
    const finalDeductAmount = +(requestedAmt + taxAmount).toFixed(2);
    if (u.balance < finalDeductAmount) return socket.emit('auth_error', 'Insufficient balance including 3% tax!');

    u.balance = +(u.balance - finalDeductAmount).toFixed(3);
    await User.updateOne({ phone }, { balance: u.balance });

    const tx = { 
      id: Date.now(), phone, userName: u.name, type: 'WITHDRAW', 
      amount: requestedAmt, tax: taxAmount, totalDeducted: finalDeductAmount,
      details: `To: ${account} (Incl. 3% Tax)`, status: 'PENDING', time: new Date().toLocaleTimeString() 
    };
    await Transaction.create(tx);
    allTransactions.unshift(tx);
    socket.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === phone) });
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('submit_support_ticket', async ({ phone, name, message }) => {
    if (!phone || !message) {
      return socket.emit('auth_error', 'Phone number and message are required!');
    }
    const ticket = {
      id: Date.now(),
      phone,
      userName: name || phone,
      message,
      status: 'PENDING',
      time: new Date().toLocaleTimeString()
    };
    await SupportTicket.create(ticket);
    allSupportTickets.unshift(ticket);
    socket.emit('support_submitted_success', 'Your issue has been sent to admin successfully!');
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('admin_resolve_ticket', async (ticketId) => {
    await SupportTicket.updateOne({ id: ticketId }, { status: 'RESOLVED' });
    const t = allSupportTickets.find(item => item.id === ticketId);
    if (t) t.status = 'RESOLVED';
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('admin_init', async () => socket.emit('admin_update', await getAdminPayload()));
  socket.on('admin_set_mode', async (mode) => { gameState.mode = mode; if (mode !== 'MANUAL') gameState.forcedNumber = null; io.emit('admin_update', await getAdminPayload()); });
  socket.on('admin_force_num', async (num) => { gameState.mode = 'MANUAL'; gameState.forcedNumber = Number(num); io.emit('admin_update', await getAdminPayload()); });
  socket.on('admin_force_colour', async (colour) => {
    gameState.mode = 'MANUAL';
    if (colour === 'GREEN') gameState.forcedNumber = [1, 3, 7, 9][Math.floor(Math.random() * 4)];
    else if (colour === 'RED') gameState.forcedNumber = [2, 4, 6, 8][Math.floor(Math.random() * 4)];
    else if (colour === 'VIOLET') gameState.forcedNumber = [0, 5][Math.floor(Math.random() * 2)];
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('admin_force_kismat', (opt) => { forcedKismatOption = Number(opt); });
  socket.on('admin_rocket_crash_now', async () => { if (rocketState.status === 'FLYING') rocketState.crashPoint = rocketState.multiplier; io.emit('admin_update', await getAdminPayload()); });
  socket.on('admin_rocket_set_next', async (val) => { rocketState.forcedNextCrash = Number(val); io.emit('admin_update', await getAdminPayload()); });
  socket.on('admin_delete_user', async (phone) => { await User.deleteOne({ phone }); cachedUsers.delete(phone); io.emit('admin_update', await getAdminPayload()); });
  socket.on('admin_custom_balance', async ({ phone, amount }) => {
    const u = cachedUsers.get(phone);
    if (!u) return;
    u.balance = Math.max(0, +Number(amount).toFixed(3));
    await User.updateOne({ phone }, { balance: u.balance });
    io.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === phone) });
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('admin_process_tx', async ({ txId, approve }) => {
    const tx = allTransactions.find(t => t.id === txId);
    if (!tx || tx.status !== 'PENDING') return;
    const u = cachedUsers.get(tx.phone);

    if (tx.type === 'DEPOSIT') {
      tx.status = approve ? 'APPROVED' : 'REJECTED';
      if (approve && u) {
        u.balance = +(u.balance + tx.amount).toFixed(3);
        await User.updateOne({ phone: tx.phone }, { balance: u.balance });
      }
    } else if (tx.type === 'WITHDRAW') {
      tx.status = approve ? 'APPROVED' : 'REJECTED';
      if (!approve && u) {
        u.balance = +(u.balance + tx.totalDeducted).toFixed(3);
        await User.updateOne({ phone: tx.phone }, { balance: u.balance });
      }
    }
    await Transaction.updateOne({ id: txId }, { status: tx.status });
    if (u) io.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === u.phone) });
    io.emit('admin_update', await getAdminPayload());
  });
});

async function getAdminPayload() {
  const totalRocketPool = rocketBets.reduce((acc, b) => acc + b.amount, 0);
  return {
    gameState,
    kismatState: getKismatSummary(),
    rocketState,
    transactions: allTransactions,
    supportTickets: allSupportTickets,
    usersList: Array.from(cachedUsers.values()).reverse(),
    currentBets: currentRoundBets.slice().reverse(),
    rocketBets,
    totalRocketPool
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('✅ Server running on port ' + PORT);
});
