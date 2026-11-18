# Aviator Crash Game - Setup and Running Instructions

## ✅ All Errors Fixed

All TypeScript errors, linting warnings, and incomplete code have been fixed. The project now builds successfully.

## Quick Start

### Prerequisites
- Node.js (v18+ recommended; verified on Node 24)
- npm
- Optional: Supabase (the server runs in local memory mode without it)

### One command (recommended)

```bash
# From the project root
npm install --legacy-peer-deps
npm --prefix server install

npm start
```

`npm start` runs `scripts/dev.js`, which:

1. Reuses an API already answering on `http://localhost:5001/api/health`, or
   starts `server/index.js` if the port is free.
2. Finds a **free web port** starting at `PORT` (default `3000`) and starts the
   React app there, with `REACT_APP_API_URL` pointed at the API.

So if another project is using port 3000, the app comes up on 3001 (3002, …)
without the CRA "run on another port?" prompt — that prompt crashes on current
Node versions (see Troubleshooting).

Expected output:

```
[dev] Reusing API already running on port 5001
[dev] Port 3000 is busy (likely another project) - starting the web app on 3001 instead.
[dev] Starting web app on http://localhost:3001 (API: http://localhost:5001)
```

### Running the halves separately

```bash
npm run start:api     # API only, http://localhost:5001
npm run start:web     # React only (uses localhost:5001 as the API)
```

### Environment configuration (server/.env)

```bash
cd server
cp .env.example .env
```

At minimum set a strong `JWT_SECRET` and change the bootstrap
`ADMIN_PASSWORD`. Without Supabase the server runs in local memory mode and
**balances and bets are lost on restart** — fine for development only.

## Environment Configuration

### Backend (.env file)

Create/edit `server/.env` with your credentials:

```env
# Server Configuration
PORT=5001
NODE_ENV=development

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-supabase-anon-key

# JWT Configuration
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production

# Frontend URL (for CORS)
FRONTEND_URL=http://localhost:3000
```

### Database Setup (Supabase)

You need to create the following tables in your Supabase project:

#### 1. Users Table
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_name TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  email TEXT,
  balance DECIMAL DEFAULT 1000,
  avatar TEXT,
  user_type BOOLEAN DEFAULT false,
  currency TEXT DEFAULT 'INR',
  is_sound_enable BOOLEAN DEFAULT true,
  is_music_enable BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### 2. Bets Table
```sql
CREATE TABLE bets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id),
  user_name TEXT,
  bet_amount DECIMAL NOT NULL,
  cash_out_at DECIMAL,
  cashouted BOOLEAN DEFAULT false,
  fly_away DECIMAL,
  fly_detail_id TEXT,
  profit DECIMAL,
  game_round INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### 3. Game Rounds Table
```sql
CREATE TABLE game_rounds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_number INTEGER NOT NULL,
  crash_point DECIMAL NOT NULL,
  server_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seeds JSONB DEFAULT '[]',
  fly_detail_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

#### 4. Chat Messages Table
```sql
CREATE TABLE chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT,
  user_name TEXT NOT NULL,
  avatar TEXT,
  message TEXT NOT NULL,
  img TEXT DEFAULT '',
  likes INTEGER DEFAULT 0,
  likes_ids JSONB DEFAULT '[]',
  dislikes INTEGER DEFAULT 0,
  dislikes_ids JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Project Structure

```
Aviator-Crash-main/
├── src/                          # Frontend React code
│   ├── components/               # React components
│   │   ├── Auth/                 # Authentication modal
│   │   ├── bet-users/            # Bets display components
│   │   ├── Chat/                 # Chat component
│   │   ├── Crash/                # Game canvas component
│   │   ├── Header/               # Header component
│   │   ├── Main/                 # Main game components
│   │   └── Toast/                # Toast notifications
│   ├── assets/                   # Images, audio, etc.
│   ├── utils/                    # Utility functions
│   ├── @types/                   # TypeScript type definitions
│   ├── app.tsx                   # Main App component
│   ├── context.tsx               # Global state management
│   ├── config.ts                 # Configuration
│   ├── config.json               # JSON config
│   └── index.tsx                 # Entry point
├── server/                       # Backend Node.js server
│   ├── game/                     # Game logic
│   ├── models/                   # Database models
│   ├── routes/                   # API routes
│   ├── index.js                  # Server entry point
│   └── .env                      # Environment variables
├── public/                       # Static assets
└── package.json                  # Frontend dependencies
```

## Features

### Game Features
- ✅ Real-time multiplayer gameplay
- ✅ Place single or double bets
- ✅ Auto cashout functionality
- ✅ Manual cashout
- ✅ Live multiplier display
- ✅ Game history
- ✅ Top bets leaderboard

### User Features
- ✅ User registration and login
- ✅ Quick play (random user)
- ✅ JWT authentication
- ✅ Persistent sessions
- ✅ Balance management
- ✅ Bet history

### Social Features
- ✅ Real-time chat
- ✅ Emoji support
- ✅ GIF support
- ✅ Like/dislike messages

### Security Features
- ✅ Provably fair system
- ✅ Secure authentication
- ✅ Input validation
- ✅ CORS protection

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/quick-play` - Quick play with random user
- `POST /api/auth/user-info` - Get user info
- `POST /api/auth/update-balance` - Update user balance

