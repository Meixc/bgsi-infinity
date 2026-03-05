const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const BAN_FILE = path.join(__dirname, 'bans.json');
const OWNER_ID = "7957630713"; 

// --- DATABASE HELPER ---
let userDB = {};
if (fs.existsSync(DB_FILE)) {
    try { userDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
    catch (e) { userDB = {}; }
}
const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(userDB, null, 2));

// --- BAN SYSTEM HELPER ---
const getBans = () => {
    if (!fs.existsSync(BAN_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(BAN_FILE, 'utf8')); } 
    catch (e) { return []; }
};

// --- MIDDLEWARE: THE BOUNCER ---
app.use((req, res, next) => {
    const bannedIds = getBans();
    // We check the query 'uid' which we append in the frontend if logged in
    const uid = req.query.uid;
    if (uid && bannedIds.includes(String(uid))) {
        return res.status(403).send(`
            <body style="background:#000; color:#ff4444; display:flex; align-items:center; justify-content:center; height:100vh; font-family:sans-serif;">
                <div style="text-align:center; border:2px solid #ff4444; padding:40px; border-radius:20px;">
                    <h1>ACCESS DENIED</h1>
                    <p>This Roblox ID has been permanently banned from BGSI Infinity.</p>
                </div>
            </body>`);
    }
    next();
});

app.use(cors(), express.json(), express.static(__dirname));

// --- API ROUTES ---
app.get('/api/leaderboard', (req, res) => {
    const top = Object.values(userDB)
        .filter(u => u.wagered > 0)
        .sort((a, b) => b.wagered - a.wagered)
        .slice(0, 3)
        .map((u, i) => ({ username: u.username, wagered: u.wagered, rank: i + 1 }));
    res.json(top);
});

app.post('/api/verify-bio', async (req, res) => {
    const { userId, username, expectedCode } = req.body;
    try {
        const response = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
        if (response.data.description?.includes(expectedCode)) {
            if (!userDB[userId]) userDB[userId] = { username, balance: 1000, wagered: 0 };
            saveDB();
            res.json({ success: true, data: userDB[userId] });
        } else res.json({ success: false, message: "Code not found in Bio!" });
    } catch (e) { res.status(500).json({ success: false }); }
});

// Admin: Ban
app.post('/api/admin/ban', (req, res) => {
    const { adminId, targetId } = req.body;
    if (String(adminId) !== OWNER_ID) return res.status(403).send("No");
    let bans = getBans();
    if (!bans.includes(String(targetId))) {
        bans.push(String(targetId));
        fs.writeFileSync(BAN_FILE, JSON.stringify(bans, null, 2));
    }
    io.emit('force_disconnect', { userId: targetId });
    res.json({ success: true });
});

// Admin: Give Gems
app.post('/api/admin/give', (req, res) => {
    const { adminId, targetId, amount } = req.body;
    if (String(adminId) !== OWNER_ID) return res.status(403).send("No");
    if (!userDB[targetId]) userDB[targetId] = { username: "User", balance: 0, wagered: 0 };
    userDB[targetId].balance += parseInt(amount);
    saveDB();
    io.emit('update_balance', { userId: targetId, newBalance: userDB[targetId].balance, wagered: userDB[targetId].wagered });
    res.json({ success: true });
});

// --- SOCKETS ---
let activeFlips = [];
let chatHistory = [];
const chatCooldowns = {};

io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.userId = String(userId);
        socket.emit('chat_history', chatHistory);
        socket.emit('list_flips', activeFlips);
    });

    socket.on('send_message', (m) => {
        const uid = String(m.userId);
        const now = Date.now();
        if (uid !== OWNER_ID && chatCooldowns[uid] && now - chatCooldowns[uid] < 2000) return;
        chatCooldowns[uid] = now;

        const msg = { username: m.username, text: m.text, role: uid === OWNER_ID ? "OWNER" : "USER" };
        chatHistory.push(msg);
        if (chatHistory.length > 50) chatHistory.shift();
        io.emit('new_message', msg);
    });

    socket.on('gem_click', (data) => {
        const uid = String(data.userId);
        if (!userDB[uid]) return;
        userDB[uid].balance += Math.floor(Math.sqrt(userDB[uid].wagered / 100)) + 1;
        saveDB();
        socket.emit('update_balance', { userId: uid, newBalance: userDB[uid].balance, wagered: userDB[uid].wagered });
    });

    socket.on('create_flip', (data) => {
        const u = userDB[data.userId];
        if (u && u.balance >= data.amount && data.amount >= 10) {
            u.balance -= data.amount;
            activeFlips.push({ id: Date.now(), creator: data });
            saveDB();
            io.emit('list_flips', activeFlips);
            socket.emit('update_balance', { userId: data.userId, newBalance: u.balance, wagered: u.wagered });
        }
    });

    socket.on('join_flip', (data) => {
        const idx = activeFlips.findIndex(g => g.id === data.gameId);
        const game = activeFlips[idx];
        const joiner = userDB[data.userId];
        if (game && joiner && game.creator.userId !== data.userId && joiner.balance >= game.creator.amount) {
            joiner.balance -= game.creator.amount;
            const winSide = Math.random() > 0.5 ? 'Heads' : 'Tails';
            const winnerId = game.creator.side === winSide ? game.creator.userId : data.userId;
            io.emit('flip_results', { winnerName: userDB[winnerId].username, resultSide: winSide });
            setTimeout(() => {
                userDB[winnerId].balance += Math.floor(game.creator.amount * 1.9);
                userDB[game.creator.userId].wagered += game.creator.amount;
                userDB[data.userId].wagered += game.creator.amount;
                saveDB();
                io.emit('update_balance', { userId: game.creator.userId, newBalance: userDB[game.creator.userId].balance, wagered: userDB[game.creator.userId].wagered });
                io.emit('update_balance', { userId: data.userId, newBalance: userDB[data.userId].balance, wagered: userDB[data.userId].wagered });
            }, 2000);
            activeFlips.splice(idx, 1);
            io.emit('list_flips', activeFlips);
        }
    });
});

server.listen(PORT, () => console.log(`Server running`));
