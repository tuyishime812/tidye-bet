# 🚀 DEPLOYMENT GUIDE - Render + Vercel

## ✅ Files Created For You:

```
server/render.yaml          - Render backend configuration
server/.env.example         - Environment variables template
vercel.json                 - Vercel frontend configuration
.env.production             - Frontend production env
src/config.prod.ts          - Production config template
```

---

## 📋 PART 1: Deploy Backend to Render

### Step 1: Go to Render
- Open: https://render.com
- Click **"Get Started for Free"**
- Sign up with **GitHub**

### Step 2: Create Web Service
1. Click **"New +"** → **"Web Service"**
2. Connect your **Aviator-Crash** repository
3. Configure:

| Setting | Value |
|---------|-------|
| Name | `aviator-crash-backend` |
| Region | `Oregon (US West)` |
| Branch | `main` |
| Root Directory | `server` |
| Runtime | `Node` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | `Free` |

### Step 3: Add Environment Variables

Click **Advanced** → **Add Environment Variable**:

```
SUPABASE_URL = https://<your-project-ref>.supabase.co
SUPABASE_KEY = <your anon key>
SUPABASE_SERVICE_ROLE_KEY = <your service_role key>
JWT_SECRET = <generate a fresh 48-byte value, see below>
FRONTEND_URL = https://your-frontend.example.mw
NODE_ENV = production
PORT = 5001

# Hosted checkout (the only deposit gateway). Deposits redirect to PayChangu
# (MPamba / Airtel Money / card) and are credited after verify-payment confirms
# the reference. Deposits fail closed (503) when this is not configured.
PAYCHANGU_SECRET_KEY = sec-...
PAYCHANGU_PUBLIC_KEY = pub-...
```

> Deposits redirect to PayChangu and are credited only after
> `verify-payment/{tx_ref}` confirms the reference, currency and amount. No
> webhook endpoint or signing secret is used.


> 🔐 **Never commit real values.** `JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`
> and `PAYCHANGU_SECRET_KEY` are secrets. Generate the JWT secret with:
> ```
> node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
> ```
> The server refuses to boot on a missing, short, placeholder or low-entropy
> secret — there is no default fallback.

### Step 4: Deploy!
- Click **"Create Web Service"**
- Wait 2-3 minutes for deployment
- Copy your URL: `https://aviator-crash-backend-xyz.onrender.com`

### Step 5: Test Backend
Open in browser:
```
https://YOUR-BACKEND-URL.onrender.com/api/health
```

Should show: `{"status":"ok",...}`

---

## 📋 PART 2: Deploy Frontend to Vercel

### Step 1: Update Config

In `src/config.ts`, replace `YOUR-BACKEND-URL` with your Render URL:

```typescript
api: 'https://aviator-crash-backend-xyz.onrender.com/api',
wss: 'wss://aviator-crash-backend-xyz.onrender.com',
```

### Step 2: Go to Vercel
- Open: https://vercel.com
- Sign up with **GitHub**

### Step 3: Import Project
1. Click **"Add New Project"**
2. Select **Aviator-Crash** repository
3. Configure:

| Setting | Value |
|---------|-------|
| Framework Preset | `Create React App` |
| Root Directory | `./` |
| Build Command | `npm run build` |
| Output Directory | `build` |

### Step 4: Add Environment Variable

Click **Environment Variables** → **Add**:

```
REACT_APP_API_URL = https://YOUR-BACKEND-URL.onrender.com
```

### Step 5: Deploy!
- Click **"Deploy"**
- Wait 2-3 minutes
- Copy your URL: `https://aviator-crash.vercel.app`

---

## 📋 PART 3: Update Backend CORS

After frontend is deployed, update backend to allow the new domain:

### In Render Dashboard:
1. Go to your backend service
2. Click **Environment** tab
3. Update `FRONTEND_URL`:
   ```
   FRONTEND_URL = https://aviator-crash.vercel.app
   ```
4. Click **"Save Changes"** (auto-redeploys)

### In `server/index.js` (if needed):
```javascript
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://aviator-crash.vercel.app',
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
```

---

## 📋 PART 4: Test Production

### 1. Open Your Frontend
```
https://aviator-crash.vercel.app
```

### 2. Register
```
Phone: 991234567
Username: testuser
Password: password123
```

### 3. Login
```
Phone: 991234567
Password: password123
```

### 4. Apply the database schema

The server refuses to start in production without the authoritative schema
(money tables + `apply_movement`), so apply it first:

```bash
cd server
npm run db:apply      # needs SUPABASE_DB_URL, see server/scripts/apply-schema.js
```

### 5. Test a credit (admin-only)

Balances can only be changed by an authenticated admin or a verified gateway
callback — there is no unauthenticated deposit endpoint anymore:

```bash
# 1. Log in as the admin
TOKEN=$(curl -s -X POST https://YOUR-BACKEND-URL.onrender.com/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<ADMIN_USERNAME>","password":"<ADMIN_PASSWORD>"}' | jq -r .token)

# 2. Credit a player (audited; amount and reason are required)
curl -X POST https://YOUR-BACKEND-URL.onrender.com/api/payments/admin/credits \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"<player-uuid>","amount":1000,"reason":"launch test credit"}'
```

### 6. Play the game
- Place bet → Should be instant
- Cash out → Money added immediately
- See other players → Open multiple tabs!

---

## 🔧 Troubleshooting

### Backend Issues:

**Build Fails:**
- Check `server/package.json` has `"start": "node index.js"`
- Make sure `rootDir` is `server`

**Port Error:**
- Render sets PORT automatically
- Check `server/index.js` uses `process.env.PORT`

**CORS Error:**
- Set `FRONTEND_URL` (and `ADMIN_SITE_URL` if you have a separate admin site) to the exact production origins
- Do **not** open CORS to all origins — the server uses a strict allow-list on purpose. In development it also accepts localhost / private-network origins automatically.

### Frontend Issues:

**Build Fails:**
- Check `vercel.json` exists
- Make sure `package.json` has build script

**API Not Connecting:**
- Update `src/config.ts` with correct backend URL
- Use `wss://` for WebSocket (not `ws://`)

**WebSocket Not Connecting:**
- Use secure WebSocket: `wss://`
- Check backend URL is correct

---

## 📊 Your Production URLs

After deployment, you'll have:

```
Backend (Render):  https://aviator-crash-backend-xyz.onrender.com
Frontend (Vercel): https://aviator-crash.vercel.app
Database:          https://znbpgyrapaqaavqykysq.supabase.co
```

---

## ✅ Deployment Checklist

- [ ] Backend deployed to Render
- [ ] Backend health endpoint works
- [ ] Registration works on backend
- [ ] Frontend deployed to Vercel
- [ ] Frontend loads without errors
- [ ] Can register on frontend
- [ ] Can login on frontend
- [ ] Can place bets
- [ ] Can cash out
- [ ] WebSocket connects
- [ ] Multiplayer works
- [ ] Backend CORS updated

---

## 🎉 You're Live!

Your Aviator game is now deployed and accessible worldwide! 🌍

**Share your URL:** `https://aviator-crash.vercel.app`

---

## 📝 Quick Reference

### Render Dashboard:
https://dashboard.render.com

### Vercel Dashboard:
https://vercel.com/dashboard

### Supabase Dashboard:
https://supabase.com/dashboard

### View Logs:
- Render: Dashboard → Your Service → Logs
- Vercel: Dashboard → Your Project → Deployments → View Logs

---

**Need Help?** Check the logs in Render/Vercel dashboards for errors!
