# Overview

This is a Telegram bot application that provides domain redirection services integrated with Cloudflare. Users can purchase and configure domains with custom redirect URLs through a Telegram interface. The system includes subscription management, balance tracking, and a web dashboard for monitoring domain statistics.

The application manages user subscriptions, domain configurations, and click tracking while leveraging Cloudflare's API for DNS management and security settings. It uses PostgreSQL for data persistence and JWT-based authentication for web dashboard access.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Backend Architecture

**Node.js Express Server**: The application uses Express.js as the web framework, serving both API endpoints and static files. The main server (`bot.js`) handles HTTP requests, static file serving, and integrates with the Telegram bot.

**Telegram Bot Integration**: Uses the Telegraf library to create a bot interface for user interactions. The bot handles commands for domain purchases, subscription management, and user queries.

**Authentication & Security**:
- JWT-based authentication with separate access tokens (15min expiry) and refresh tokens (7 day expiry)
- In-memory token stores for refresh tokens and CSRF tokens (production should use Redis)
- Rate limiting middleware applied globally (100 requests per 60 seconds)
- Token rotation and revocation support

**Database Layer**: PostgreSQL accessed through the `pg` library with connection pooling. The database module (`db.js`) provides an abstraction layer for user operations and data management. Drizzle ORM is configured but the current implementation uses raw SQL queries through pg's Pool.

**Key Design Decisions**:
- Chose JWT over session-based auth for stateless API authentication
- Implemented dual token system (access + refresh) to balance security and user experience
- Used connection pooling (max 20 connections) to optimize database performance
- Separated bot logic from web server logic while running both in the same process

## Frontend Architecture

**Dashboard Interface**: Single-page HTML dashboard (`dashboard.html`) with embedded CSS and client-side JavaScript. The dashboard provides full feature parity with the Telegram bot interface, including:

- **Top Up Balance**: Crypto payment interface with BTC, USDT TRC20/ERC20 support
- **Create Redirect**: Domain creation form with template selection
- **Subscription Management**: View status, purchase/renew subscriptions
- **Cloudflare Security**: Configure security settings for domains
- **VIP Access Request**: Submit requests for unlimited access
- **Admin Panel**: Payment approval, user management, analytics (admin-only)
- **Template Settings**: Choose between Plain HTML and Cloudflare templates
- **Domain Analytics**: Click tracking and statistics per domain

**Static Asset Serving**: Express serves static files from the root directory and a dedicated `/attached_assets` route for resources.

**Template System**: HTML redirect templates (`redirect-template-plain.html`) that are dynamically populated with redirect URLs. Templates include JavaScript logic for email parameter handling and delayed redirects.

## Data Models

The system uses four main database tables defined in `schema.ts`:

**users table**:
- Tracks user balance, subscription status, and domain usage
- Implements daily domain limits and lifetime subscription tracking
- Stores template preferences (HTML vs other formats)

**history table**:
- Records domain creation history per user
- Stores domain configurations and associated URLs
- Indexed on userId for efficient user-specific queries

**clicks table**:
- Tracks domain redirect clicks with IP addresses
- Indexed on domain for analytics queries

**topups table**:
- Records balance top-up transactions
- Links to users with transaction IDs and status tracking

**Design Rationale**: The schema supports subscription-based business logic with daily limits, historical tracking for auditing, and analytics capabilities through click tracking.

## Authentication Flow

1. User authenticates (mechanism not shown in provided code)
2. Server generates access token (15min) and refresh token (7d)
3. Refresh tokens stored in-memory Map (keyed by userId)
4. CSRF tokens generated and stored separately
5. Access token used for API requests
6. Refresh token used to obtain new access tokens when expired
7. Token revocation supported through store removal

**Production Considerations**: Code comments indicate Redis should replace in-memory Maps for distributed deployments.

# External Dependencies

## Cloudflare Integration

**Purpose**: Domain management and security configuration

**Implementation**: Custom `CloudflareConfig` class wraps Cloudflare's API v4

**Capabilities**:
- List all domains in Cloudflare account
- Configure security settings per zone (HTTPS, SSL, bot protection, TLS versions)
- Authenticated via email + global API key

**Authentication**: Uses X-Auth-Email and X-Auth-Key headers

## Database

**Technology**: PostgreSQL

**Access Pattern**: Connection pooling via `pg` library

**Configuration**: Uses `DATABASE_URL` environment variable (Replit PostgreSQL)

**ORM**: Drizzle ORM configured with TypeScript schema, though current code uses raw SQL queries

**Migration Tools**: drizzle-kit available for schema management (`db:push`, `db:studio` scripts)

## Telegram Bot API

**Library**: Telegraf v4.16.3

**Purpose**: Primary user interface for bot commands and interactions

**Integration Point**: Main bot logic in `bot.js`

## Third-Party Services

**Logging**: Pino logger with pretty-print support for development

**HTTP Client**: Axios for external API calls (Cloudflare)

**Environment**: dotenv for local environment variable management with fallback to system environment

## Authentication Libraries

**JWT**: jsonwebtoken v9.0.2 for token generation and verification

**Crypto**: Native Node.js crypto module for secret generation

## Runtime Environment

**Platform**: Designed for Replit deployment (references Replit Database and PostgreSQL)

**Environment Variables Required**:
- `DATABASE_URL`: PostgreSQL connection string
- `JWT_SECRET`: Optional, auto-generated if not provided
- `JWT_REFRESH_SECRET`: Optional, auto-generated if not provided
- Cloudflare API credentials (email and key, loading mechanism not shown)