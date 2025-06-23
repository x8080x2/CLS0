# Telegram Domain Provisioning Bot

A professional Telegram bot for automated domain provisioning with cPanel integration. This bot allows users to create hosting accounts and deploy redirect scripts through a simple Telegram interface.

## Features

- **Domain Provisioning**: Automated cPanel account creation via WHM API
- **Payment System**: User balance management with admin approval
- **Admin Controls**: Admin access for free provisioning and user management
- **Rate Limiting**: 3 requests per minute per user for security
- **Script Generation**: Automatic redirect script deployment
- **Comprehensive Logging**: Detailed request tracking and monitoring

## Bot Commands

- `/start` - Initialize bot and show main menu
- `/help` - Display available commands
- `/cancel` - Cancel current operation

## Main Features

### 💳 Top Up
- Request account balance top-up
- Support for Bitcoin, Tether TRC20, and Ethereum
- Admin approval system for payments

### 🔗 Get Redirect
- Domain provisioning service ($80 per domain)
- Creates cPanel hosting account
- Deploys 3 redirect script folders
- Returns URLs and server credentials

### 👤 Profile
- View user balance and statistics
- Member since date
- Total domains provisioned

### 📋 History
- View last 10 provisioned domains
- Domain creation dates and redirect URLs
- Complete provisioning history

### 🔑 Admin Access
- Request admin approval for free domain provisioning
- Instant access for admin users
- One-time free access after approval

## Environment Variables

Required environment variables:

```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
WHM_SERVER=https://your-whm-server.com:2087
WHM_USERNAME=your_whm_username
WHM_PASSWORD=your_whm_password
WHM_PACKAGE_NAME=default_package
ADMIN_ID=your_telegram_user_id
```

Optional:
```
NODE_ENV=production
LOG_LEVEL=info
WEBHOOK_DOMAIN=https://your-domain.com
```

## Security Features

- Rate limiting (3 requests/minute)
- Input validation for domains and URLs
- Secure password generation
- Request ID tracking for audit trails
- Admin-only access controls

## API Endpoints

- `GET /health` - Health check endpoint
- `GET /api/stats` - Bot statistics
- `POST /api/provision` - Direct domain provisioning
- `POST /api/upload-script` - Custom script upload

## Installation

1. Clone the repository
2. Install dependencies: `npm install`
3. Configure environment variables
4. Start the bot: `npm start`

## Development

Run in development mode: `npm run dev`

The bot includes pretty logging and auto-restart in development mode.

## Architecture

- **Express Server**: Web dashboard and API endpoints
- **Telegram Bot**: User interface and command handling
- **WHM Integration**: cPanel account creation and management
- **In-Memory Storage**: User sessions and data (consider database for production)

## Admin Features

Admins can:
- Approve/deny top-up requests
- Grant free domain provisioning access
- Access unlimited free domain provisioning
- Monitor bot statistics and health

## Support

For support and configuration assistance, contact the administrator.