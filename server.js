const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay');
const { Server } = require('socket.io');
const { connectDB, dbReady, User, Message, pairKeyFor, addMutualContact } = require('./db');

const app = express();
const server = http.createServer(app);
app.use(express.json());

// Set JWT_SECRET as an env var on Render — any long random string. Used to
// sign login sessions. If unset, a random one is generated at boot, which
// means everyone gets logged out whenever the server restarts — fine for
// testing, not for production.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRY = '30d';

connectDB();

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

// ============================================================
// Premium / Razorpay
// ============================================================
// Set these as env vars on Render (Settings > Environment):
//   RAZORPAY_KEY_ID       - from your Razorpay dashboard (safe to expose to the client)
//   RAZORPAY_KEY_SECRET   - from your Razorpay dashboard (never expose this)
//   PREMIUM_TOKEN_SECRET  - any long random string, used to sign premium tokens
//   PREMIUM_PRICE_PAISE   - optional, defaults to 4900 (₹49). Amount in paise.
//
// Flow:
//  1. Client calls POST /api/razorpay/create-order to get a Razorpay order.
//  2. Client opens Razorpay Checkout with that order.
//  3. On success, client calls POST /api/razorpay/verify with the payment
//     details Razorpay gives back.
//  4. Server verifies the payment signature (never trust the client alone),
//     then issues a signed "premium token" the client stores locally.
//  5. When matching, the client sends that token along; the server verifies
//     it before honoring a specific gender preference. If the token is
//     missing/invalid/expired, the server silently forces prefer to "any" —
//     so premium can never be faked from the browser console.

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const PREMIUM_TOKEN_SECRET = process.env.PREMIUM_TOKEN_SECRET || 'change-this-secret-before-going-live';
const PREMIUM_PRICE_PAISE = parseInt(process.env.PREMIUM_PRICE_PAISE || '4900', 10);
const PREMIUM_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const razorpay = RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : null;

app.get('/api/razorpay/config', (req, res) => {
  res.json({ keyId: RAZORPAY_KEY_ID, amount: PREMIUM_PRICE_PAISE, currency: 'INR' });
});

app.post('/api/razorpay/create-order', async (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
  }
  try {
    const order = await razorpay.orders.create({
      amount: PREMIUM_PRICE_PAISE,
      currency: 'INR',
      receipt: `wl_${Date.now()}`,
    });
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: RAZORPAY_KEY_ID });
  } catch (err) {
    console.error('[razorpay] order creation failed', err);
    res.status(500).json({ error: 'Could not create order.' });
  }
});

function signPremiumToken(expiresAt) {
  const payload = `${expiresAt}`;
  const sig = crypto.createHmac('sha256', PREMIUM_TOKEN_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyPremiumToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', PREMIUM_TOKEN_SECRET).update(payload).digest('hex');
  if (sig !== expected) return false;
  const expiresAt = parseInt(payload, 10);
  if (!Number.isFinite(expiresAt)) return false;
  return Date.now() < expiresAt;
}

app.post('/api/razorpay/verify', (req, res) => {
  if (!razorpay) {
    return res.status(503).json({ error: 'Payments are not configured on this server yet.' });
  }
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment details.' });
  }
  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment verification failed.' });
  }

  const expiresAt = Date.now() + PREMIUM_DURATION_MS;
  const token = signPremiumToken(expiresAt);
  res.json({ success: true, token, expiresAt });
});

// ============================================================
// Accounts & chat history
// ============================================================
// Requires MONGODB_URI and JWT_SECRET env vars (see db.js). Registration
// and login work regardless of Razorpay/premium — accounts are free.
// Users who aren't logged in can still chat as guests; their messages
// just aren't saved anywhere.

function signAuthToken(user) {
  return jwt.sign({ sub: String(user._id), username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

// Express middleware: attaches req.user if a valid token is present,
// otherwise leaves it undefined (routes decide if that's allowed).
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch {
      // invalid/expired token — treat as logged out rather than erroring
    }
  }
  next();
}

function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    next();
  });
}

