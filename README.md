# Ethbingo Bot — Setup Guide

## Step 1: Get Firebase Service Account Key

1. Go to Firebase Console → Project Settings → Service Accounts
2. Click "Generate new private key"
3. Download the JSON file
4. Copy the entire contents — you'll need it in Step 3

## Step 2: Deploy to Railway

1. Go to railway.app and sign up free
2. Click "New Project" → "Deploy from GitHub repo"
   OR click "New Project" → "Empty Project" → drag this entire folder
3. Railway will auto-detect Node.js and deploy

## Step 3: Set Environment Variables in Railway

In your Railway project, go to Variables tab and add:

```
BOT_TOKEN=8887151299:AAFmyP4BSaMnUA-3k0Tp6WNSZ9qLrwCMXLM
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"bingo-4c196",...}  ← paste full JSON
MINI_APP_URL=https://YOUR-APP.railway.app   ← Railway gives you this URL after deploy
```

## Step 4: Set Mini App URL in BotFather

1. Go to @BotFather on Telegram
2. Send /mybots → select Ethbingo_bot
3. Bot Settings → Menu Button → Edit Menu Button URL
4. Paste your Railway URL

## Step 5: Set Webhook (tell Telegram where your bot is)

Open this URL in your browser (replace YOUR_RAILWAY_URL):
```
https://api.telegram.org/bot8887151299:AAFmyP4BSaMnUA-3k0Tp6WNSZ9qLrwCMXLM/setWebhook?url=YOUR_RAILWAY_URL/webhook
```

## Step 6: Test

Open Telegram → search @Ethbingo_bot → send /start
You should get $100 demo credits and a Play button!

## Going Live with Real Telegram Stars (later)

When ready, just update the entry fee logic in server.js to use
Telegram's Stars payment API instead of demo credits.
