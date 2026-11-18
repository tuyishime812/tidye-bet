const path = require('path');
const fs = require('fs');
const { isSupabaseAvailable } = require('./supabase');
const localDB = require('./localDB');

const memoryUsers = new Map();
let memoryIdCounter = 1;

const CHAT_FILE = path.join(__dirname, '..', 'data', 'chat-messages.json');

function isMemoryMode() {
  return !isSupabaseAvailable();
}

function newId() {
  return `local_${memoryIdCounter++}`;
}

function allUsers() {
  return Array.from(memoryUsers.values());
}

/**
 * Persist the live users map. Called after every mutation so a restart cannot
 * lose accounts, balances or bans. Debounced + atomic inside localDB.
 */
function saveUsers() {
  localDB.scheduleSave();
}

// ---------------------------------------------------------------------------
// Boot: hydrate the users map from the durable local store.
//
// This is what makes "register once, log in later" work without Supabase.
// Records without an id, username or password hash are skipped: they could
// never authenticate and would only mask a corrupt file.
// ---------------------------------------------------------------------------
(function hydrate() {
  const db = localDB.load();
  const stored = Array.isArray(db.users) ? db.users : [];
  let maxSuffix = 0;

  for (const row of stored) {
    if (!row || typeof row !== 'object') continue;
    const id = typeof row.id === 'string' ? row.id : '';
    const userName = typeof row.user_name === 'string' ? row.user_name : '';
    const password = typeof row.password === 'string' ? row.password : '';
    if (!id || !userName || !password) continue;
    if (memoryUsers.has(id)) continue;

    memoryUsers.set(id, {
      ...row,
      // Normalise fields that older records may be missing so every consumer
      // can rely on them being present.
      balance: Number(row.balance) || 0,
      held: Number(row.held) || 0,
      is_banned: Boolean(row.is_banned),
      ban_reason: row.ban_reason || null,
      is_guest: Boolean(row.is_guest),
      currency: row.currency || 'MWK',
      avatar: row.avatar || '',
      created_at: row.created_at || new Date().toISOString(),
    });

    const match = /^local_(\d+)$/.exec(id);
    if (match) {
      const suffix = Number(match[1]);
      if (Number.isFinite(suffix) && suffix > maxSuffix) maxSuffix = suffix;
    }
  }

  memoryIdCounter = maxSuffix + 1;

  if (stored.length) {
    console.log(
      `[local-db] Loaded ${memoryUsers.size} account(s) from disk (durable local mode).`
    );
  }
})();

localDB.register('users', () => allUsers());

function findUserByPhone(phoneNumber) {
  return allUsers().find(u => u.phone_number === phoneNumber) || null;
}

function findUserByName(userName) {
  return allUsers().find(u => u.user_name === userName) || null;
}

function findUserById(id) {
  return memoryUsers.get(id) || null;
}

function createUser({ phone_number, user_name, password, email, balance, payout_phone, is_guest }) {
  // Mirror the database's UNIQUE constraints in local mode. The auth route
  // pre-checks, but two concurrent requests can still interleave between the
  // check and this call; throwing the same SQLSTATE keeps both modes honest.
  const phone =
    typeof phone_number === 'string' ? phone_number.trim() : String(phone_number || '');
  const name = typeof user_name === 'string' ? user_name.trim() : String(user_name || '');
  if (phone && findUserByPhone(phone)) {
    const error = new Error('duplicate key value violates unique constraint "users_phone_number_key"');
    error.code = '23505';
    error.details = 'Key (phone_number) already exists.';
    throw error;
  }
  if (name && findUserByName(name)) {
    const error = new Error('duplicate key value violates unique constraint "users_user_name_key"');
    error.code = '23505';
    error.details = 'Key (user_name) already exists.';
    throw error;
  }

  const user = {
    id: newId(),
    phone_number: phone,
    user_name: name,
    password,
    email: email || '',
    balance: typeof balance === 'number' ? balance : 0,
    // Money reserved for pending withdrawals. Mirrors users.held so the
    // "available to spend" calculation behaves the same in both modes.
    held: 0,
    // The registered payout wallet. Withdrawals may only go here; a request may
    // never introduce a new destination number.
    payout_phone: payout_phone || '',
    currency: 'MWK',
    avatar: '',
    user_type: false,
    // Suspension state. Mirrors users.is_banned in SCHEMA.sql and is enforced
    // on login and on the betting socket (see routes/auth.js, index.js).
    is_banned: false,
    ban_reason: null,
    // Guest accounts (quick play) hold demo credit that is not withdrawable
    // until the first real deposit clears the flag.
    is_guest: Boolean(is_guest),
    is_sound_enable: true,
    is_music_enable: true,
    created_at: new Date().toISOString(),
    last_login_at: null
  };
  memoryUsers.set(user.id, user);
  saveUsers();
  return user;
}

/**
 * Apply an already-validated patch to a user.
 *
 * The caller is responsible for building an allow-listed patch (never spread a
 * request body into this). Returns the updated record, or null if absent.
 */