### Game
- `GET /api/game/bet-limits` - Get bet limits
- `GET /api/game/history` - Get game history
- `POST /api/game/my-info` - Get user's bet history
- `POST /api/game/round-details` - Get round details (provably fair)
- `GET /api/game/top-bets` - Get top bets

### Chat
- `GET /api/chat/all` - Get all chat messages
- `POST /api/chat/send` - Send chat message
- `POST /api/chat/like` - Like a message
- `POST /api/chat/dislike` - Dislike a message

### WebSocket Events
- `connect` - Client connects
- `disconnect` - Client disconnects
- `authenticate` - Authenticate with JWT token
- `enterRoom` - Join game room
- `playBet` - Place a bet
- `cashOut` - Cash out bet
- `sendMsg` - Send chat message
- `gameState` - Current game state
- `bettedUserInfo` - List of betted users
- `history` - Game history
- `previousHand` - Previous round results
- `finishGame` - Round finished
- `msgReceived` - New chat message

## Development Scripts

### Frontend
```bash
npm start          # Start development server
npm run build      # Build for production
npm test           # Run tests
npm run eject      # Eject from Create React App (not recommended)
```

### Backend
```bash
npm start          # Start production server
npm run dev        # Start development server (auto-reload)
```

## Testing

### Manual Testing Checklist
- [ ] User registration
- [ ] User login
- [ ] Quick play
- [ ] Place single bet
- [ ] Place double bet
- [ ] Manual cashout
- [ ] Auto cashout
- [ ] Auto play with stop conditions
- [ ] View game history
- [ ] View top bets
- [ ] Send chat message
- [ ] Send emoji
- [ ] Send GIF
- [ ] Like chat message
- [ ] Balance updates correctly
- [ ] Provably fair verification

## Troubleshooting

### Frontend Issues

**Port already in use / `TypeError: Cannot read properties of undefined (reading 'toLowerCase')`:**

This is Create React App's interactive "run on another port?" prompt. On
Node 22+ the `prompts@2.4.2` confirm element crashes when Enter is pressed
(`ConfirmPrompt#_` calls `c.toLowerCase()` with `c === undefined`).

`npm start` now avoids that path entirely: `scripts/dev.js` picks a free port
before CRA boots. If you start CRA directly (`npm run start:web`), either free
the port first or set one explicitly:

```powershell
# Find and stop the process holding port 3000 (Windows)
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Or choose a port explicitly
$env:PORT=4002; npm run start:web
```

**Dependencies installation fails:**
```bash
# Use legacy peer deps flag
npm install --legacy-peer-deps
```

### Backend Issues

**Supabase connection fails:**
- Check SUPABASE_URL and SUPABASE_KEY in .env
- Ensure database tables are created
- Check network connectivity

**Port already in use:**
```bash
# Change PORT in server/.env
PORT=5002
```

## Deployment

### Frontend (Vercel)
```bash
# Build for production
npm run build

# Deploy build folder to Vercel
```

The frontend reads its API base from `REACT_APP_API_URL`. Set it in the build
environment (Vercel → Project → Settings → Environment Variables), e.g.
`REACT_APP_API_URL=https://your-server.example.com`. Every login, register,
wallet and game call is built from it. When it is unset the app falls back to
`http://localhost:5001` for local development.

### Backend (Heroku/Railway/DigitalOcean)
```bash
# Set environment variables
# Deploy server folder
# Connect to Supabase or MongoDB Atlas
```

## Production Considerations

1. **Security**
   - Change JWT_SECRET to a strong random value
   - Use HTTPS in production
   - Enable rate limiting
   - Add input sanitization
   - Configure CORS properly

2. **Performance**
   - Enable Redis for session management
   - Use CDN for static assets
   - Optimize database queries
   - Add caching layer

3. **Monitoring**
   - Add logging (Winston, Morgan)
   - Set up error tracking (Sentry)
   - Monitor server health
   - Track game analytics

## Support

For issues or questions:
- Check FIXES_SUMMARY.md for details on what was fixed
- Review SETUP.md for additional setup information
- Check server/README.md for API documentation

## License

MIT

---

**Last Updated:** March 2026
**Version:** 1.0.0 (Fixed)
