# 🎮 AVIATOR CRASH GAME - QUICK START GUIDE

## Step 1: Setup Database (2 minutes)

1. **Go to Supabase**: https://supabase.com/dashboard
2. **Select your project**
3. **Go to SQL Editor** (left sidebar)
4. **Click "New Query"**
5. **Copy and paste** the entire content of `server/SCHEMA.sql`
6. **Click "Run"** (prints `Schema OK. Ledger rows: ...` on success)

> ⚠️ **Use `server/SCHEMA.sql` only.** The older `COMPLETE_DATABASE_SETUP.sql`
> created a permissive `"Allow all operations on users"` RLS policy (any browser
> with the anon key could read every password hash and balance) and has been
> removed. `SCHEMA.sql` is safe to re-run and repairs those policies.
>
> Then create `server/.env` from `server/.env.example` and set
> `USE_SUPABASE=true`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
> `JWT_SECRET` and `ADMIN_PASSWORD`. or press Ctrl+Enter
7. **Wait for "Success. No rows returned"**

✅ Database is ready!

## Step 2: Start the Game (1 minute)

### Backend:
```bash
cd server
npm run dev
```

You should see:
```
🚀 Server running on port 5001
📡 API: http://localhost:5001/api
🔌 Socket.IO: ws://localhost:5001
📊 Supabase: https://znbpgyrapaqaavqykysq.supabase.co
✅ Supabase connected successfully
```

### Frontend:
```bash
npm start
```

Wait for "Compiled successfully!"

## Step 3: Play the Game! 🎉

1. **Open**: http://localhost:3000
2. **Register**:
   - Phone: `991234567` (10 digits)
   - Username: `player1`
   - Password: `password123`
3. **Login** with same phone and password
4. **Deposit** (optional - use phone number)
5. **Place Bet** and **Cash Out**!

---

## 🎯 How It Works (Like BetPawa)

### Registration:
```
📱 Phone Number (991234567)
👤 Username (player1)
🔐 Password (password123)
```

### Login:
```
📱 Phone Number (991234567)
🔐 Password (password123)
```

### Deposit Money:
```
POST http://localhost:5001/api/auth/deposit
{
  "phoneNumber": "991234567",
  "amount": 1000
}
```

### Withdraw Money:
```
POST http://localhost:5001/api/auth/withdraw
{
  "phoneNumber": "991234567",
  "amount": 500
}
```

### Place Bet:
- Click "Bet" button
- Amount deducted instantly
- Bet shows in game

### Cash Out:
- Click "Cash Out" during flight
- Money added instantly
- Balance updates in real-time

---

## 🎮 Game Features (Like BetPawa)

✅ **Real-time multiplayer** - See other players' bets
✅ **Live chat** - Chat with other players
✅ **Instant cashout** - No delay, instant money
✅ **Instant bet** - Place bets immediately
✅ **Real balance** - No fake money, real MWK
✅ **Provably fair** - Verify each round
✅ **History** - See all past games
✅ **Top bets** - See biggest wins
✅ **Auto cashout** - Set automatic cashout
✅ **Mobile responsive** - Works on phone

---

## 🔧 Troubleshooting

### "Phone number already registered"
- Use a different phone number
- Or login with existing phone

### "User not found"
- Make sure you registered first
- Check phone number format (10 digits)

### "Insufficient balance"
- Deposit money first
- Use deposit endpoint with your phone number

### Game not loading
- Check backend is running on port 5001
- Check frontend is running on port 3000
- Clear browser cache and refresh

### Database errors
- Run the SQL setup again
- Check Supabase connection in .env file

---

## 📱 Test Accounts

You can create these for testing:

| Phone | Username | Password |
|-------|----------|----------|
| 991234567 | player1 | password123 |
| 992345678 | player2 | password123 |
| 993456789 | player3 | password123 |

---

## 🎲 Game Rules

1. **Place your bet** before the plane takes off
2. **Watch the multiplier** increase (1x, 2x, 3x...)
3. **Cash out** before the plane flies away
4. **Win** = Bet × Multiplier at cashout
5. **Lose** = Plane flies away before you cash out

**Example:**
- Bet: 100 MWK
- Cash out at: 2.5x
- Win: 100 × 2.5 = 250 MWK

---

## 🚀 API Endpoints

### Authentication
- `POST /api/auth/register` - Register with phone
- `POST /api/auth/login` - Login with phone
- `POST /api/auth/deposit` - Add money
- `POST /api/auth/withdraw` - Remove money

### Game
- `GET /api/game/top-bets` - Top bets
- `GET /api/game/round-details` - Round details
- `POST /api/game/my-info` - My bets history

### Chat
- `GET /api/chat/all` - Get all messages
- `POST /api/chat/like` - Like message
- `POST /api/chat/dislike` - Dislike message

---

## ✅ Success Checklist

- [ ] Database tables created (users, bets, game_rounds, etc.)
- [ ] Backend running on port 5001
- [ ] Frontend running on port 3000
- [ ] Can register with phone number
- [ ] Can login with phone number
- [ ] Can place bet
- [ ] Can cash out
- [ ] Balance updates correctly
- [ ] Chat works
- [ ] History shows

---

## 🎉 Enjoy the Game!

Your Aviator Crash Game is now ready!
Just like BetPawa but better! 🚀

**Support**: Check server logs for any errors
**Questions**: Review the code in server/routes/auth.js
