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
const OWNER_ID = "7957630713"; 

// --- DATABASE ---
let userDB = {};
if (fs.existsSync(DB_FILE)) {
    try { userDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } 
    catch (e) { userDB = {}; }
}

const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(userDB, null, 2));

// --- STATE ---
let activeFlips = [];
let chatHistory = [];
const clickCooldowns = {};

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- API ---
app.get('/api/roblox-pfp/:userId', async (req, res) => {
    try {
        const response = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${req.params.userId}&size=150x150&format=Png&isCircular=true`);
        res.json({ pfpUrl: response.data.data[0]?.imageUrl || "" });
    } catch (e) { res.json({ pfpUrl: "" }); }
});

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
            else userDB[userId].username = username; // Update name if changed
            saveDB();
            res.json({ success: true, data: userDB[userId] });
        } else res.json({ success: false, message: "Code not found in bio!" });
    } catch (e) { res.status(500).json({ success: false, message: "Roblox API Error" }); }
});

app.post('/api/admin/give', (req, res) => {
    const { adminId, targetId, amount } = req.body;
    if (String(adminId) !== OWNER_ID) return res.status(403).send("No");
    
    // Create user if they don't exist yet
    if (!userDB[targetId]) {
        userDB[targetId] = { username: "Pending User", balance: 0, wagered: 0 };
    }
    
    userDB[targetId].balance += parseInt(amount);
    saveDB();
    io.emit('update_balance', { userId: targetId, newBalance: userDB[targetId].balance, wagered: userDB[targetId].wagered });
    res.json({ success: true });
});

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.userId = String(userId);
        socket.emit('chat_history', chatHistory);
        socket.emit('list_flips', activeFlips);
    });

    socket.on('gem_click', (data) => {
        const uid = String(data.userId);
        if (!userDB[uid]) return;
        if (clickCooldowns[uid] && (Date.now() - clickCooldowns[uid]) < 80) return;
        clickCooldowns[uid] = Date.now();

        const lvl = Math.floor(Math.sqrt(userDB[uid].wagered / 100)) + 1;
        userDB[uid].balance += lvl;
        saveDB();
        socket.emit('update_balance', { userId: uid, newBalance: userDB[uid].balance, wagered: userDB[uid].wagered });
    });

    socket.on('send_message', (m) => {
        const msg = { username: m.username, text: m.text, role: String(m.userId) === OWNER_ID ? "OWNER" : "USER" };
        chatHistory.push(msg);
        if (chatHistory.length > 50) chatHistory.shift();
        io.emit('new_message', msg);
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

server.listen(PORT, () => console.log(`Server live on ${PORT}`));
