# Supabase Setup Guide - 5 Minutes!

## Step 1: Create Supabase Account (1 min)

1. Go to **https://supabase.com**
2. Click **"Start your project"** or **"Sign In"**
3. Sign in with GitHub (recommended) or email

## Step 2: Create New Project (2 min)

1. Click **"New Project"**
2. Choose your organization (or create one)
3. **Project name**: `crash-game` (or any name)
4. **Database password**: Create a strong password - **SAVE IT!**
5. **Region**: Choose closest to you
6. **Pricing plan**: **Free** (perfect for this project)
7. Click **"Create new project"**
8. Wait 2-3 minutes for setup

## Step 3: Get API Keys (30 sec)

1. Click **"Settings"** (left sidebar, gear icon)
2. Click **"API"**
3. Copy these two values:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon/public key**: `eyJhbG...` (long string)

## Step 4: Update .env File (30 sec)

Edit `server/.env`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key-here
```

Replace with your actual values from Step 3!

## Step 5: Create Database Tables (2 min)

1. Click **"SQL Editor"** (left sidebar)
2. Click **"New query"**
3. Copy and paste this SQL:

```sql
-- Users table
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_name TEXT UNIQUE NOT NULL,
  email TEXT,
  password TEXT NOT NULL,
  balance DECIMAL DEFAULT 1000,
  avatar TEXT DEFAULT '',
  user_type BOOLEAN DEFAULT false,
  currency TEXT DEFAULT 'INR',
  is_sound_enable BOOLEAN DEFAULT true,
  is_music_enable BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Game rounds table
CREATE TABLE game_rounds (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  round_number INTEGER NOT NULL,
  crash_point DECIMAL NOT NULL,
  server_seed TEXT NOT NULL,
  server_seed_hash TEXT NOT NULL,
  client_seeds JSONB DEFAULT '[]',
  fly_detail_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Bets table
CREATE TABLE bets (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  user_name TEXT NOT NULL,
  bet_amount DECIMAL NOT NULL,
  cash_out_at DECIMAL DEFAULT 0,
  cashouted BOOLEAN DEFAULT false,
  fly_away DECIMAL NOT NULL,
  fly_detail_id TEXT,
  profit DECIMAL DEFAULT 0,
  game_round INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Chat messages table
CREATE TABLE chat_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id TEXT,
  user_name TEXT NOT NULL,
  avatar TEXT DEFAULT '',
  message TEXT NOT NULL,
  img TEXT DEFAULT '',
  likes INTEGER DEFAULT 0,
  likes_ids JSONB DEFAULT '[]',
  dislikes INTEGER DEFAULT 0,
  dislikes_ids JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX idx_users_user_name ON users(user_name);
CREATE INDEX idx_game_rounds_round ON game_rounds(round_number DESC);
CREATE INDEX idx_bets_user_id ON bets(user_id);
CREATE INDEX idx_bets_round ON bets(game_round);
CREATE INDEX idx_chat_created ON chat_messages(created_at DESC);
```

4. Click **"Run"** or press `Ctrl+Enter`
5. You should see "Success. No rows returned"

## Step 6: Restart Backend (30 sec)

Stop the backend server (if running) and restart:

```bash
cd server
npm start
```

You should see:
```
Server running on port 5001
Using Supabase: https://your-project.supabase.co
```

## ✅ Done! Your game is ready!

Open http://localhost:3000 and click **Quick Play** to test!

## Troubleshooting

### "Invalid API key"
- Make sure you copied the **anon/public** key (not service_role key)
- Check for extra spaces in .env file

### "Table does not exist"
- Run the SQL from Step 5 again
- Check if tables exist in "Table Editor"

### "Connection error"
- Check your SUPABASE_URL is correct (should end with .supabase.co)
- Make sure project is active (not paused)

## Supabase Dashboard

- **Table Editor**: View/edit your data
- **SQL Editor**: Run SQL queries
- **Authentication**: User management
- **Logs**: View API logs
- **Settings**: Project settings & API keys

Your free tier includes:
- ✅ 500 MB database
- ✅ 50,000 monthly active users
- ✅ Unlimited API requests
- ✅ Real-time subscriptions

Perfect for this project! 🚀
