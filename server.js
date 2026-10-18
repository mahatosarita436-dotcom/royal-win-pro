const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname)));

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/royalwin";
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas successfully!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Mongoose Schemas & Models
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

let rocketState = {
  status: 'WAITING',
  countdown: 5.0,
  multiplier: 1.00,
  crashPoint: 2.50,
  forcedNextCrash: null,
  history: [1.85, 3.40, 1.12, 8.90, 2.05]
};

let currentRoundBets = [];
let rocketBets = [];
let cachedUsers = new Map();
let allTransactions = [];

// Load initial data from MongoDB
async function loadDataFromDB() {
  try {
    const usersList = await User.find({});
    usersList.forEach(u => cachedUsers.set(u.phone, u));
    allTransactions = await Transaction.find({}).sort({ id: -1 }).limit(100);
    console.log(`✅ Loaded ${cachedUsers.size} users from MongoDB.`);
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
      if (b.choice === String(winNum)) { won = true; b.winAmount = b.amount * 9; }
      else if (winCols.includes(b.choice)) { won = true; b.winAmount = b.amount * b.multiplier; }
      b.status = won ? 'WON' : 'LOST';

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

function generateRocketCrashPoint() {
  if (rocketState.forcedNextCrash !== null) {
    const val = Number(rocketState.forcedNextCrash);
    rocketState.forcedNextCrash = null;
    return Math.max(1.01, val);
  }
  const r = Math.random();
  if (r < 0.70) {
    return +(1.01 + Math.random() * 0.34).toFixed(2);
  }
  return +(1.60 + Math.random() * 9.00).toFixed(2);
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
    const speed = rocketState.multiplier < 2 ? 0.025 : rocketState.multiplier < 5 ? 0.06 : 0.14;
    rocketState.multiplier = +(rocketState.multiplier + speed).toFixed(2);

    for (const b of rocketBets) {
      if (!b.cashedOut && b.targetX && rocketState.multiplier >= b.targetX) {
        b.cashedOut = true;
        b.cashoutMult = b.targetX;
        b.winAmount = +(b.amount * b.targetX).toFixed(3);
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
    if (cachedUsers.has(phone)) {
      socket.emit('auth_error', 'Phone number already registered!');
    } else {
      const userId = 'USR' + Math.floor(1000 + Math.random() * 9000);
      const newUser = { userId, name, phone, password, balance: 10 };
      
      try {
        await User.create(newUser);
        cachedUsers.set(phone, newUser);
        socket.emit('auth_success', { user: newUser });
        io.emit('admin_update', await getAdminPayload());
      } catch (err) {
        socket.emit('auth_error', 'Registration failed!');
      }
    }
  });

  socket.on('user_login', ({ phone, password }) => {
    const user = cachedUsers.get(phone);
    if (!user) {
      socket.emit('auth_error', 'Account not found or deleted! Please register first.');
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
    rBet.winAmount = +(rBet.amount * rocketState.multiplier).toFixed(3);

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
    if (!u || requestedAmt < 100) {
      socket.emit('auth_error', 'Minimum withdrawal amount is ₹100!');
      return;
    }

    const todayStr = new Date().toDateString();
    const userTodayWithdraws = allTransactions.filter(t => t.phone === phone && t.type === 'WITHDRAW' && new Date(t.id).toDateString() === todayStr);
    
    if (userTodayWithdraws.length >= 3) {
      socket.emit('auth_error', 'Daily withdrawal limit reached! You can only withdraw 3 times per day.');
      return;
    }

    const taxAmount = +(requestedAmt * 0.03).toFixed(2);
    const finalDeductAmount = +(requestedAmt + taxAmount).toFixed(2);

    if (u.balance < finalDeductAmount) {
      socket.emit('auth_error', `Insufficient balance! Total required (₹${finalDeductAmount} including 3% tax ₹${taxAmount}) exceeds balance.`);
      return;
    }

    u.balance = +(u.balance - finalDeductAmount).toFixed(3);
    await User.updateOne({ phone }, { balance: u.balance });

    const tx = { 
      id: Date.now(), 
      phone, 
      userName: u.name, 
      type: 'WITHDRAW', 
      amount: requestedAmt, 
      tax: taxAmount,
      totalDeducted: finalDeductAmount,
      details: `To: ${account} (Incl. 3% Tax: ₹${taxAmount})`, 
      status: 'PENDING', 
      time: new Date().toLocaleTimeString() 
    };
    
    await Transaction.create(tx);
    allTransactions.unshift(tx);
    
    socket.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === phone) });
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

  socket.on('admin_rocket_crash_now', async () => {
    if (rocketState.status === 'FLYING') rocketState.crashPoint = rocketState.multiplier;
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('admin_rocket_set_next', async (val) => {
    rocketState.forcedNextCrash = Number(val);
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('admin_delete_user', async (phone) => {
    await User.deleteOne({ phone });
    cachedUsers.delete(phone);
    io.emit('admin_update', await getAdminPayload());
  });

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

    if (u) {
      io.emit('user_sync', { user: u, myTransactions: allTransactions.filter(t => t.phone === u.phone) });
    }
    io.emit('admin_update', await getAdminPayload());
  });
});

async function getAdminPayload() {
  const totalRocketPool = rocketBets.reduce((acc, b) => acc + b.amount, 0);
  return {
    gameState,
    rocketState,
    transactions: allTransactions,
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
