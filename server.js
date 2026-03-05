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
const DB_FILE = './database.json';
const OWNER_ID = "7957630713"; 

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- DATABASE ---
let userDB = {};
if (fs.existsSync(DB_FILE)) {
    try { userDB = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { userDB = {}; }
}
const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(userDB, null, 2));

let activeFlips = [];
const clickCooldowns = {};

// --- API ROUTES ---
app.get('/api/roblox-pfp/:userId', async (req, res) => {
    try {
        const response = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${req.params.userId}&size=150x150&format=Png&isCircular=true`);
        res.json({ pfpUrl: response.data.data[0].imageUrl });
    } catch (e) { res.status(500).json({ error: "Avatar fetch failed" }); }
});

app.get('/api/leaderboard', (req, res) => {
    const top3 = Object.values(userDB)
        .sort((a, b) => b.wagered - a.wagered)
        .slice(0, 3)
        .map((u, i) => ({ username: u.username, wagered: u.wagered, rank: i + 1 }));
    res.json(top3);
});

app.post('/api/verify-bio', async (req, res) => {
    const { userId, username, expectedCode } = req.body;
    try {
        const response = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
        if (response.data.description.includes(expectedCode)) {
            if (!userDB[userId]) userDB[userId] = { username, balance: 1000, wagered: 0, joined: Date.now() };
            saveDB();
            res.json({ success: true, data: userDB[userId] });
        } else { res.json({ success: false, message: "Code not found in bio!" }); }
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/give', (req, res) => {
    const { adminId, targetId, amount } = req.body;
    if (adminId !== OWNER_ID) return res.status(403).send("No");
    if (userDB[targetId]) {
        userDB[targetId].balance += parseInt(amount);
        saveDB();
        io.emit('update_balance', { userId: targetId, newBalance: userDB[targetId].balance, wagered: userDB[targetId].wagered });
        res.json({ success: true });
    }
});

// --- SOCKET ENGINE ---
io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.userId = userId;
        socket.emit('list_flips', activeFlips);
    });

    socket.on('gem_click', (data) => {
        const uid = data.userId;
        const now = Date.now();
        if (clickCooldowns[uid] && (now - clickCooldowns[uid]) < 100) return;
        clickCooldowns[uid] = now;
        if (userDB[uid]) {
            const lvl = Math.floor(Math.sqrt(userDB[uid].wagered / 100)) + 1;
            userDB[uid].balance += lvl;
            saveDB();
            socket.emit('update_balance', { userId: uid, newBalance: userDB[uid].balance, wagered: userDB[uid].wagered });
        }
    });

    socket.on('create_flip', (data) => {
        const u = userDB[data.userId];
        if (u && u.balance >= data.amount) {
            u.balance -= data.amount;
            activeFlips.push({ id: Date.now(), creator: data });
            saveDB();
            io.emit('list_flips', activeFlips);
            socket.emit('update_balance', { userId: data.userId, newBalance: u.balance, wagered: u.wagered });
        }
    });

    socket.on('join_flip', async (data) => {
        const idx = activeFlips.findIndex(g => g.id === data.gameId);
        const game = activeFlips[idx];
        const joiner = userDB[data.userId];
        if (game && joiner && joiner.balance >= game.creator.amount) {
            joiner.balance -= game.creator.amount;
            const resSide = Math.random() > 0.5 ? 'Heads' : 'Tails';
            const winId = (game.creator.side === resSide) ? game.creator.userId : data.userId;
            
            io.emit('flip_results', {
                creatorName: game.creator.username, creatorPfp: game.creator.pfp,
                joinerName: joiner.username, resultSide: resSide, winnerName: userDB[winId].username
            });

            setTimeout(() => {
                userDB[winId].balance += Math.floor(game.creator.amount * 1.95);
                userDB[game.creator.userId].wagered += game.creator.amount;
                userDB[data.userId].wagered += game.creator.amount;
                saveDB();
                io.emit('update_balance', { userId: game.creator.userId, newBalance: userDB[game.creator.userId].balance, wagered: userDB[game.creator.userId].wagered });
                io.emit('update_balance', { userId: data.userId, newBalance: userDB[data.userId].balance, wagered: userDB[data.userId].wagered });
            }, 2500);
            activeFlips.splice(idx, 1);
            io.emit('list_flips', activeFlips);
        }
    });

    socket.on('send_message', (m) => {
        io.emit('new_message', { ...m, role: m.userId === OWNER_ID ? "OWNER" : "USER" });
    });
});

server.listen(PORT, () => console.log(`Live on ${PORT}`));
