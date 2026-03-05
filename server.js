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

// --- SERVE HOME PAGE ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- DATABASE LOGIC ---
let userDB = {};
if (fs.existsSync(DB_FILE)) {
    try { userDB = JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { userDB = {}; }
}
const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(userDB, null, 2));

let activeFlips = [];
const clickCooldowns = {};

// --- ROBLOX API ---
app.get('/api/roblox-pfp/:userId', async (req, res) => {
    try {
        const response = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${req.params.userId}&size=150x150&format=Png&isCircular=true`);
        res.json({ pfpUrl: response.data.data[0].imageUrl });
    } catch (e) { res.status(500).json({ error: "Avatar fetch failed" }); }
});

// --- AUTH & ADMIN ---
app.post('/api/verify-bio', async (req, res) => {
    const { userId, username, expectedCode } = req.body;
    try {
        const response = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
        if (response.data.description.includes(expectedCode)) {
            if (!userDB[userId]) userDB[userId] = { username, balance: 1000, wagered: 0, level: 1, joined: Date.now() };
            saveDB();
            res.json({ success: true, data: userDB[userId] });
        } else { res.json({ success: false, message: "Code not found in bio!" }); }
    } catch (error) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/give', (req, res) => {
    const { adminId, targetId, amount } = req.body;
    if (adminId !== OWNER_ID) return res.status(403).send("Unauthorized");
    if (userDB[targetId]) {
        userDB[targetId].balance += parseInt(amount);
        saveDB();
        io.emit('update_balance', { userId: targetId, newBalance: userDB[targetId].balance });
        res.json({ success: true });
    }
});

app.post('/api/admin/announce', (req, res) => {
    const { adminId, message } = req.body;
    if (adminId !== OWNER_ID) return res.status(403).send("Unauthorized");
    io.emit('new_message', { username: "SYSTEM", text: `📢 ${message}`, role: "OWNER" });
    res.json({ success: true });
});

// --- SOCKET ENGINE ---
io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.userId = userId;
        socket.emit('list_flips', activeFlips);
    });

    // CLICKER LOGIC
    socket.on('gem_click', (data) => {
        const uid = data.userId;
        const now = Date.now();
        if (clickCooldowns[uid] && (now - clickCooldowns[uid]) < 100) return; // 10 clicks per sec max
        clickCooldowns[uid] = now;

        if (userDB[uid]) {
            const lvl = Math.floor(Math.sqrt(userDB[uid].wagered / 100)) + 1;
            userDB[uid].balance += lvl;
            saveDB();
            socket.emit('update_balance', { userId: uid, newBalance: userDB[uid].balance });
            socket.emit('update_click_value', lvl);
        }
    });

    // COINFLIP LOGIC
    socket.on('create_flip', (data) => {
        const u = userDB[data.userId];
        if (u && u.balance >= data.amount) {
            u.balance -= data.amount;
            const game = { id: Date.now(), creator: data };
            activeFlips.push(game);
            saveDB();
            io.emit('list_flips', activeFlips);
            socket.emit('update_balance', { userId: data.userId, newBalance: u.balance });
        }
    });

    socket.on('cancel_flip', (gameId) => {
        const idx = activeFlips.findIndex(g => g.id === gameId);
        if (idx > -1 && activeFlips[idx].creator.userId === socket.userId) {
            userDB[socket.userId].balance += activeFlips[idx].creator.amount;
            activeFlips.splice(idx, 1);
            saveDB();
            io.emit('list_flips', activeFlips);
            socket.emit('update_balance', { userId: socket.userId, newBalance: userDB[socket.userId].balance });
        }
    });

    socket.on('join_flip', async (data) => {
        const idx = activeFlips.findIndex(g => g.id === data.gameId);
        const game = activeFlips[idx];
        const joiner = userDB[data.userId];
        if (game && joiner && joiner.balance >= game.creator.amount && game.creator.userId !== data.userId) {
            joiner.balance -= game.creator.amount;
            const resSide = Math.random() > 0.5 ? 'Heads' : 'Tails';
            const winId = (game.creator.side === resSide) ? game.creator.userId : data.userId;
            const pot = Math.floor(game.creator.amount * 1.95);

            const pfpRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${data.userId}&size=150x150&format=Png&isCircular=true`);
            
            io.emit('flip_results', {
                creatorName: game.creator.username, creatorPfp: game.creator.pfp,
                joinerName: joiner.username, joinerPfp: pfpRes.data.data[0].imageUrl,
                resultSide: resSide, winnerName: userDB[winId].username
            });

            setTimeout(() => {
                userDB[winId].balance += pot;
                userDB[game.creator.userId].wagered += game.creator.amount;
                userDB[data.userId].wagered += game.creator.amount;
                saveDB();
                io.emit('update_balance', { userId: game.creator.userId, newBalance: userDB[game.creator.userId].balance });
                io.emit('update_balance', { userId: data.userId, newBalance: userDB[data.userId].balance });
            }, 2500);

            activeFlips.splice(idx, 1);
            io.emit('list_flips', activeFlips);
        }
    });

    socket.on('send_message', (m) => {
        io.emit('new_message', { ...m, role: m.userId === OWNER_ID ? "OWNER" : "USER" });
    });
});

server.listen(PORT, () => console.log(`Server live on port ${PORT}`));