app.post('/api/auth/register', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Accounts are not configured on this server yet.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const cleanUsername = username.trim();
  if (cleanUsername.length < 3 || cleanUsername.length > 24 || !/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Username must be 3-24 characters: letters, numbers, underscores only.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  try {
    const existing = await User.findOne({ username: cleanUsername });
    if (existing) return res.status(409).json({ error: 'That username is taken.' });

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ username: cleanUsername, passwordHash });
    res.json({ token: signAuthToken(user), username: user.username });
  } catch (err) {
    console.error('[auth] register failed', err);
    res.status(500).json({ error: 'Could not create account.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!dbReady()) return res.status(503).json({ error: 'Accounts are not configured on this server yet.' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  try {
    const user = await User.findOne({ username: username.trim() });
    if (!user) return res.status(401).json({ error: 'Incorrect username or password.' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Incorrect username or password.' });
    res.json({ token: signAuthToken(user), username: user.username });
  } catch (err) {
    console.error('[auth] login failed', err);
    res.status(500).json({ error: 'Could not log in.' });
  }
});

app.get('/api/auth/me', optionalAuth, (req, res) => {
  res.json({ loggedIn: !!req.user, username: req.user ? req.user.username : null });
});

// List everyone the current user has an existing conversation with,
// most recent message first.
app.get('/api/history', requireAuth, async (req, res) => {
  try {
    const myId = req.user.sub;
    const messages = await Message.aggregate([
      { $match: { pairKey: { $regex: myId } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$pairKey',
          lastMessage: { $first: '$$ROOT' },
        },
      },
      { $sort: { 'lastMessage.createdAt': -1 } },
      { $limit: 50 },
    ]);

    const conversations = messages.map((m) => {
      const otherId = m._id.split('_').find((id) => id !== myId);
      return {
        pairKey: m._id,
        otherUserId: otherId,
        lastMessagePreview:
          m.lastMessage.type === 'text' ? m.lastMessage.text : `[${m.lastMessage.type}]`,
        lastMessageAt: m.lastMessage.createdAt,
        lastMessageWasMine: String(m.lastMessage.fromUserId) === myId,
      };
    });

    // Resolve usernames for the "other" side of each conversation.
    const otherIds = conversations.map((c) => c.otherUserId).filter(Boolean);
    const users = await User.find({ _id: { $in: otherIds } }, 'username');
    const idToName = Object.fromEntries(users.map((u) => [String(u._id), u.username]));

    res.json({
      conversations: conversations.map((c) => ({
        ...c,
        otherUsername: idToName[c.otherUserId] || 'Deleted user',
      })),
    });
  } catch (err) {
    console.error('[history] list failed', err);
    res.status(500).json({ error: 'Could not load history.' });
  }
});

// Full message thread with one specific person, oldest first.
app.get('/api/history/:otherUserId', requireAuth, async (req, res) => {
  try {
    const myId = req.user.sub;
    const key = pairKeyFor(myId, req.params.otherUserId);
    const messages = await Message.find({ pairKey: key }).sort({ createdAt: 1 }).limit(500);
    res.json({
      messages: messages.map((m) => ({
        id: String(m._id),
        fromUsername: m.fromUsername,
        mine: String(m.fromUserId) === myId,
        type: m.type,
        text: m.text,
        url: m.url,
        emoji: m.emoji,
        createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    console.error('[history] thread failed', err);
    res.status(500).json({ error: 'Could not load conversation.' });
  }
});

// --- Matching state ---
// waiting: array of { socketId, gender, prefer }
let waiting = [];
// active pairs: socketId -> partnerSocketId
const partners = new Map();
// userId -> socketId, for logged-in users currently connected — lets a
// contact be reached directly instead of only via random matching.
const onlineUsers = new Map();

// Everyone the current user has added, with a live online/offline flag.
app.get('/api/contacts', requireAuth, async (req, res) => {
  try {
    const me = await User.findById(req.user.sub).populate('contacts', 'username');
    if (!me) return res.status(404).json({ error: 'User not found.' });
    res.json({
      contacts: me.contacts.map((c) => ({
        userId: String(c._id),
        username: c.username,
        online: onlineUsers.has(String(c._id)),
      })),
    });
  } catch (err) {
    console.error('[contacts] list failed', err);
    res.status(500).json({ error: 'Could not load contacts.' });
  }
});

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

// Socket-level auth: reads the JWT from the connection handshake (client
// passes it as `auth: { token }` when connecting). Anonymous/guest sockets
// are still allowed through — socket.data.user just stays undefined.
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (token) {
    try {
      socket.data.user = jwt.verify(token, JWT_SECRET);
    } catch {
      // invalid/expired token — proceed as guest
    }
  }
  next();
});

io.on('connection', (socket) => {
  if (socket.data.user) {
    onlineUsers.set(socket.data.user.sub, socket.id);
  }

  // Loads shared history (if any) and emits 'matched' to both sides —
  // shared by both random matching and direct-connect-to-contact.
  async function connectPair(aSocketId, aInfo, bSocketId, bInfo) {
    partners.set(aSocketId, bSocketId);
    partners.set(bSocketId, aSocketId);
    const shared = sharedInterests(aInfo, bInfo);
    const bothLoggedIn = aInfo.userId && bInfo.userId && dbReady();

    const emitMatch = async (targetSocketId, partnerGender, partnerUsername, myId, otherId) => {
      const payload = { partnerGender, shared, partnerUsername: partnerUsername || null, history: [] };
      if (bothLoggedIn) {
        try {
          const key = pairKeyFor(myId, otherId);
          const past = await Message.find({ pairKey: key }).sort({ createdAt: 1 }).limit(200);
          payload.history = past.map((m) => ({
            id: String(m._id),
            fromUsername: m.fromUsername,
            type: m.type,
            text: m.text,
            url: m.url,
            emoji: m.emoji,
          }));
        } catch (err) {
          console.error('[history] failed to load on match', err);
        }
      }
      io.to(targetSocketId).emit('matched', payload);
    };

    emitMatch(aSocketId, bInfo.gender, bInfo.username, aInfo.userId, bInfo.userId);
    emitMatch(bSocketId, aInfo.gender, aInfo.username, bInfo.userId, aInfo.userId);
  }

  socket.on('find-partner', ({ gender, prefer, interests, premiumToken }) => {
    // basic validation
    const validGenders = ['male', 'female', 'other'];
    const validPrefers = ['male', 'female', 'any'];
    if (!validGenders.includes(gender) || !validPrefers.includes(prefer)) return;
    const cleanInterests = Array.isArray(interests)
      ? interests.filter((i) => typeof i === 'string').slice(0, 10)
      : [];

    // A specific gender preference is a premium feature. Never trust the
    // client's claim alone — verify the signed token server-side. If it's
    // missing, invalid, or expired, silently fall back to "any".
    const isPremium = prefer !== 'any' ? verifyPremiumToken(premiumToken) : true;
    const effectivePrefer = isPremium ? prefer : 'any';

    // If already paired, unpair first
    endChat(socket.id, false);

    const entry = {
      socketId: socket.id,
      gender,
      prefer: effectivePrefer,
      interests: cleanInterests,
      userId: socket.data.user ? socket.data.user.sub : null,
      username: socket.data.user ? socket.data.user.username : null,
    };
    const partner = tryMatch(entry);

    if (partner) {
      connectPair(socket.id, entry, partner.socketId, partner);
    } else {
      io.to(socket.id).emit('waiting');
    }
  });

  // Reconnect directly with someone already in your contacts, bypassing
  // random matching entirely. Only works if they're online right now and
  // you're both logged in — you can only direct-connect to an existing
  // contact, never an arbitrary username, so this can't be used to seek
  // out a stranger by name.
  socket.on('direct-connect', async ({ username }) => {
    if (!socket.data.user || typeof username !== 'string') {
      io.to(socket.id).emit('contact-offline', { username });
      return;
    }
    try {
      const me = await User.findById(socket.data.user.sub);
      const target = await User.findOne({ username: username.trim() });
      if (!target || !me.contacts.some((c) => String(c) === String(target._id))) {
        io.to(socket.id).emit('contact-offline', { username });
        return;
      }
      const targetSocketId = onlineUsers.get(String(target._id));
      if (!targetSocketId) {
        io.to(socket.id).emit('contact-offline', { username });
        return;
      }
      endChat(socket.id, false);
      endChat(targetSocketId, false);
      const myInfo = {
        socketId: socket.id,
        gender: 'other',
        interests: [],
        userId: String(me._id),
        username: me.username,
      };
      const targetInfo = {
        socketId: targetSocketId,
        gender: 'other',
        interests: [],
        userId: String(target._id),
        username: target.username,
      };
      connectPair(socket.id, myInfo, targetSocketId, targetInfo);
    } catch (err) {
      console.error('[direct-connect] failed', err);
      io.to(socket.id).emit('contact-offline', { username });
    }
  });

  // Adds your current chat partner as a contact. Only works while you're
  // actively paired with them and both of you are logged in.
  socket.on('add-contact', async () => {
    const partnerId = partners.get(socket.id);
    const partnerSocket = partnerId ? io.sockets.sockets.get(partnerId) : null;
    const me = socket.data.user;
    const them = partnerSocket ? partnerSocket.data.user : null;
    if (!me || !them) {
      io.to(socket.id).emit('add-contact-result', { success: false, error: 'You both need to be logged in to add a contact.' });
      return;
    }
    try {
      await addMutualContact(me.sub, them.sub);
      io.to(socket.id).emit('add-contact-result', { success: true, username: them.username });
      io.to(partnerId).emit('add-contact-result', { success: true, username: me.username });
    } catch (err) {
      console.error('[add-contact] failed', err);
      io.to(socket.id).emit('add-contact-result', { success: false, error: 'Could not add contact.' });
    }
  });

  socket.on('chat-message', async (payload) => {
    const partnerId = partners.get(socket.id);
    if (!partnerId || !payload || typeof payload !== 'object') return;
    const id = typeof payload.id === 'string' ? payload.id.slice(0, 64) : undefined;

    const partnerSocket = io.sockets.sockets.get(partnerId);
    const me = socket.data.user;
    const them = partnerSocket ? partnerSocket.data.user : null;
    const canSave = me && them && dbReady();

    async function save(fields) {
      if (!canSave) return;
      try {
        await Message.create({
          pairKey: pairKeyFor(me.sub, them.sub),
          fromUserId: me.sub,
          fromUsername: me.username,
          ...fields,
        });
      } catch (err) {
        console.error('[history] save failed', err);
      }
    }

    if (payload.type === 'gif') {
      if (typeof payload.url !== 'string' || !isAllowedGifUrl(payload.url)) return;
      io.to(partnerId).emit('chat-message', { type: 'gif', url: payload.url, id });
      save({ type: 'gif', url: payload.url });
      return;
    }

    if (payload.type === 'sticker') {
      if (typeof payload.emoji !== 'string' || payload.emoji.length > 8) return;
      io.to(partnerId).emit('chat-message', { type: 'sticker', emoji: payload.emoji, id });
      save({ type: 'sticker', emoji: payload.emoji });
      return;
    }

    // default: text
    if (typeof payload.text !== 'string') return;
    const clean = filterMessage(payload.text.slice(0, 1000));
    io.to(partnerId).emit('chat-message', { type: 'text', text: clean, id });
    save({ type: 'text', text: clean });
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
    if (socket.data.user && onlineUsers.get(socket.data.user.sub) === socket.id) {
      onlineUsers.delete(socket.data.user.sub);
    }
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
