# Quick Start Guide

## Option 1: Run with MongoDB (Full Features)

### 1. Install MongoDB
- Download: https://www.mongodb.com/try/download/community
- Or use MongoDB Atlas (cloud): https://www.mongodb.com/cloud/atlas

### 2. Start MongoDB
```bash
# Windows (if installed as service)
net start MongoDB

# Or run mongod manually
mongod --dbpath C:\data\db
```

### 3. Start Backend
```bash
cd server
npm start
```

### 4. Start Frontend
```bash
npm start
```

## Option 2: Run Without MongoDB (Demo Mode)

I'll create a simplified version that works without MongoDB for testing:

**Note:** The current version requires MongoDB. If you don't have MongoDB:

1. **Use MongoDB Atlas (Free Cloud)**:
   - Go to: https://www.mongodb.com/cloud/atlas
   - Create free account
   - Create cluster
   - Get connection string
   - Update `server/.env`:
     ```
     MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/crash-game
     ```

2. **Or Install MongoDB Locally**:
   - Download: https://www.mongodb.com/try/download/community
   - Install with default settings
   - It will run automatically as a Windows service

## Current Status

✅ Frontend: Built successfully
✅ Backend: Configured and ready
⏳ MongoDB: Required for full functionality

## Testing Without Real Money

The game includes a "Quick Play" feature that:
- Creates a random user automatically
- Gives you $1000 free balance
- No registration required

Just click "Quick Play" on the login screen!
