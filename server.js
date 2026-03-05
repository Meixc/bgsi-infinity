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

// --- DATABASE INITIALIZATION ---
let userDB = {};
if (fs.existsSync(DB_FILE)) {
    try { 
        const data = fs.readFileSync(DB_FILE, 'utf8');
        userDB = JSON.parse(data); 
    } catch (e) { 
        console.log("DB Load Error, starting fresh:", e);
        userDB = {}; 
    }
}

const saveDB = () => {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(userDB, null, 2));
    } catch (e) {
        console.error("Failed to save database:", e);
    }
};

// Serving the main site
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let activeFlips = [];
const clickCooldowns = {};

// --- API ROUTES ---

// Get User Profile Picture from Roblox
app.get('/api/roblox-pfp/:userId', async (req, res) => {
    try {
        const response = await axios.get(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${req.params.userId}&size=150x150&format=Png&isCircular=true`);
        if (response.data && response.data.data.length > 0) {
            res.json({ pfpUrl: response.data.data[0].imageUrl });
        } else {
            res.json({ pfpUrl: "" });
        }
    } catch (e) { 
        res.status(500).json({ error: "Avatar fetch failed" }); 
    }
});

// Leaderboard Logic
app.get('/api/leaderboard', (req, res) => {
    const top3 = Object.values(userDB)
        .sort((a, b) => b.wagered - a.wagered)
        .slice(0, 3)
        .map((u, i) => ({ username: u.username, wagered: u.wagered, rank: i + 1 }));
    res.json(top3);
});

// BIO VERIFICATION (The part causing "Server Error")
app.post('/api/verify-bio', async (req, res) => {
    const { userId, username, expectedCode } = req.body;
    
    if (!userId || !username || !expectedCode) {
        return res.status(400).json({ success: false, message: "Missing login data" });
    }

    try {
        // Fetch User Bio from Roblox
        const response = await axios.get(`https://users.roblox.com/v1/users/${userId}`);
        const bio = response.data.description || "";

        if (bio.includes(expectedCode)) {
            // If user doesn't exist in our DB, create them
            if (!userDB[userId]) {
                userDB[userId] = { 
                    username: username, 
                    balance: 1000, 
                    wagered: 0, 
                    joined: Date.now() 
                };
            }
            saveDB();
            res.json({ success: true, data: userDB[userId] });
        } else {
            res.json({ success: false, message: "Code not found in your Roblox bio! Make sure you saved it." });
        }
    } catch (error) {
        console.error("Roblox API Error:", error.message);
        res.status(500).json({ success: false, message: "Roblox API is down or User ID is invalid." });
    }
});

// Admin Give Gems
app.post('/api/admin/give', (req, res) => {
    const { adminId, targetId, amount } = req.body;
    if (adminId !== OWNER_ID) return res.status(403).send("Unauthorized");
    
    if (userDB[targetId]) {
        userDB[targetId].balance += parseInt(amount);
        saveDB();
        io.emit('update_balance', { 
            userId: targetId, 
            newBalance: userDB[targetId].balance, 
            wagered: userDB[targetId].wagered 
        });
        res.json({ success: true });
    } else {
        res.status(404).json({ success: false, message: "User not found in database" });
    }
});

// Admin Announcement
app.post('/api/admin/announce', (req, res) => {
    const { adminId, message } = req.body;
    if (adminId !== OWNER_ID) return res.status(403).send("Unauthorized");
    io.emit('new_message', { username: "SYSTEM", text: `📢 ${message}`, role: "OWNER" });
    res.json({ success: true });
});

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    socket.on('join', (userId) => {
        socket.userId = userId;
        socket.emit('list_flips', activeFlips);
    });

    socket.on('gem_click', (data) => {
        const uid = data.userId;
        if (!uid || !userDB[uid]) return;

        if (clickCooldowns[uid] && (Date.now() - clickCooldowns[uid]) < 100) return;
        clickCooldowns[uid] = Date.now();

        const lvl = Math.floor(Math.sqrt(userDB[uid].wagered / 100)) + 1;
        userDB[uid].balance += lvl;
        saveDB();

        socket.emit('update_balance', { 
            userId: uid, 
            newBalance: userDB[uid].balance, 
            wagered: userDB[uid].wagered 
        });
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

    socket.on('join_flip', async (data) => {
        const idx = activeFlips.findIndex(g => g.id === data.gameId);
        const game = activeFlips[idx];
        const joiner = userDB[data.userId];
        
        if (game && joiner && game.creator.userId !== data.userId && joiner.balance >= game.creator.amount) {
            joiner.balance -= game.creator.amount;
            const resSide = Math.random() > 0.5 ? 'Heads' : 'Tails';
            const winId = (game.creator.side === resSide) ? game.creator.userId : data.userId;
            
            io.emit('flip_results', {
                creatorName: game.creator.username, 
                creatorPfp: game.creator.pfp,
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

    socket.on('send_message', (m) => {
        if (!m.text || m.text.length > 200) return;
        io.emit('new_message', { 
            username: m.username, 
            text: m.text, 
            role: m.userId === OWNER_ID ? "OWNER" : "USER" 
        });
    });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
