const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" },
    connectionStateRecovery: {} 
});

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const OWNER_ID = "7957630713"; 

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// --- DATABASE LOGIC ---
let userDB = {};
if (fs.existsSync(DB_FILE)) {
    try { 
        userDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); 
    } catch (e) { 
        console.error("DB Load Error:", e);
        userDB = {}; 
    }
}

const saveDB = () => {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(userDB, null, 2));
    } catch (e) {
        console.error("Save Error:", e);
    }
};

// --- GLOBAL STATE ---
let activeFlips = [];
let chatHistory = []; // Stores last 50 messages
const clickCooldowns = {};

// --- WEB ROUTES ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API ENDPOINTS ---

// Roblox PFP Fetcher
app.get('/api/roblox-pfp/:userId', async (req, res) => {
    try {
        const response = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${req.params.userId}&size=150x150&format=Png&isCircular=true`);
        res.json({ pfpUrl: response.data.data[0]?.imageUrl || "" });
    } catch (e) { res.status(500).json({ error: "Failed" }); }
});

// Leaderboard Data
app.get('/api/leaderboard', (req, res) => {
    const top = Object.values(userDB)
        .sort((a, b) => b.wagered - a.wagered)
        .slice(0, 3)
        .map((u, i) => ({ username: u.username, wagered: u.wagered, rank: i + 1 }));
    res.json(top);
});

// Roblox Bio Verification
app.post('/api/verify-bio', async (req, res) => {
    const { userId, username, expectedCode } = req.body;
    try {
        const response = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
        const bio = response.data.description || "";
        if (bio.includes(expectedCode)) {
            if (!userDB[userId]) {
                userDB[userId] = { username, balance: 1000, wagered: 0, joined: Date.now() };
            }
            saveDB();
            res.json({ success: true, data: userDB[userId] });
        } else {
            res.json({ success: false, message: "Code not found in bio!" });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "Roblox API error" });
    }
});

// Admin Panel: Give Gems
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

// Admin Panel: Announcements
app.post('/api/admin/announce', (req, res) => {
    const { adminId, message } = req.body;
    if (adminId !== OWNER_ID) return res.status(403).send("No");
    const msgObj = { username: "SYSTEM", text: `📢 ${message}`, role: "OWNER" };
    chatHistory.push(msgObj);
    if (chatHistory.length > 50) chatHistory.shift();
    io.emit('new_message', msgObj);
    res.json({ success: true });
});

// --- SOCKET ENGINE ---
io.on('connection', (socket) => {
    
    socket.on('join', (userId) => {
        socket.userId = userId;
        // Send history and current games to the person who just joined
        socket.emit('chat_history', chatHistory);
        socket.emit('list_flips', activeFlips);
    });

    socket.on('gem_click', (data) => {
        const uid = data.userId;
        if (!userDB[uid]) return;
        if (clickCooldowns[uid] && (Date.now() - clickCooldowns[uid]) < 100) return;
        clickCooldowns[uid] = Date.now();

        const lvl = Math.floor(Math.sqrt(userDB[uid].wagered / 100)) + 1;
        userDB[uid].balance += lvl;
        saveDB();
        socket.emit('update_balance', { userId: uid, newBalance: userDB[uid].balance, wagered: userDB[uid].wagered });
    });

    socket.on('send_message', (m) => {
        if (!m.text || m.text.trim().length === 0) return;
        const msgObj = { 
            username: m.username, 
            text: m.text, 
            role: m.userId === OWNER_ID ? "OWNER" : "USER" 
        };
        chatHistory.push(msgObj);
        if (chatHistory.length > 50) chatHistory.shift();
        io.emit('new_message', msgObj);
    });

    socket.on('create_flip', (data) => {
        const u = userDB[data.userId];
        if (u && u.balance >= data.amount && data.amount > 0) {
            u.balance -= data.amount;
            activeFlips.push({ id: Date.now(), creator: data });
            saveDB();
            io.emit('list_flips', activeFlips);
            socket.emit('update_balance', { userId: data.userId, newBalance: u.balance, wagered: u.wagered });
        }
    });

    socket.on('cancel_flip', (gameId) => {
        const idx = activeFlips.findIndex(g => g.id === gameId);
        if (idx > -1 && activeFlips[idx].creator.userId === socket.userId) {
            userDB[socket.userId].balance += activeFlips[idx].creator.amount;
            activeFlips.splice(idx, 1);
            saveDB();
            io.emit('list_flips', activeFlips);
            socket.emit('update_balance', { userId: socket.userId, newBalance: userDB[socket.userId].balance, wagered: userDB[socket.userId].wagered });
        }
    });

    socket.on('join_flip', (data) => {
        const idx = activeFlips.findIndex(g => g.id === data.gameId);
        const game = activeFlips[idx];
        const joiner = userDB[data.userId];
        
        // Block joining own flip
        if (game && joiner && game.creator.userId !== data.userId && joiner.balance >= game.creator.amount) {
            joiner.balance -= game.creator.amount;
            const resSide = Math.random() > 0.5 ? 'Heads' : 'Tails';
            const winId = (game.creator.side === resSide) ? game.creator.userId : data.userId;
            
            io.emit('flip_results', {
                creatorName: game.creator.username,
                joinerName: joiner.username,
                resultSide: resSide,
                winnerName: userDB[winId].username
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
});

server.listen(PORT, () => console.log(`Server live on port ${PORT}`));
