# Telegram Domain Provisioning Bot

## Overview

This Telegram bot automates domain provisioning with cPanel integration, enabling users to purchase hosting, manage balances, and deploy redirect scripts. Its key capabilities include payment management, administrative controls, rate limiting, and comprehensive logging. The project aims to provide an automated, user-friendly platform for domain and hosting services, streamlining the process for individuals and businesses through a Telegram interface.

## Recent Changes

**October 9, 2025:**
- ✅ Migrated all user data from local JSON files to Neon PostgreSQL database (21 users, 7 history records)
- ✅ Removed legacy local storage folders (user_data, history_data, topup_data, clicks_data)
- ✅ Database now accessible from both Replit (development) and Render (production)
- ✅ All data stored securely with persistence across deployments

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

The application is built on a monolithic Node.js architecture utilizing the Telegraf framework for Telegram interactions and an Express server for web functionalities. It integrates with WHM/cPanel for automated hosting account creation and uses Neon PostgreSQL database for persistent data storage (accessible from both Replit and Render).

**UI/UX Decisions:**
- The web dashboard (`dashboard.html`) features a modern, responsive design with gradient styling for monitoring bot activity.
- Redirect script templates include professional loading interfaces with animations.
- Users can choose between HTML and PHP redirect templates via a "Template Settings" menu.

**Technical Implementations:**
- **Bot Interface (`bot.js`):** Handles user commands, payment requests, domain provisioning workflows, admin access, and rate limiting (3 requests per minute per user).
- **Web Dashboard:** Provides real-time bot statistics and monitoring.
- **Script Templates:**
    - `redirect-template.html`: Client-side only, includes Cloudflare Turnstile verification.
    - `redirect-template.php`: Server-side bot detection (redirects bots to Google), includes all HTML template features.
- **Database Module (`db.js`):** Manages PostgreSQL operations for user data, history, click analytics, and top-up transactions, using connection pooling and async/await.
- **Configuration:** Utilizes environment variables for comprehensive and secure configuration.

**System Design Choices:**
- **Data Flow:** User interactions trigger request processing, payment workflows (with admin approval), and domain provisioning (cPanel account creation, script deployment).
- **Logging:** All activities are logged using Pino for structured logging.
- **Security:** Implements rate limiting, admin authorization, environment variable security, and HTTPS for secure communications.

## External Dependencies

- **telegraf:** Telegram bot framework.
- **axios:** HTTP client for WHM/cPanel API communication.
- **express:** Web server for dashboard and webhooks.
- **pino/pino-pretty:** Structured logging.
- **WHM/cPanel API:** For automated hosting account creation.
- **Telegram Bot API:** For bot messaging and user interaction.
- **Cryptocurrency Payment Systems:** Supports Bitcoin, Tether TRC20, and Ethereum.