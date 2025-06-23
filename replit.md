# Domain Provisioning Telegram Bot

## Overview

This is a Telegram bot application that automates domain provisioning through WHM/cPanel integration. The bot allows users to interact via Telegram to create hosting accounts, with a web dashboard for monitoring and management. The system is built with Node.js and uses the Telegraf framework for Telegram bot functionality.

## System Architecture

### Backend Architecture
- **Runtime**: Node.js 20 with ES modules
- **Bot Framework**: Telegraf for Telegram bot interactions
- **Web Server**: Express.js for serving the dashboard and webhook endpoints
- **HTTP Client**: Axios for WHM/cPanel API communication
- **Logging**: Pino for structured logging
- **Configuration**: dotenv for environment variable management

### Frontend Architecture
- **Dashboard**: Static HTML with embedded CSS and JavaScript
- **Responsive Design**: Mobile-first approach with gradient backgrounds
- **Template System**: HTML templates with placeholder replacement for dynamic content

## Key Components

### 1. Telegram Bot (`bot.js`)
- **Purpose**: Main application entry point handling Telegram interactions
- **Features**: 
  - User session management
  - Command processing
  - Integration with WHM/cPanel API
  - Error handling and logging

### 2. Web Dashboard (`dashboard.html`)
- **Purpose**: Administrative interface for monitoring bot operations
- **Features**:
  - Modern responsive design
  - Status monitoring
  - User activity tracking

### 3. WHM/cPanel Integration
- **Purpose**: Automated hosting account creation
- **Features**:
  - Secure API authentication with Basic Auth
  - Self-signed certificate support
  - Account provisioning with random credentials
  - Domain setup and configuration

### 4. Script Template System (`script-template.html`)
- **Purpose**: Dynamic HTML generation for provisioned domains
- **Features**:
  - Placeholder-based templating
  - Loading animations
  - Redirect functionality

## Data Flow

1. **User Interaction**: User sends commands to Telegram bot
2. **Session Management**: Bot maintains user sessions in memory (Map-based storage)
3. **Domain Provisioning**: Bot communicates with WHM/cPanel API to create hosting accounts
4. **File Generation**: Dynamic HTML files are created using templates
5. **Response**: Bot provides feedback to user with account details

## External Dependencies

### Core Dependencies
- **telegraf**: Telegram bot framework
- **axios**: HTTP client for API calls
- **express**: Web server framework
- **pino**: Logging library
- **dotenv**: Environment configuration

### WHM/cPanel Integration
- **Authentication**: Basic Auth with username/password
- **SSL/TLS**: Custom HTTPS agent with self-signed certificate support
- **API Endpoints**: WHM API for account creation and management

### Telegram Integration
- **Bot Token**: Required for Telegram API access
- **Webhook Support**: Production-ready webhook configuration
- **Admin Controls**: Admin user ID for privileged operations

## Deployment Strategy

### Development Environment
- **Platform**: Replit with Node.js 20 support
- **Auto-install**: Dependencies installed via shell commands
- **Port Configuration**: Runs on port 5000 with automatic port detection

### Production Considerations
- **Webhook Domain**: Configurable webhook URL for production deployment
- **Environment Variables**: Comprehensive configuration via .env file
- **Rate Limiting**: Built-in rate limiting (60 minutes per user)
- **Security**: Admin-only access controls and secure credential handling

### Configuration Management
- **Environment Variables**: All sensitive data stored in environment variables
- **Default Values**: Fallback configurations for development
- **Validation**: Runtime validation of required configuration

## User Preferences

Preferred communication style: Simple, everyday language.

## API Endpoints

### Domain Provisioning API
- **POST /api/provision**: Create cPanel account and 3 script folders
  - Input: `{"domain": "example.com"}`  
  - Returns: cPanel credentials, server IP, and 3 script URLs

### Custom Script Upload API  
- **POST /api/upload-script**: Upload custom script to existing domain
  - Input: `{"domain": "example.com", "scriptContent": "html content", "customFileName": "file.html"}`
  - Returns: Upload confirmation and URL

## System Status

**WHM Integration**: ✅ Connected to cp13.syd1.ultacp.com  
**Package**: pecuwoli_default (10GB quota, 1GB bandwidth)  
**Test Results**: Successfully created test-demo.com with 3 script URLs  
**Server IP**: 212.81.47.13

## Changelog

- June 23, 2025: Initial setup and WHM integration
- June 23, 2025: Confirmed working domain provisioning with UltraHost
- June 23, 2025: Added API endpoints for domain provisioning and script upload