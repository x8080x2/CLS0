# Telegram Domain Provisioning Bot

## Overview

This is a Telegram bot application that provides automated domain provisioning services with cPanel integration. The bot allows users to purchase hosting accounts, manage their balance, and deploy redirect scripts through a simple Telegram interface. It includes features like payment management, admin controls, rate limiting, and comprehensive logging.

## System Architecture

The application follows a monolithic Node.js architecture with the following key components:

- **Telegram Bot Interface**: Built using the Telegraf framework for handling Telegram interactions
- **Express Web Server**: Provides a dashboard interface and webhook endpoints
- **WHM/cPanel Integration**: Automated hosting account creation via WHM API
- **Payment System**: User balance management with admin approval workflow
- **File-based Data Storage**: Uses local file system for data persistence (no database currently implemented)

## Key Components

### 1. Bot Interface (`bot.js`)
- **Purpose**: Main application entry point handling Telegram bot logic
- **Key Features**: 
  - User command processing (/start, /help, /cancel)
  - Payment request handling
  - Domain provisioning workflow
  - Admin access controls
  - Rate limiting (3 requests per minute per user)

### 2. Web Dashboard (`dashboard.html`)
- **Purpose**: Provides a web-based interface for monitoring bot activity
- **Features**: 
  - Modern responsive design with gradient styling
  - Bot statistics and overview
  - Real-time monitoring capabilities

### 3. Script Template (`script-template.html`)
- **Purpose**: Template for redirect scripts deployed to provisioned domains
- **Features**: 
  - Professional loading interface
  - Customizable title and redirect functionality
  - Modern UI with CSS animations

### 4. Configuration Management
- **Environment Variables**: Comprehensive configuration via `.env` file
- **Security**: Sensitive credentials isolated from codebase
- **Deployment**: Production-ready configuration options

## Data Flow

1. **User Interaction**: Users interact with the bot via Telegram commands
2. **Request Processing**: Bot processes requests with rate limiting and validation
3. **Payment Workflow**: Balance top-up requests require admin approval
4. **Domain Provisioning**: 
   - Creates cPanel hosting account via WHM API
   - Deploys redirect script folders
   - Returns credentials and URLs to user
5. **Logging**: All activities logged with structured logging using Pino

## External Dependencies

### Core Dependencies
- **telegraf**: Telegram bot framework for handling bot interactions
- **axios**: HTTP client for API communications with WHM/cPanel
- **express**: Web server for dashboard and webhook handling
- **pino/pino-pretty**: Structured logging with development formatting

### Integration Services
- **WHM/cPanel API**: For automated hosting account creation
- **Telegram Bot API**: For bot messaging and user interaction
- **Cryptocurrency Payment Systems**: Bitcoin, Tether TRC20, Ethereum support

### Built-in Node.js Modules
- **https**: Secure HTTP communications
- **crypto**: Cryptographic functionality
- **fs/path**: File system operations for template handling

## Deployment Strategy

### Development Environment
- **Replit Integration**: Configured for Replit development environment
- **Node.js 20**: Modern JavaScript runtime with latest features
- **Port Configuration**: Runs on port 5000 with external port 80 mapping
- **Auto-restart**: Configured to restart on file changes

### Production Considerations
- **Webhook Support**: Optional webhook domain configuration for production
- **Environment-based Configuration**: Development/production environment switching
- **Log Level Control**: Configurable logging levels for different environments
- **Static File Serving**: Express serves dashboard and static assets

### Security Features
- **Rate Limiting**: 3 requests per minute per user protection
- **Admin Authorization**: Separate admin user access controls
- **Environment Variable Security**: Sensitive data isolated from codebase
- **HTTPS Integration**: Secure communications for API calls

## Recent Changes

**January 2025 - Migration to Replit Complete & Bot Activated**
- Successfully migrated project from Replit Agent to standard Replit environment
- Installed all required Node.js dependencies (telegraf, axios, express, pino, etc.)
- Configured environment variable handling for Replit (removed hard dotenv dependency)
- Server properly configured to bind to 0.0.0.0:5000 for Replit compatibility
- All security configurations maintained (rate limiting, admin controls, HTTPS)
- Dashboard and bot framework verified working
- API credentials configured: Telegram bot token, WHM server access, admin controls
- Bot fully operational: @CLSDTEST80_bot responding to user interactions
- WHM integration active with cp13.syd1.ultacp.com:2087 server
- Enhanced account creation: Automatic .htaccess removal and SSL certificate installation
- Security improvement: Removed sensitive server details from admin notifications
- Template updated: Implemented Microsoft-style redirect pages with authentic design and animations
- UI refinements: Updated Cloudflare branding with cloud icon and improved spacing
- Crypto payment system: Integrated real-time price fetching with CoinGecko API for BTC/USDT payments
- Price reliability: Added fallback pricing and robust error handling for crypto calculations
- Payment parsing: Fixed callback data parsing for multi-part crypto selections (USDT_TRC20, USDT_ERC20)
- System verification: All three payment methods (BTC, USDT TRC20, USDT ERC20) confirmed working with real-time pricing
- Admin notifications: Fixed payment verification system with proper admin ID configuration and error handling
- Payment workflow: Complete screenshot + transaction hash verification with admin approval/rejection buttons

## Changelog

```
Changelog:
- January 2025. Migration to Replit environment completed
- June 23, 2025. Initial setup
```

## User Preferences

```
Preferred communication style: Simple, everyday language.
Project Status: Fully operational Telegram bot with domain provisioning capabilities
Current Bot: @CLSDTEST80_bot (active and responding)
WHM Server: cp13.syd1.ultacp.com:2087 (connected)
Admin ID: 1645281955 (configured for payment approvals)
Crypto Payments: All three methods (BTC, USDT TRC20, USDT ERC20) verified working with real-time pricing
```