# Render Deployment Guide

## Fixed Issues ✅
1. **409 Conflict Error** - Bot now uses webhooks in production (no more polling conflicts)
2. **Data Loss on Rebuild** - All data now stored in Neon PostgreSQL (persists across deployments)
3. **Message Edit Errors** - Global error handler catches and handles Telegram API errors gracefully

## Prerequisites
- Render account
- Neon PostgreSQL database (you already have this!)
- Telegram Bot Token

## Environment Variables

Set these in Render's Environment Variables section:

### Required Variables
```
DATABASE_URL=postgresql://neondb_owner:npg_gkbAPU7aWF3Y@ep-raspy-brook-a150lned-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
TELEGRAM_BOT_TOKEN=<your_telegram_bot_token>
NODE_ENV=production
```

### Optional Variables (if not set, defaults will be used)
```
WHM_SERVER=https://cp2.tor1.ultacp.com:2087
WHM_USERNAME=<your_whm_username>
WHM_API_TOKEN=<your_whm_api_token>
ADMIN_CHAT_ID=<your_telegram_admin_id>
LOG_LEVEL=info
```

## Deployment Steps

### 1. Push Your Code to Git
```bash
git add .
git commit -m "Migrate to PostgreSQL and add webhook support"
git push origin main
```

### 2. Connect to Render
1. Go to your Render dashboard
2. Find your service (cls0)
3. Go to **Settings** tab

### 3. Set Environment Variables
1. Scroll to **Environment Variables**
2. Add all the variables listed above
3. **Important:** Make sure `DATABASE_URL` is set to your Neon connection string
4. **Important:** Make sure `NODE_ENV` is set to `production`

### 4. Deploy
Render will automatically detect the webhook is needed when:
- `NODE_ENV=production` OR
- `RENDER` environment variable exists (auto-set by Render)

The bot will:
- Use the `RENDER_EXTERNAL_HOSTNAME` to build the webhook URL
- Set webhook automatically on startup
- Handle all updates via webhook (no polling conflicts!)

### 5. Verify Deployment
After deployment, check the logs for:
```
✅ Database connected successfully
Server started
Bot started with webhook: https://cls0.onrender.com/webhook/...
```

## How It Works

### Webhook Flow
1. Render starts your service
2. Bot detects production environment
3. Bot sets webhook URL: `https://cls0.onrender.com/webhook/{BOT_TOKEN}`
4. Telegram sends updates to this URL
5. Express endpoint receives and processes updates

### Database Flow
1. All user data, history, clicks, and topups stored in Neon PostgreSQL
2. Data persists across all deployments
3. No more file system storage
4. Fast, scalable, and reliable

## Testing

### Test the Bot
1. Send `/start` to your bot on Telegram
2. Create a redirect
3. Rebuild your Render service
4. Check that all data is still there

### Check Logs
In Render dashboard:
1. Go to **Logs** tab
2. Look for any errors
3. Confirm webhook is set successfully

## Troubleshooting

### Bot Not Responding
- Check `TELEGRAM_BOT_TOKEN` is set correctly
- Verify webhook URL in logs
- Check Render external hostname is correct

### 409 Conflict Error
- Ensure no other instances are running
- Delete webhook manually: `https://api.telegram.org/bot<TOKEN>/deleteWebhook`
- Restart Render service

### Data Not Persisting
- Verify `DATABASE_URL` is correct
- Check Neon database connection in logs
- Ensure table schema was created (check `db.js`)

### Database Connection Error
- Verify Neon connection string has `?sslmode=require`
- Check Neon database is active
- Verify IP allowlist in Neon (should allow all)

## Migration from File Storage (One-Time)

Your existing file data in `user_data/`, `history_data/`, etc. can be migrated:

1. Create a migration script to import JSON files into PostgreSQL
2. Run it once after first deployment
3. Verify data in database
4. Delete old JSON files (they're backed up in git)

## Database Schema

Tables created automatically on first run:
- `users` - User profiles and balances
- `history` - Domain provisioning history
- `clicks` - Click tracking data
- `topups` - Balance topup records

## Success Indicators

✅ Webhook set successfully in logs
✅ No 409 conflict errors
✅ Data persists after rebuild
✅ No "message not modified" crashes
✅ Bot responds instantly to commands

## Notes

- Webhooks are more reliable than polling for production
- Neon free tier: 0.5GB storage (plenty for this bot)
- Database connection pooled (max 20 connections)
- All async operations handled properly
- Error logging via Pino logger

## Need Help?

Check the following files:
- `db.js` - Database operations
- `bot.js` - Bot logic and webhook setup
- Render logs - Deployment and runtime logs
