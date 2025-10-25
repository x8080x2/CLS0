# Telegram Domain Provisioning Bot

## Overview

A professional Telegram bot that automates domain provisioning with cPanel/WHM integration. The bot manages user accounts, processes payments, creates hosting accounts via WHM API, deploys redirect scripts, and tracks analytics. Built with Node.js, Telegraf, Express, and PostgreSQL (Neon).

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Application Structure

**Bot Framework**: Telegraf for Telegram Bot API integration
- Handles user interactions through commands (`/start`, `/help`, `/cancel`)
- Implements conversation flows for domain provisioning, payments, and admin requests
- Rate limiting: 3 requests per minute per user for security
- Webhook support in production, polling in development

**Web Server**: Express.js
- Dashboard interface for viewing provisioning statistics
- Click tracking API endpoint (`/api/track-click`)
- Static file serving for redirect templates
- RESTful API for bot analytics

**Database Layer**: PostgreSQL via Neon (cloud-hosted)
- Drizzle ORM for type-safe database operations
- Connection pooling with pg library (max 20 connections)
- Schema migration support via drizzle-kit
- Four main tables:
  - `users`: User profiles, balances, subscription status, and usage tracking
  - `history`: Domain provisioning records with URLs and timestamps
  - `clicks`: Click tracking for redirect analytics
  - `topups`: Payment transaction records

### Core Features Architecture

**Domain Provisioning System**
- Integrates with WHM API for automated cPanel account creation
- Cost: $80 per domain (deducted from user balance)
- Creates 3 redirect script folders per domain
- Supports both HTML and plain templates
- Automatic script deployment to hosting accounts
- Returns provisioned URLs and server credentials

**Payment & Balance System**
- User balance tracking in cents/points
- Multiple payment methods: Bitcoin, Tether TRC20, Ethereum
- Admin approval workflow for top-ups
- Transaction history tracking
- Balance deduction on successful provisioning

**Subscription Model**
- Optional subscription system for power users
- Daily domain limits for subscribed users
- Tracks subscription start/end dates
- Monitors domains used within subscription period
- Automatic expiry handling

**Admin Controls**
- Special admin user privileges (free provisioning)
- User management capabilities
- Payment approval system
- One-time free access grants

**Analytics & Tracking**
- Click tracking per domain via IP address
- Dashboard for viewing statistics
- Provisioning history (last 10 domains per user)
- User profile with total domains and join date

### Security & Rate Limiting

**Rate Limiting**: Custom implementation limiting users to 3 requests per minute
- Prevents abuse and API overload
- Applied per user ID
- Tracked in-memory (consider Redis for production scaling)

**Error Handling**: Global error handler for Telegram API errors
- Gracefully handles message edit failures
- Prevents bot crashes on API conflicts
- Structured logging with Pino

**Data Validation**: Input validation for domain names, redirect URLs, and user inputs

### External Dependencies

**Telegram Bot API** (via Telegraf)
- User interaction interface
- Message handling and inline keyboards
- Webhook/polling modes based on environment

**WHM/cPanel API**
- Automated hosting account creation
- Server: `cp2.tor1.ultacp.com:2087`
- Authentication via API token
- HTTPS agent for secure connections

**Neon PostgreSQL**
- Cloud-hosted PostgreSQL database
- Connection string: `ep-raspy-brook-a150lned-pooler.ap-southeast-1.aws.neon.tech`
- SSL/TLS required
- Persistent storage across deployments

**Cloudflare API** (Optional)
- Domain security configuration
- SSL/TLS settings management
- HTTPS enforcement
- Security level adjustments
- Requires email and global API key

**Deployment Platforms**
- Replit: Development environment with built-in database support
- Render: Production deployment with webhook mode
- Environment-based configuration switching

### Configuration Management

**Environment Variables**
- `DATABASE_URL`: PostgreSQL connection string (Neon)
- `TELEGRAM_BOT_TOKEN`: Bot authentication
- `WHM_SERVER`, `WHM_USERNAME`, `WHM_API_TOKEN`: cPanel integration
- `ADMIN_CHAT_ID`: Admin user identification
- `NODE_ENV`: Environment mode (production/development)
- `LOG_LEVEL`: Logging verbosity

**Template System**
- HTML redirect template (`redirect-template-plain.html`)
- Email parameter extraction from URL
- Configurable redirect delay (532ms)
- User template preference storage

### Logging & Monitoring

**Pino Logger**: Structured JSON logging
- Configurable log levels
- Pretty printing in development
- Production-ready format for log aggregation
- Request tracking and error monitoring

### Design Rationale

**PostgreSQL over File-based Storage**: Chosen for data persistence across deployments on platforms like Render where filesystem is ephemeral. Neon provides serverless PostgreSQL with automatic scaling and backups.

**Drizzle ORM**: Type-safe database operations with TypeScript support, migrations, and better developer experience compared to raw SQL queries.

**Webhook vs Polling**: Production uses webhooks to avoid 409 conflicts and improve efficiency. Development uses polling for easier local testing.

**Connection Pooling**: Implements pg pool with max 20 connections to handle concurrent requests efficiently while respecting Neon's connection limits.

**Modular Architecture**: Separated concerns (bot logic, database operations, Cloudflare config) for maintainability and testing.