function updateUser(id, patch) {
  const user = memoryUsers.get(id);
  if (!user) return null;
  if (patch && typeof patch === 'object') {
    Object.assign(user, patch);
  }
  saveUsers();
  return user;
}

/** Remove a user. Returns true when a record was actually deleted. */
function deleteUser(id) {
  const existed = memoryUsers.delete(id);
  if (existed) saveUsers();
  return existed;
}

/** Set the suspension flag + reason in one place. */
function setBanned(id, banned, reason) {
  const user = memoryUsers.get(id);
  if (!user) return null;
  user.is_banned = Boolean(banned);
  user.ban_reason = banned ? String(reason || '').slice(0, 200) || 'Suspended by operator' : null;
  saveUsers();
  return user;
}

/** Record a successful sign-in (used by the profile and the admin console). */
function touchLogin(id, ip) {
  const user = memoryUsers.get(id);
  if (!user) return null;
  user.last_login_at = new Date().toISOString();
  if (typeof ip === 'string' && ip) user.last_login_ip = ip.slice(0, 64);
  saveUsers();
  return user;
}

function updateBalance(id, balance) {
  const user = memoryUsers.get(id);
  if (!user) return null;
  user.balance = balance;
  saveUsers();
  return user;
}

function addBalance(id, amount) {
  const user = memoryUsers.get(id);
  if (!user) return null;
  user.balance += amount;
  saveUsers();
  return user;
}

function subtractBalance(id, amount) {
  const user = memoryUsers.get(id);
  if (!user) return null;
  user.balance -= amount;
  saveUsers();
  return user;
}

// ============================================
// PERSISTENT CHAT MESSAGES (LOCAL MODE)
// ============================================

const memoryChatMessages = [];

function loadChatMessages() {
  try {
    if (fs.existsSync(CHAT_FILE)) {
      const raw = fs.readFileSync(CHAT_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach(m => memoryChatMessages.push(m));
      }
    }
  } catch (err) {
    console.error('Failed to load chat messages:', err.message);
  }
}

function saveChatMessages() {
  try {
    fs.mkdirSync(path.dirname(CHAT_FILE), { recursive: true });
    fs.writeFileSync(CHAT_FILE, JSON.stringify(memoryChatMessages, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save chat messages:', err.message);
  }
}

loadChatMessages();

function pushChatMessage(msg) {
  const userInfo = msg.userInfo || {};
  const entry = {
    id: newId(),
    user_id: msg.userId || userInfo.userId || 'anonymous',
    user_name: msg.userName || userInfo.userName || 'Player',
    avatar: msg.avatar || userInfo.avatar || '',
    message: msg.msgContent || msg.message || '',
    img: msg.img || (msg.msgType === 'gif' ? msg.msgContent || '' : ''),
    likes: 0,
    likes_ids: [],
    dislikes: 0,
    dislikes_ids: [],
    created_at: new Date().toISOString()
  };
  memoryChatMessages.unshift(entry);
  if (memoryChatMessages.length > 200) {
    memoryChatMessages.length = 200;
  }
  saveChatMessages();
  return entry;
}

function getChatMessages(limit = 100) {
  return memoryChatMessages.slice(0, limit);
}

function toggleChatReaction(chatID, userId, reaction) {
  const msg = memoryChatMessages.find(m => m.id === String(chatID));
  if (!msg) return null;

  const likeIndex = msg.likes_ids.indexOf(userId);
  const dislikeIndex = msg.dislikes_ids.indexOf(userId);

  const removeLike = () => {
    if (likeIndex > -1) {
      msg.likes_ids.splice(likeIndex, 1);
      msg.likes = Math.max(0, msg.likes - 1);
    }
  };
  const removeDislike = () => {
    if (dislikeIndex > -1) {
      msg.dislikes_ids.splice(dislikeIndex, 1);
      msg.dislikes = Math.max(0, msg.dislikes - 1);
    }
  };

  let result;
  if (reaction === 'like') {
    removeDislike();
    if (likeIndex > -1) {
      removeLike();
      result = { ...msg, action: 'removed' };
    } else {
      msg.likes_ids.push(userId);
      msg.likes += 1;
      result = { ...msg, action: reaction };
    }
  } else {
    removeLike();
    if (dislikeIndex > -1) {
      removeDislike();
      result = { ...msg, action: 'removed' };
    } else {
      msg.dislikes_ids.push(userId);
      msg.dislikes += 1;
      result = { ...msg, action: reaction };
    }
  }
  saveChatMessages();
  return result;
}

module.exports = {
  isMemoryMode,
  newId,
  allUsers,
  findUserByPhone,
  findUserByName,
  findUserById,
  createUser,
  updateUser,
  deleteUser,
  setBanned,
  touchLogin,
  saveUsers,
  updateBalance,
  addBalance,
  subtractBalance,
  pushChatMessage,
  getChatMessages,
  toggleChatReaction
};
