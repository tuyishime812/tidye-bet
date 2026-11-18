# MongoDB Atlas Setup Guide

## Step 1: Create Free MongoDB Atlas Account

1. Go to: **https://www.mongodb.com/cloud/atlas/register**
2. Sign up for free (no credit card required)
3. Choose the **FREE** tier (M0 Sandbox)

## Step 2: Create a Cluster

1. After login, click **"Build a Database"**
2. Choose **FREE** tier (M0 Sandbox)
3. Select a cloud provider and region (choose closest to you)
4. Click **"Create Cluster"**
5. Wait 3-5 minutes for cluster to be ready

## Step 3: Create Database User

1. Click **"Database Access"** in left sidebar
2. Click **"+ ADD NEW DATABASE USER"**
3. Choose **Password** authentication
4. Enter username: `crashgame`
5. Click **"Autogenerate Secure Password"** and **COPY IT**
6. Set Database User Privileges: **"Atlas admin"** or **"Read and write to any database"**
7. Click **"Add User"**

## Step 4: Whitelist Your IP

1. Click **"Network Access"** in left sidebar
2. Click **"+ ADD IP ADDRESS"**
3. Click **"ALLOW ACCESS FROM ANYWHERE"** (for development)
   - IP Address: `0.0.0.0/0` (allows all IPs)
4. Click **"Confirm"**

## Step 5: Get Connection String

1. Click **"Database"** in left sidebar
2. Click **"Connect"** button on your cluster
3. Choose **"Connect your application"**
4. Copy the connection string, it looks like:
   ```
   mongodb+srv://crashgame:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
5. **Replace `<password>`** with the password you copied in Step 3

## Step 6: Update Your `.env` File

Edit `server/.env` file:

```env
PORT=5001
MONGODB_URI=mongodb+srv://crashgame:YOUR_PASSWORD_HERE@cluster0.xxxxx.mongodb.net/crash-game?retryWrites=true&w=majority
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
NODE_ENV=development
```

**Important:** Replace:
- `YOUR_PASSWORD_HERE` with your actual password
- `cluster0.xxxxx` with your actual cluster URL

## Step 7: Restart Backend Server

1. Stop the current backend (if running)
2. Start backend again:
   ```bash
   cd server
   npm start
   ```

You should see: `MongoDB connected`

## Troubleshooting

### "MongoDB connection error"
- Check your password is correct
- Make sure IP is whitelisted (0.0.0.0/0)
- Wait a few minutes for cluster to be ready

### "Authentication failed"
- Verify username and password
- Make sure user has read/write privileges

### "Network timeout"
- Check your internet connection
- Verify cluster is running (green status in Atlas dashboard)
