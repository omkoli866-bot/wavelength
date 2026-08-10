const mongoose = require('mongoose');

let isConnected = false;

// Set MONGODB_URI as an env var on Render, e.g. a free MongoDB Atlas cluster
// connection string: mongodb+srv://user:pass@cluster.mongodb.net/wavelength
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[db] MONGODB_URI not set — accounts and chat history are disabled.');
    return false;
  }
  try {
    await mongoose.connect(uri);
    isConnected = true;
    console.log('[db] connected to MongoDB');
    return true;
  } catch (err) {
    console.error('[db] connection failed', err.message);
    return false;
  }
}

function dbReady() {
  return isConnected;
}

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, minlength: 3, maxlength: 24 },
  passwordHash: { type: String, required: true },
  contacts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now },
});

const messageSchema = new mongoose.Schema({
  // pairKey uniquely identifies a conversation between two specific users,
  // independent of who initiated the match: sorted "userIdA_userIdB".
  pairKey: { type: String, required: true, index: true },
  fromUserId: { type: mongoose.Schema.Types.ObjectId, required: true },
  fromUsername: { type: String, required: true },
  type: { type: String, enum: ['text', 'gif', 'sticker'], default: 'text' },
  text: String,
  url: String,
  emoji: String,
  createdAt: { type: Date, default: Date.now, index: true },
});

const User = mongoose.models.User || mongoose.model('User', userSchema);
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

function pairKeyFor(idA, idB) {
  return [String(idA), String(idB)].sort().join('_');
}

// Adds each user to the other's contact list (mutual — you can only add
// someone you've actually just been chatting with, so consent is implicit).
async function addMutualContact(idA, idB) {
  if (String(idA) === String(idB)) return;
  await User.updateOne({ _id: idA }, { $addToSet: { contacts: idB } });
  await User.updateOne({ _id: idB }, { $addToSet: { contacts: idA } });
}

module.exports = { connectDB, dbReady, User, Message, pairKeyFor, addMutualContact };
