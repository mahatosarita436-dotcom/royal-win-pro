const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use(express.static(path.join(__dirname)));

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/royalwin";
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas successfully!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

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
  adminReply: { type: String, default: '' },
  status: { type: String, default: 'PENDING' },
  time: String
});
const SupportTicket = mongoose.model('SupportTicket', supportSchema);

let gameState = { period: 20261017001, timeLeft: 30, mode: 'MIN_PAYOUT', forcedNumber: null, history: [] };
let kismatState = { period: 20261017001, timeLeft: 150, history: [] };
let currentKismatBets = [];
let forcedKismatOption = null;

let rocketState = { status: 'WAITING', countdown: 5.0, multiplier: 1.00, crashPoint: 2.50, forcedNextCrash: null, history: [] };
let currentRoundBets = [];
let rocketBets = [];
let allUserBetsHistory = [];
let cachedUsers = new Map();
let allTransactions = [];
let allSupportTickets = [];

async function loadDataFromDB() {
  try {
    const usersList = await User.find({});
    usersList.forEach(u => cachedUsers.set(u.phone, u));
    allTransactions = await Transaction.find({}).sort({ id: -1 }).limit(100);
    allSupportTickets = await SupportTicket.find({}).sort({ id: -1 }).limit(100);
    console.log(`✅ Loaded ${cachedUsers.size} users from DB.`);
  } catch (e) {
    console.log('Error loading DB:', e);
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

// Colour Game Timer
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
        io.emit('user_sync', { user: u });
      }
      allUserBetsHistory.unshift(b);
    }

    gameState.history.unshift({ period: gameState.period, number: winNum, colours: winCols });
    if (gameState.history.length > 20) gameState.history.pop();
    if (allUserBetsHistory.length > 200) allUserBetsHistory.pop();
    
    io.emit('round_settled', { settledBets: currentRoundBets, winNumber: winNum, winColours: winCols, history: gameState.history });
    gameState.period += 1;
    gameState.timeLeft = 30;
    gameState.forcedNumber = null;
    if (gameState.mode === 'MANUAL') gameState.mode = 'MIN_PAYOUT';
    currentRoundBets = [];
  }
  io.emit('tick', { period: gameState.period, timeLeft: gameState.timeLeft, history: gameState.history });
  io.emit('admin_update', await getAdminPayload());
}, 1000);

// Kismat Game Timer
setInterval(async () => {
  kismatState.timeLeft -= 1;
  if (kismatState.timeLeft <= 0) {
    let winOption = Math.floor(Math.random() * 10) + 1;

    if (forcedKismatOption !== null) {
      winOption = forcedKismatOption;
      forcedKismatOption = null;
    } else {
      let bettedOptions = new Set();
      currentKismatBets.forEach(b => {
        let optNum = parseInt(b.choice.replace('Option #', ''));
        bettedOptions.add(optNum);
      });

      let emptyOptions = [];
      for (let i = 1; i <= 10; i++) {
        if (!bettedOptions.has(i)) {
          emptyOptions.push(i);
        }
      }

      if (emptyOptions.length > 0) {
        winOption = emptyOptions[Math.floor(Math.random() * emptyOptions.length)];
      } else {
        winOption = Math.floor(Math.random() * 10) + 1;
      }
    }
    
    for (const b of currentKismatBets) {
      if (b.choice === `Option #${winOption}`) {
        b.status = 'WON';
        const rawWin = b.amount * 9;
        const tax = +(rawWin * 0.01).toFixed(3);
        b.winAmount = +(rawWin - tax).toFixed(3);
        
        const u = cachedUsers.get(b.phone);
        if (u) {
          u.balance = +(u.balance + b.winAmount).toFixed(3);
          await User.updateOne({ phone: u.phone }, { balance: u.balance });
          io.emit('user_sync', { user: u });
        }
      } else {
        b.status = 'LOST';
        b.winAmount = 0;
      }
      allUserBetsHistory.unshift(b);
    }

    kismatState.history.unshift({ period: kismatState.period, winOption });
    if (kismatState.history.length > 20) kismatState.history.pop();

    io.emit('kismat_settled', { settledBets: currentKismatBets, winOption, history: kismatState.history });
    kismatState.period += 1;
    kismatState.timeLeft = 150;
    currentKismatBets = [];
  }
  io.emit('kismat_tick', { period: kismatState.period, timeLeft: kismatState.timeLeft, history: kismatState.history });
  io.emit('admin_update', await getAdminPayload());
}, 1000);

