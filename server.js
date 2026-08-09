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

function sharedInterests(a, b) {
  const ai = Array.isArray(a.interests) ? a.interests : [];
  const bi = Array.isArray(b.interests) ? b.interests : [];
  return ai.filter((i) => bi.includes(i));
}

function removeFromWaiting(socketId) {
  waiting = waiting.filter((w) => w.socketId !== socketId);
}

function tryMatch(entry) {
  const candidates = waiting.filter((w) => compatible(entry, w) && w.socketId !== entry.socketId);
  if (candidates.length === 0) {
    waiting.push(entry);
    return null;
  }
  // Prefer whoever shares the most interests; ties go to whoever has been waiting longest.
  let best = candidates[0];
  let bestScore = sharedInterests(entry, best).length;
  for (const c of candidates.slice(1)) {
    const score = sharedInterests(entry, c).length;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  waiting = waiting.filter((w) => w.socketId !== best.socketId);
  return best;
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

// Only allow GIF URLs from known GIF CDNs — prevents the GIF feature
// from being used to relay arbitrary/untrusted image URLs.
const ALLOWED_GIF_HOSTS = [
  'media.tenor.com',
  'media1.giphy.com',
  'media2.giphy.com',
  'media3.giphy.com',
  'media4.giphy.com',
  'i.giphy.com',
];
function isAllowedGifUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_GIF_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

io.on('connection', (socket) => {
  socket.on('find-partner', ({ gender, prefer, interests }) => {
    // basic validation
    const validGenders = ['male', 'female', 'other'];
    const validPrefers = ['male', 'female', 'any'];
    if (!validGenders.includes(gender) || !validPrefers.includes(prefer)) return;
    const cleanInterests = Array.isArray(interests)
      ? interests.filter((i) => typeof i === 'string').slice(0, 10)
      : [];

    // If already paired, unpair first
    endChat(socket.id, false);

    const entry = { socketId: socket.id, gender, prefer, interests: cleanInterests };
    const partner = tryMatch(entry);

    if (partner) {
      partners.set(socket.id, partner.socketId);
      partners.set(partner.socketId, socket.id);
      const shared = sharedInterests(entry, partner);
      io.to(socket.id).emit('matched', { partnerGender: partner.gender, shared });
      io.to(partner.socketId).emit('matched', { partnerGender: gender, shared });
    } else {
      io.to(socket.id).emit('waiting');
    }
  });

  socket.on('chat-message', (payload) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId || !payload || typeof payload !== 'object') return;
    const id = typeof payload.id === 'string' ? payload.id.slice(0, 64) : undefined;

    if (payload.type === 'gif') {
      if (typeof payload.url !== 'string' || !isAllowedGifUrl(payload.url)) return;
      io.to(partnerId).emit('chat-message', { type: 'gif', url: payload.url, id });
      return;
    }

    if (payload.type === 'sticker') {
      if (typeof payload.emoji !== 'string' || payload.emoji.length > 8) return;
      io.to(partnerId).emit('chat-message', { type: 'sticker', emoji: payload.emoji, id });
      return;
    }

    // default: text
    if (typeof payload.text !== 'string') return;
    const clean = filterMessage(payload.text.slice(0, 1000));
    io.to(partnerId).emit('chat-message', { type: 'text', text: clean, id });
  });

  socket.on('typing', (isTyping) => {
    const partnerId = partners.get(socket.id);
    if (partnerId) io.to(partnerId).emit('typing', !!isTyping);
  });

  socket.on('icebreaker', (text) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId || typeof text !== 'string') return;
    io.to(partnerId).emit('icebreaker', text.slice(0, 200));
  });

  socket.on('reaction', ({ id, emoji }) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId || typeof id !== 'string' || typeof emoji !== 'string' || emoji.length > 8) return;
    io.to(partnerId).emit('reaction', { id, emoji });
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
