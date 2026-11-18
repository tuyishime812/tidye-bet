# Phone Number Authentication Setup

## Step 1: Add Phone Number Column to Supabase

1. Go to your Supabase dashboard: https://supabase.com/dashboard
2. Select your project
3. Go to **SQL Editor**
4. Copy and paste the contents of `ADD_PHONE_NUMBER.sql`:

```sql
-- Add phone_number column to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;

-- Create unique index on phone_number
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number);
```

5. Click **Run**

## Step 2: Restart Backend Server

```bash
cd server
npm run dev
```

## Step 3: How to Use

### Registration:
1. Enter **Phone Number** (10-15 digits, e.g., `991234567`)
2. Enter **Username** (letters and numbers only, e.g., `player123`)
3. Enter **Password** (min 6 characters)
4. Confirm Password
5. Click "Create Account"

### Login:
1. Enter **Phone Number** (same as registered)
2. Enter **Password**
3. Click "Login"

### Deposit/Withdraw:
- Use your **Phone Number** for all transactions
- The system identifies you by your phone number

## API Endpoints

### Register
```
POST /api/auth/register
Body: {
  "phoneNumber": "991234567",
  "userName": "player123",
  "password": "password123"
}
```

### Login
```
POST /api/auth/login
Body: {
  "phoneNumber": "991234567",
  "password": "password123"
}
```

### Deposit
```
POST /api/auth/deposit
Body: {
  "phoneNumber": "991234567",
  "amount": 1000
}
```

### Withdraw
```
POST /api/auth/withdraw
Body: {
  "phoneNumber": "991234567",
  "amount": 500
}
```

## Important Notes

- Phone number must be 10-15 digits (numbers only)
- Phone number is unique - can only register once
- Use the same phone number for login, deposit, and withdrawal
- Username is only for display purposes
- Password must be at least 6 characters
