# Aviator Crash Game - Full Stack

A complete real-time crash betting game built with React, Node.js, Express, Socket.io, and MongoDB.

## Project Structure

```
Aviator-Crash-main/
├── src/                    # Frontend React code
├── server/                 # Backend Node.js server
├── public/                 # Static assets
└── package.json           # Frontend dependencies
```

## Quick Start

### 1. Install MongoDB

Download and install MongoDB:
- Local: https://www.mongodb.com/try/download/community
- Cloud (recommended): https://www.mongodb.com/cloud/atlas

### 2. Setup Backend

```bash
cd server
npm install
```

Edit `server/.env`:
```
PORT=5001
MONGODB_URI=mongodb://localhost:27017/crash-game
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
NODE_ENV=development
```

Start the backend:
```bash
cd server
npm run dev
```

### 3. Setup Frontend

```bash
npm install --legacy-peer-deps
npm start
```

The app will open at `http://localhost:3000`

## Features

### Authentication
- User registration and login
- Quick play (random user)
- JWT-based authentication
- Persistent sessions

### Game Mechanics
- Real-time crash game
- Automatic betting
- Auto cashout
- Provably fair system
- Game history

### Betting System
- Single and double bets
- Bet limits configuration
- Real-time balance updates
- Bet history tracking

### Chat System
- Real-time chat
- Emoji support
- GIF support
- Like/dislike messages

### User Interface
- Responsive design
- Dark theme
- Live multiplier display
- Bet history panel
- Top bets leaderboard

## API Documentation

See [server/README.md](server/README.md) for complete API documentation.

## Configuration

### Frontend Config (`src/config.ts`)

```typescript
{
  development: true,
  development_api: 'http://localhost:5001/api',
  development_wss: 'http://localhost:5001',
  production_api: 'https://your-domain.com/api',
  production_wss: 'https://your-domain.com'
}
```

### Backend Config (`server/.env`)

```
PORT=5001
MONGODB_URI=mongodb://localhost:27017/crash-game
JWT_SECRET=your-secret-key
NODE_ENV=development
```

## Game Rules

1. **Place Your Bet**: Choose your bet amount before the round starts
2. **Watch the Multiplier**: The multiplier starts at 1.00x and increases
3. **Cash Out**: Click "Cash Out" before the plane crashes
4. **Win**: Your bet × current multiplier = your winnings
5. **Lose**: If you don't cash out before crash, you lose your bet

## Provably Fair

The game uses cryptographic provably fair technology:
- Server seed (generated each round)
- Server seed hash (published before round)
- Client seeds (from first 3 players)
- SHA512 hash determines crash point

Anyone can verify the fairness of each round by checking the seeds and hash.

## Technology Stack

### Frontend
- React 18
- TypeScript
- Socket.io Client
- React Unity WebGL
- Tailwind CSS
- SCSS

### Backend
- Node.js
- Express
- Socket.io
- MongoDB
- Mongoose
- JWT
- bcryptjs

## Development

### Frontend Scripts

```bash
npm start          # Start development server
npm run build      # Build for production
npm test           # Run tests
npm run eject      # Eject from Create React App
```

### Backend Scripts

```bash
npm start          # Start production server
npm run dev        # Start development server (auto-reload)
```

## Deployment

### Frontend (Vercel)

1. Build the frontend: `npm run build`
2. Deploy the `build` folder to Vercel
3. Update API URLs in config

### Backend (Heroku/Railway/DigitalOcean)

1. Set environment variables
2. Deploy the `server` folder
3. Connect to MongoDB Atlas

## Security Considerations

- Change JWT_SECRET in production
- Use HTTPS in production
- Enable MongoDB authentication
- Implement rate limiting
- Add CORS restrictions
- Validate all inputs
- Sanitize user data

## License

MIT

## Support

For issues or questions, please open an issue on GitHub.
