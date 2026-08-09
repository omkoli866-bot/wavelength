const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow the frontend (e.g. your Netlify site) to connect from a different
// origin than this backend. Set ALLOWED_ORIGIN as an env var on Render to
// your Netlify URL, e.g. https://wavelength-chat.netlify.app
// Leaving it as "*" works too, but is less strict.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
  },
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.send('ok'));

// Real live numbers for the landing page — no fake stats, just what's
// actually happening on the server right now.
app.get('/stats', (req, res) => {
  res.json({ online: io.engine.clientsCount, waiting: waiting.length });
});

// Friendly aliases
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));

// --- Matching state ---
// waiting: array of { socketId, gender, prefer }
let waiting = [];
// active pairs: socketId -> partnerSocketId
const partners = new Map();

function compatible(a, b) {
  const genderOk =
    (a.prefer === 'any' || a.prefer === b.gender) &&
    (b.prefer === 'any' || b.prefer === a.gender);
  return genderOk;
}

function removeFromWaiting(socketId) {
  waiting = waiting.filter((w) => w.socketId !== socketId);
}

function tryMatch(entry) {
  const idx = waiting.findIndex((w) => compatible(entry, w) && w.socketId !== entry.socketId);
  if (idx === -1) {
    waiting.push(entry);
    return null;
  }
  const partner = waiting[idx];
  waiting.splice(idx, 1);
  return partner;
}

// Very small profanity filter — replace/extend with a real moderation
// service before running this for the public. This is NOT sufficient
// on its own for a production random-chat product.
const blockedWords = ['badword1', 'badword2'];
function filterMessage(text) {
  let out = text;
  for (const w of blockedWords) {
    const re = new RegExp(w, 'gi');
    out = out.replace(re, '*'.repeat(w.length));
  }
  return out;
}

io.on('connection', (socket) => {
  socket.on('find-partner', ({ gender, prefer }) => {
    // basic validation
    const validGenders = ['male', 'female', 'other'];
    const validPrefers = ['male', 'female', 'any'];
    if (!validGenders.includes(gender) || !validPrefers.includes(prefer)) return;

    // If already paired, unpair first
    endChat(socket.id, false);

    const entry = { socketId: socket.id, gender, prefer };
    const partner = tryMatch(entry);

    if (partner) {
      partners.set(socket.id, partner.socketId);
      partners.set(partner.socketId, socket.id);
      io.to(socket.id).emit('matched', { partnerGender: partner.gender });
      io.to(partner.socketId).emit('matched', { partnerGender: gender });
    } else {
      io.to(socket.id).emit('waiting');
    }
  });

  socket.on('chat-message', (text) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId || typeof text !== 'string') return;
    const clean = filterMessage(text.slice(0, 1000));
    io.to(partnerId).emit('chat-message', clean);
  });

  socket.on('typing', (isTyping) => {
    const partnerId = partners.get(socket.id);
    if (partnerId) io.to(partnerId).emit('typing', !!isTyping);
  });

  socket.on('skip', () => {
    endChat(socket.id, true);
  });

  socket.on('leave', () => {
    endChat(socket.id, false);
  });

  socket.on('report', () => {
    const partnerId = partners.get(socket.id);
    // In production: log this with timestamps/IPs to a moderation
    // system and take action (ban, review, etc).
    console.log(`[report] ${socket.id} reported ${partnerId || 'unknown'}`);
    endChat(socket.id, false);
  });

  socket.on('disconnect', () => {
    removeFromWaiting(socket.id);
    endChat(socket.id, false);
  });

  function endChat(id, requeue) {
    removeFromWaiting(id);
    const partnerId = partners.get(id);
    if (partnerId) {
      partners.delete(id);
      partners.delete(partnerId);
      io.to(partnerId).emit('partner-left');
    }
    if (requeue) {
      io.to(id).emit('ready-to-requeue');
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Random chat server running on http://localhost:${PORT}`);
});