// Rocket Game Loop with Smart Dynamic Crash (Kono bet na thakle 500x, kom bet thakle 100x, besi thakle taratari crash)
setInterval(async () => {
  if (rocketState.status === 'WAITING') {
    rocketState.countdown = +(rocketState.countdown - 0.1).toFixed(1);
    if (rocketState.countdown <= 0) {
      rocketState.status = 'FLYING';
      rocketState.multiplier = 1.00;

      let totalPool = rocketBets.reduce((sum, b) => sum + b.amount, 0);
      let maxBet = rocketBets.length > 0 ? Math.max(...rocketBets.map(b => b.amount)) : 0;

      if (rocketState.forcedNextCrash !== null) {
        rocketState.crashPoint = rocketState.forcedNextCrash;
        rocketState.forcedNextCrash = null;
      } else if (rocketBets.length === 0) {
        // Kono bet na thakle 500x projonto jete pare
        rocketState.crashPoint = +(100 + Math.random() * 400).toFixed(2);
      } else if (maxBet <= 20) {
        // Shudhu 10 ba 20 taka lagale 100x projonto jete pare
        rocketState.crashPoint = +(15 + Math.random() * 85).toFixed(2);
      } else if (maxBet <= 50) {
        rocketState.crashPoint = +(3 + Math.random() * 15).toFixed(2);
      } else {
        // Besi bet thakle taratari crash hobe
        rocketState.crashPoint = +(1.02 + Math.random() * 0.45).toFixed(2);
      }
    }
  } else if (rocketState.status === 'FLYING') {
    rocketState.multiplier = +(rocketState.multiplier + 0.05).toFixed(2);
    if (rocketState.multiplier >= rocketState.crashPoint) {
      rocketState.status = 'CRASHED';
      rocketState.history.unshift(rocketState.crashPoint);
      if (rocketState.history.length > 20) rocketState.history.pop();
      
      for (const rb of rocketBets) {
        if (!rb.cashedOut) {
          rb.status = 'LOST';
          rb.winAmount = 0;
          allUserBetsHistory.unshift(rb);
        }
      }

      setTimeout(() => {
        rocketState.status = 'WAITING';
        rocketState.countdown = 5.0;
        rocketState.multiplier = 1.00;
        rocketBets = [];
      }, 3000);
    }
  }
  io.emit('rocket_tick', { status: rocketState.status, countdown: rocketState.countdown, multiplier: rocketState.multiplier, history: rocketState.history });
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
      }
    } catch (err) {
      socket.emit('auth_error', 'Registration failed!');
    }
  });

  socket.on('user_login', ({ phone, password }) => {
    const user = cachedUsers.get(phone);
    if (!user) {
      socket.emit('auth_error', 'Account not found!');
    } else if (user.password !== password) {
      socket.emit('auth_error', 'Invalid password!');
    } else {
      socket.emit('auth_success', { user });
    }
  });

  socket.on('place_bet', async ({ phone, name, choice, amount, multiplier }) => {
    if (gameState.timeLeft <= 5) return;
    const u = cachedUsers.get(phone);
    const amt = Number(amount);
    if (!u || amt < 10 || u.balance < amt) return;

    u.balance = +(u.balance - amt).toFixed(3);
    await User.updateOne({ phone }, { balance: u.balance });

    const bet = { id: Date.now(), phone, game: 'Colour Trading', userName: u.name, period: gameState.period, choice, amount: amt, multiplier: Number(multiplier), status: 'PENDING', winAmount: 0 };
    currentRoundBets.push(bet);
    socket.emit('user_sync', { user: u });
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('kismat_place_bet', async ({ phone, option, amount }) => {
    if (kismatState.timeLeft <= 10) return;
    const u = cachedUsers.get(phone);
    const amt = 10;
    if (!u || u.balance < amt) return;

    if (currentKismatBets.find(b => b.phone === phone)) {
      return socket.emit('auth_error', 'You can bet on only ONE option per round!');
    }

    u.balance = +(u.balance - amt).toFixed(3);
    await User.updateOne({ phone }, { balance: u.balance });

    const bet = { id: Date.now(), phone, game: 'Kismat Game', userName: u.name, period: kismatState.period, choice: `Option #${option}`, amount: amt, status: 'PENDING', winAmount: 0 };
    currentKismatBets.push(bet);
    socket.emit('kismat_bet_confirmed', { balance: u.balance, bet });
    socket.emit('user_sync', { user: u });
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('rocket_place_bet', async ({ phone, name, amount }) => {
    const u = cachedUsers.get(phone);
    const amt = Number(amount);
    if (!u || amt < 10 || u.balance < amt) return;
    if (rocketBets.find(b => b.phone === phone)) return;

    u.balance = +(u.balance - amt).toFixed(3);
    await User.updateOne({ phone }, { balance: u.balance });
    const rBet = { id: Date.now(), phone, game: 'Rocket Crash', userName: u.name, period: '', choice: 'Flight Bet', amount: amt, cashedOut: false, status: 'PENDING', winAmount: 0 };
    rocketBets.push(rBet);
    socket.emit('user_sync', { user: u });
  });

  socket.on('rocket_cashout', async ({ phone }) => {
    if (rocketState.status !== 'FLYING') return;
    const rBet = rocketBets.find(b => b.phone === phone && !b.cashedOut);
    if (!rBet) return;
    rBet.cashedOut = true;
    rBet.status = 'WON';
    rBet.winAmount = +(rBet.amount * rocketState.multiplier * 0.99).toFixed(3);
    
    const u = cachedUsers.get(phone);
    if (u) {
      u.balance = +(u.balance + rBet.winAmount).toFixed(3);
      await User.updateOne({ phone }, { balance: u.balance });
      socket.emit('user_sync', { user: u });
    }
    allUserBetsHistory.unshift(rBet);

    // Send cashout success popup details back to user
    socket.emit('rocket_cashed_out_success', {
      betAmount: rBet.amount,
      multiplier: rocketState.multiplier,
      winAmount: rBet.winAmount
    });
  });

  socket.on('fetch_my_bets', ({ phone }) => {
    const userBets = allUserBetsHistory.filter(b => b.phone === phone);
    const liveBets = [...currentRoundBets, ...currentKismatBets, ...rocketBets.filter(b => !b.cashedOut)].filter(b => b.phone === phone);
    socket.emit('my_bets_response', [...liveBets, ...userBets]);
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
    if (!u || requestedAmt < 100) return;
    const taxAmount = +(requestedAmt * 0.03).toFixed(2);
    const finalDeduct = +(requestedAmt + taxAmount).toFixed(2);
    if (u.balance < finalDeduct) return;

    u.balance = +(u.balance - finalDeduct).toFixed(3);
    await User.updateOne({ phone }, { balance: u.balance });

    const tx = { id: Date.now(), phone, userName: u.name, type: 'WITHDRAW', amount: requestedAmt, tax: taxAmount, totalDeducted: finalDeduct, details: `To: ${account}`, status: 'PENDING', time: new Date().toLocaleTimeString() };
    await Transaction.create(tx);
    allTransactions.unshift(tx);
    socket.emit('user_sync', { user: u });
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('fetch_user_tickets', async ({ phone }) => {
    socket.emit('support_tickets_response', allSupportTickets.filter(t => t.phone === phone));
  });

  socket.on('submit_support_ticket', async ({ phone, name, message }) => {
    if (!phone || !message) return;
    const ticket = { id: Date.now(), phone, userName: name || phone, message, adminReply: '', status: 'PENDING', time: new Date().toLocaleTimeString() };
    await SupportTicket.create(ticket);
    allSupportTickets.unshift(ticket);
    socket.emit('support_tickets_response', allSupportTickets.filter(t => t.phone === phone));
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('admin_set_mode', (mode) => {
    gameState.mode = mode;
    if (mode === 'MIN_PAYOUT') gameState.forcedNumber = null;
    io.emit('admin_update', getAdminPayloadSync());
  });

  socket.on('admin_force_num', (num) => {
    gameState.mode = 'MANUAL';
    gameState.forcedNumber = Number(num);
    io.emit('admin_update', getAdminPayloadSync());
  });

  socket.on('admin_force_colour', (col) => {
    gameState.mode = 'MANUAL';
    let matching = [];
    for (let n = 0; n <= 9; n++) {
      const cols = getColoursForNumber(n);
      if (cols.includes(col)) matching.push(n);
    }
    if (matching.length > 0) {
      gameState.forcedNumber = matching[Math.floor(Math.random() * matching.length)];
    }
    io.emit('admin_update', getAdminPayloadSync());
  });

  socket.on('admin_force_kismat', (opt) => {
    forcedKismatOption = Number(opt);
  });

  socket.on('admin_rocket_crash_now', () => {
    if (rocketState.status === 'FLYING') {
      rocketState.crashPoint = rocketState.multiplier;
    }
  });

  socket.on('admin_rocket_set_next', (val) => {
    rocketState.forcedNextCrash = Number(val);
    io.emit('admin_update', getAdminPayloadSync());
  });

  socket.on('admin_delete_user', async (phone) => {
    await User.deleteOne({ phone });
    cachedUsers.delete(phone);
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('admin_custom_balance', async ({ phone, amount }) => {
    const u = cachedUsers.get(phone);
    if (u) {
      u.balance = Number(amount);
      await User.updateOne({ phone }, { balance: u.balance });
      socket.emit('user_sync', { user: u });
      io.emit('admin_update', await getAdminPayload());
    }
  });

  socket.on('admin_process_tx', async ({ txId, approve }) => {
    const tx = allTransactions.find(t => t.id === txId);
    if (tx && tx.status === 'PENDING') {
      tx.status = approve ? 'APPROVED' : 'REJECTED';
      await Transaction.updateOne({ id: txId }, { status: tx.status });
      if (approve && tx.type === 'DEPOSIT') {
        const u = cachedUsers.get(tx.phone);
        if (u) {
          u.balance = +(u.balance + tx.amount).toFixed(3);
          await User.updateOne({ phone: u.phone }, { balance: u.balance });
          io.emit('user_sync', { user: u });
        }
      }
      io.emit('admin_update', await getAdminPayload());
    }
  });

  socket.on('admin_reply_ticket', async ({ ticketId, reply }) => {
    const t = allSupportTickets.find(item => item.id === ticketId);
    if (t) {
      t.adminReply = reply;
      t.status = 'RESOLVED';
      await SupportTicket.updateOne({ id: ticketId }, { adminReply: reply, status: 'RESOLVED' });
      io.emit('admin_update', await getAdminPayload());
    }
  });

  socket.on('admin_resolve_ticket', async (ticketId) => {
    await SupportTicket.updateOne({ id: ticketId }, { status: 'RESOLVED' });
    const t = allSupportTickets.find(item => item.id === ticketId);
    if (t) t.status = 'RESOLVED';
    io.emit('admin_update', await getAdminPayload());
  });

  socket.on('admin_init', async () => socket.emit('admin_update', await getAdminPayload()));
});

async function getAdminPayload() {
  let stakes = { GREEN: 0, VIOLET: 0, RED: 0 };
  let projectedPayouts = {};
  for (let n = 0; n <= 9; n++) projectedPayouts[n] = calculatePayoutForNumber(n);
  for (const b of currentRoundBets) {
    if (stakes[b.choice] !== undefined) stakes[b.choice] += b.amount;
    else if (!isNaN(b.choice)) stakes[b.choice] = (stakes[b.choice] || 0) + b.amount;
  }
  let kStakes = {};
  for (const b of currentKismatBets) {
    const optNum = b.choice.replace('Option #', '');
    kStakes[optNum] = (kStakes[optNum] || 0) + b.amount;
  }
  let totalRocketPool = rocketServiceTotalPool();

  return {
    gameState,
    kismatState: { period: kismatState.period, timeLeft: kismatState.timeLeft, stakes: kStakes },
    rocketState,
    summary: { stakes, projectedPayouts },
    supportTickets: allSupportTickets,
    usersList: Array.from(cachedUsers.values()).reverse(),
    transactions: allTransactions,
    currentBets: currentRoundBets,
    rocketBets,
    totalRocketPool
  };
}

function getAdminPayloadSync() {
  return {
    gameState,
    kismatState: { period: kismatState.period, timeLeft: kismatState.timeLeft },
    rocketState,
    supportTickets: allSupportTickets,
    usersList: Array.from(cachedUsers.values()).reverse(),
    transactions: allTransactions,
    currentBets: currentRoundBets,
    rocketBets,
    totalRocketPool: rocketServiceTotalPool()
  };
}

function rocketServiceTotalPool() {
  return rocketBets.reduce((acc, b) => acc + b.amount, 0);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('✅ Server running on port ' + PORT);
});
