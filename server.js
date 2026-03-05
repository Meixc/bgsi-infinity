const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = 3000;
const DB_FILE = './database.json';
const OWNER_ID = "7957630713"; // Your ID

app.use(cors());
app.use(express.json());

// --- DATABASE PERSISTENCE ---
let userDB = {};
if (fs.existsSync(DB_FILE)) {
    try {
        userDB = JSON.parse(fs.readFileSync(DB_FILE));
    } catch (e) {
        userDB = {};
    }
}

const saveDB = () => fs.writeFileSync(DB_FILE, JSON.stringify(userDB, null, 2));

// --- STATE ---
let activeFlips = [];

// --- ROBLOX API PROXY ---
app.get('/api/roblox-pfp/:userId', async (req, res) => {
    try {
        const response = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${req.params.userId}&size=150x150&format=Png&isCircular=true`);
        res.json({ pfpUrl: response.data.data[0].imageUrl });
    } catch (e) {
        res.status(500).json({ error: "Failed to fetch avatar" });
    }
});

// --- VERIFICATION & DATA LOADING ---
app.post('/api/verify-bio', async (req, res) => {
    const { userId, username, expectedCode } = req.body;
    try {
        const response = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
        const actualBio = response.data.description;

        if (actualBio.includes(expectedCode)) {
            if (!userDB[userId]) {
                userDB[userId] = { username, balance: 1000, wagered: 0, level: 1, joined: Date.now() };
            }
            saveDB();
            res.json({ success: true, data: userDB[userId] });
        } else {
            res.json({ success: false, message: "Code not found in bio!" });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "Roblox API error." });
    }
});

// --- ADMIN API ---
app.post('/api/admin/give', (req, res) => {
    const { adminId, targetId, amount } = req.body;
    if (adminId !== OWNER_ID) return res.status(403).json({ error: "Unauthorized" });

    if (userDB[targetId]) {
        userDB[targetId].balance += parseInt(amount);
        saveDB();
        io.emit('update_balance', { userId: targetId, newBalance: userDB[targetId].balance });
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "User not found" });
    }
});

app.post('/api/admin/announce', (req, res) => {
    const { adminId, message } = req.body;
    if (adminId !== OWNER_ID) return res.status(403).json({ error: "Unauthorized" });

    io.emit('new_message', { 
        username: "SYSTEM", 
        text: `📢 ANNOUNCEMENT: ${message}`, 
        role: "OWNER" 
    });
    res.json({ success: true });
});

// --- LEADERBOARD ---
app.get('/api/leaderboard', (req, res) => {
    const leaderboard = Object.values(userDB)
        .sort((a, b) => b.wagered - a.wagered)
        .slice(0, 10)
        .map((user, index) => ({
            rank: index + 1,
            username: user.username,
            wagered: user.wagered,
            level: Math.floor(Math.sqrt(user.wagered / 100)) + 1
        }));
    res.json(leaderboard);
});

// --- SOCKET ENGINE ---

io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.userId = userId;
        socket.emit('list_flips', activeFlips);
        if(userDB[userId]) socket.emit('update_balance', { userId, newBalance: userDB[userId].balance });
    });

    // Create Flip
    socket.on('create_flip', (data) => {
        const user = userDB[data.userId];
        if (user && user.balance >= data.amount) {
            user.balance -= data.amount;
            const game = { 
                id: Date.now(), 
                creator: { ...data, side: data.side }, 
                status: 'waiting' 
            };
            activeFlips.push(game);
            saveDB();
            io.emit('list_flips', activeFlips);
            socket.emit('update_balance', { userId: data.userId, newBalance: user.balance });
        }
    });

    // Cancel Flip
    socket.on('cancel_flip', (gameId) => {
        const gameIndex = activeFlips.findIndex(g => g.id === gameId);
        const game = activeFlips[gameIndex];
        if (game && game.creator.userId === socket.userId) {
            userDB[socket.userId].balance += game.creator.amount;
            activeFlips.splice(gameIndex, 1);
            saveDB();
            io.emit('list_flips', activeFlips);
            socket.emit('update_balance', { userId: socket.userId, newBalance: userDB[socket.userId].balance });
        }
    });

    // Join & Resolve Flip
    socket.on('join_flip', async (data) => {
        const gameIndex = activeFlips.findIndex(g => g.id === data.gameId);
        const game = activeFlips[gameIndex];
        const joiner = userDB[data.userId];

        if (game && joiner && joiner.balance >= game.creator.amount && game.creator.userId !== data.userId) {
            joiner.balance -= game.creator.amount;
            
            // Logic
            const resultSide = Math.random() > 0.5 ? 'Heads' : 'Tails';
            const winnerId = (game.creator.side === resultSide) ? game.creator.userId : data.userId;
            const totalPot = Math.floor(game.creator.amount * 1.95);

            // Fetch Joiner PFP for animation
            const pfpRes = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${data.userId}&size=150x150&format=Png&isCircular=true`);
            
            // Broadcast animation to everyone
            io.emit('flip_results', {
                creatorName: game.creator.username,
                creatorPfp: game.creator.pfp,
                joinerName: joiner.username,
                joinerPfp: pfpRes.data.data[0].imageUrl,
                resultSide: resultSide,
                winnerName: userDB[winnerId].username,
                gameId: game.id
            });

            // Delay actual balance update to match animation (2 seconds)
            setTimeout(() => {
                userDB[winnerId].balance += totalPot;
                userDB[game.creator.userId].wagered += game.creator.amount;
                userDB[data.userId].wagered += game.creator.amount;
                
                saveDB();
                io.emit('update_balance', { userId: game.creator.userId, newBalance: userDB[game.creator.userId].balance });
                io.emit('update_balance', { userId: data.userId, newBalance: userDB[data.userId].balance });
            }, 2500);

            activeFlips.splice(gameIndex, 1);
            io.emit('list_flips', activeFlips);
        }
    });

    socket.on('send_message', (msg) => {
        const role = msg.userId === OWNER_ID ? "OWNER" : "USER";
        io.emit('new_message', { ...msg, role });
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));