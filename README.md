# Domain Provisioning Telegram Bot

A sophisticated Telegram bot designed for automated domain provisioning and hosting management through WHM API integration. The application provides streamlined server account creation, domain setup, and management capabilities directly via Telegram interface.

## Features

- **Instant Domain Setup**: Automatically creates cPanel accounts and hosting infrastructure
- **File Management**: Creates 3 organized folders with script files per domain
- **Secure Access**: Generates unique credentials for full account control
- **Real-time Updates**: Instant notifications throughout the provisioning process
- **Web Dashboard**: Modern interface for monitoring bot operations

## Tech Stack

- **Backend**: Node.js 20 with Express.js
- **Bot Framework**: Telegraf for Telegram interactions  
- **API Integration**: WHM/cPanel API with secure authentication
- **Logging**: Pino for structured logging
- **Frontend**: Responsive HTML dashboard

## Quick Start

1. Clone the repository
2. Install dependencies: `npm install`
3. Configure environment variables (see `.env.example`)
4. Start the bot: `node bot.js`

## Environment Variables

Create a `.env` file with the following variables:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
WHM_SERVER=https://your-whm-server.com:2087
WHM_USERNAME=your_whm_username
WHM_PASSWORD=your_whm_password
ADMIN_USER_ID=your_telegram_user_id
WEBHOOK_DOMAIN=your_webhook_domain (for production)
LOG_LEVEL=info
NODE_ENV=development
```

## Usage

1. Start a conversation with the bot on Telegram
2. Send `/start` command
3. Enter your domain name when prompted
4. Wait for automated setup completion
5. Receive cPanel credentials and script URLs
6. Update domain nameservers as instructed

## API Endpoints

- `GET /` - Redirects to dashboard
- `GET /dashboard` - Web dashboard interface
- `GET /health` - System health check
- `POST /api/provision` - Domain provisioning endpoint
- `POST /api/upload-script` - Custom script upload

## System Status

- **WHM Integration**: Connected to cp13.syd1.ultacp.com
- **Package**: pecuwoli_default (10GB quota, 1GB bandwidth)  
- **Server IP**: 212.81.47.13
- **Test Status**: Successfully provisioning domains

## Contributing

This is a private project. Contact the repository owner for access and contribution guidelines.

## License

Private - All rights reserved