# Tidye Bet ✈️

**Tidye Bet** is an Aviator crash game where players test their timing to cash out before the plane flies away. It includes real-time gameplay, account/wallet flows, and an operator admin console.



## 🌟 Features

### 🎮 Game Mechanics

- **Place Bets**: Choose your bet amount and join the game.
- **Real-Time Multiplier**: Watch the multiplier increase as the plane takes off.
- **Cash Out**: Withdraw your winnings before the plane crashes.
- **Unpredictable Crashes**: Adds excitement and keeps players on edge.

### 📈 Core Highlights

- **Real-Time Updates**: Powered by WebSocket for seamless gameplay.
- **Provably Fair System**: Transparent and verifiable fairness for every round.
- **User-Friendly UI**: Designed with Tailwind CSS for a smooth, responsive experience.
- **Leaderboards**: Track top players and compare performances.

### 🔒 Security & Transparency

- Secure login and gameplay.
- Provably fair crash algorithm ensures trustworthiness.

## 🛠️ Tech Stack

### Frontend

- **React.js**: For building a dynamic and responsive UI.
- **TypeScript:** Ensures robust and scalable code.
- **Tailwind CSS**: Provides a sleek and modern design.
- **Socket.IO**: Enables real-time communication between players and the server.

### Backend

- **Node.js**: High-performance server-side logic.
- **TypeScript**: For type safety and maintainability.
- **Socket.IO**: Real-time communication.
- **MongoDB**: Efficient database for managing user data and game states.

## 📂 Project Structure

```
├── src/                    # React (TypeScript) frontend
│   ├── @types/
│   ├── assets/
│   ├── components/         # Lobby, Aviator, Wallet, Admin, Chat
│   ├── utils/
│   ├── context.tsx         # Shared game/socket/auth state
│   └── config.ts           # API/WSS base URL (REACT_APP_API_URL)
├── server/                 # Express + Socket.IO backend
│   ├── config/             # Supabase/memory stores, money helpers
│   ├── game/               # Aviator engine
│   ├── middleware/         # Auth, rate limiting
│   ├── routes/             # Auth, payments, game, admin
│   ├── services/           # Ledger, PayChangu, payouts, audit, schema check
│   └── test/               # Backend test suites
├── scripts/dev.js          # One-command dev launcher (API + web)
└── build/                  # Production build output (gitignored)
```

---

## ⚙️ Setup Instructions

### Prerequisites

- Node.js 18+ (verified on Node 24)
- npm

### One command

```bash
npm install --legacy-peer-deps
npm --prefix server install
npm start
```

`npm start` runs `scripts/dev.js`, which starts the API (default port 5001)
and the React app (first free port from 3000), then points the frontend at the
API. If port 3000 is taken by another project, the web app moves to 3001
automatically.

Run the halves separately:

```bash
npm run start:api    # API only
npm run start:web    # Web only (expects an API on localhost:5001)
```

### Backend configuration

Copy `server/.env.example` to `server/.env` and set at minimum a strong
`JWT_SECRET` and a non-default `ADMIN_PASSWORD`.

Without Supabase (`USE_SUPABASE=true` plus `SUPABASE_URL`/`SUPABASE_KEY`) the
server runs in **local memory mode**: accounts, balances and bets are lost on
restart. That is fine for development, not for production.

### Checks

```bash
npx tsc --noEmit          # frontend types
npm run build             # production build
npm --prefix server test  # backend suite
```

## 🎉 How to Play

- Sign up or log in to your account.
- Place your bet and wait for the round to begin.
- Watch the multiplier increase and decide when to cash out.
- Win big if you cash out before the crash!

## 📜 Provably Fair

Each game round is provably fair, ensuring that the outcome is random and cannot be tampered with.
