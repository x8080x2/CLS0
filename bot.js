// Load environment variables
try {
  require("dotenv").config();
  console.log("Environment variables loaded from .env file");
} catch (e) {
  console.log("Dotenv not available, using environment variables directly");
}
const { Telegraf } = require("telegraf");
const axios = require("axios");
const https = require("https");
const crypto = require("crypto");
const pino = require("pino");
const express = require("express");
const path = require("path");
const fs = require("fs");

// __dirname is available by default in CommonJS
const app = express();

// Middleware for parsing JSON
app.use(express.json());

// Serve static files
app.use(express.static("."));

// Root route - redirect to dashboard
app.get("/", (_, res) => {
  res.redirect("/dashboard");
});

// Serve dashboard
app.get("/dashboard", (_, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Click tracking endpoint
app.post("/api/track-click", (req, res) => {
  try {
    const { domain, timestamp } = req.body;

    if (!domain) {
      return res.status(400).json({ error: "Domain required" });
    }

    // Create clicks directory if it doesn't exist
    const clicksDir = path.join(__dirname, 'clicks_data');
    if (!fs.existsSync(clicksDir)) {
      fs.mkdirSync(clicksDir, { recursive: true });
    }

    // Store click data by domain
    const clickFile = path.join(clicksDir, `${domain}.json`);
    let clickData = { domain, clicks: [] };

    if (fs.existsSync(clickFile)) {
      clickData = JSON.parse(fs.readFileSync(clickFile, 'utf8'));
    }

    clickData.clicks.push({
      timestamp: timestamp || new Date().toISOString(),
      ip: req.ip || req.connection.remoteAddress || 'unknown'
    });

    fs.writeFileSync(clickFile, JSON.stringify(clickData, null, 2));

    res.json({ success: true, totalClicks: clickData.clicks.length });
  } catch (error) {
    res.status(500).json({ error: "Failed to track click" });
  }
});

// Get click statistics for a domain
app.get("/api/clicks/:domain", (req, res) => {
  try {
    const { domain } = req.params;
    const clickFile = path.join(__dirname, 'clicks_data', `${domain}.json`);

    if (!fs.existsSync(clickFile)) {
      return res.json({ domain, totalClicks: 0, clicks: [] });
    }

    const clickData = JSON.parse(fs.readFileSync(clickFile, 'utf8'));
    res.json({
      domain: clickData.domain,
      totalClicks: clickData.clicks.length,
      recentClicks: clickData.clicks.slice(-10) // Last 10 clicks
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get click statistics" });
  }
});

// Enhanced Logger with better formatting
let loggerConfig = {
  level: process.env.LOG_LEVEL || "info",
};

// Only add pretty printing in development and if available
if (process.env.NODE_ENV !== "production") {
  try {
    require("pino-pretty");
    loggerConfig.transport = {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    };
  } catch (e) {
    // Fallback to basic logging if pino-pretty is not available
    console.log("Pino-pretty not available, using basic logging");
  }
}

const baseLog = pino(loggerConfig);
const L = (id) => baseLog.child({ reqId: id });

// Log startup information
const startupLog = L("startup");
startupLog.info("🚀 Domain Provisioning Bot starting...");
startupLog.info(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
startupLog.info(`🔧 Log Level: ${process.env.LOG_LEVEL || "info"}`);
startupLog.info(`🌐 WHM Server: ${process.env.WHM_SERVER || "Not configured"}`);

// HTTPS Agent for self-signed certificates
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

// Random helpers
const rInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const rStr = (l, s = "abcdefghijklmnopqrstuvwxyz0123456789") =>
  [...Array(l)].map(() => s[rInt(0, s.length - 1)]).join("");
const rFile = (extension = "html") => rStr(99) + "." + extension;

// WHM API Client
const WHM = axios.create({
  baseURL: process.env.WHM_SERVER,
  httpsAgent: tlsAgent,
  timeout: 30000,
  maxRetries: 2,
  headers: {
    Authorization:
      "Basic " +
      Buffer.from(
        `${process.env.WHM_USERNAME}:${process.env.WHM_PASSWORD}`,
        "utf8",
      ).toString("base64"),
  },
});

// Add request interceptor for retry logic
WHM.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    if (!config || !config.retry) {
      config.retry = 0;
    }

    if (config.retry < 2 && error.code === 'ECONNRESET') {
      config.retry++;
      console.log(`Retrying WHM request (attempt ${config.retry})`);
      return WHM(config);
    }

    return Promise.reject(error);
  }
);

// User sessions with rate limiting and cleanup
const sessions = new Map();
const rateLimits = new Map();

// Cleanup old sessions and rate limits every 10 minutes
setInterval(() => {
  const now = Date.now();

  // Clean up rate limits older than 1 hour
  for (const [userId, limit] of rateLimits.entries()) {
    if (now > limit.resetTime + 3600000) { // 1 hour
      rateLimits.delete(userId);
    }
  }

  // Clean up inactive sessions older than 30 minutes
  for (const [userId, session] of sessions.entries()) {
    if (!session.lastActivity || now - session.lastActivity > 1800000) { // 30 minutes
      sessions.delete(userId);
    }
  }

  console.log(`Cleaned up sessions. Active: ${sessions.size}, Rate limits: ${rateLimits.size}`);
}, 600000); // 10 minutes

function getSession(ctx) {
  try {
    if (!ctx || !ctx.from || !ctx.from.id) {
      console.error('Invalid context provided to getSession');
      return {};
    }

    const id = ctx.from.id;
    if (!sessions.has(id)) {
      sessions.set(id, { lastActivity: Date.now() });
    } else {
      sessions.get(id).lastActivity = Date.now();
    }
    return sessions.get(id);
  } catch (error) {
    console.error('Error getting session:', error);
    return {};
  }
}

function checkRateLimit(userId) {
  const now = Date.now();
  const userLimit = rateLimits.get(userId) || { count: 0, resetTime: now + 60000 };

  if (now > userLimit.resetTime) {
    userLimit.count = 1;
    userLimit.resetTime = now + 60000;
  } else {
    userLimit.count++;
  }

  rateLimits.set(userId, userLimit);
  return userLimit.count <= 3; // Max 3 requests per minute
}

// Post-creation tasks: Remove .htaccess and enable SSL
async function performPostCreationTasks(domain, username, log) {
  try {
    // Remove .htaccess file from public_html using cPanel API
    log.info({ domain, username }, "Removing .htaccess file");

    try {
      await WHM.get("/json-api/cpanel", {
        params: {
          cpanel_jsonapi_user: username,
          cpanel_jsonapi_apiversion: 2,
          cpanel_jsonapi_module: "Fileman",
          cpanel_jsonapi_func: "unlink",
          path: "public_html/.htaccess"
        }
      });
      log.info({ domain, username }, ".htaccess file removed successfully");
    } catch (htaccessError) {
      log.warn({ domain, username, error: htaccessError.message }, "Failed to remove .htaccess (may not exist)");
    }

    // Enable SSL/TLS for the domain
    log.info({ domain, username }, "Enabling SSL certificate");
    const sslParams = new URLSearchParams({
      domain: domain
    });

    try {
      await WHM.post("/json-api/start_autossl_check?api.version=1", sslParams);
      log.info({ domain, username }, "SSL certificate request initiated");
    } catch (sslError) {
      log.warn({ domain, username, error: sslError.message }, "Failed to initiate SSL certificate");
    }

  } catch (error) {
    log.error({ domain, username, error: error.message }, "Post-creation tasks failed");
  }
}

// Create WHM/cPanel account
async function createAccount(domain, log) {
  const user = (
    domain
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 3)
      .toLowerCase() + rStr(5)
  ).slice(0, 8);

  const pass = rStr(
    14,
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()",
  );

  const params = new URLSearchParams({
    domain,
    username: user,
    password: pass,
    plan: process.env.WHM_PACKAGE_NAME || "pecuwoli_default",
  });

  log.info({ domain, user }, "Creating cPanel account");

  const { data } = await WHM.post("/json-api/createacct?api.version=1", params);

  if (!data?.metadata || data.metadata.result !== 1) {
    throw new Error(
      data?.metadata?.reason || "Failed to create cPanel account",
    );
  }

  log.info({ domain, user, ip: data.data.ip }, "Account created successfully");

  // Additional post-creation tasks
  await performPostCreationTasks(domain, user, log);

  return {
    user,
    password: pass,
    ip: data.data.ip,
  };
}

// Create directory in public_html
const createDirectory = (user, folderName) =>
  WHM.get("/json-api/cpanel", {
    params: {
      cpanel_jsonapi_user: user,
      cpanel_jsonapi_apiversion: 2,
      cpanel_jsonapi_module: "Fileman",
      cpanel_jsonapi_func: "mkdir",
      path: "public_html",
      name: folderName,
    },
  });

// Upload script file to directory
const uploadScriptFile = (user, folderName, fileName, htmlContent) =>
  WHM.post("/json-api/cpanel", null, {
    params: {
      cpanel_jsonapi_user: user,
      cpanel_jsonapi_apiversion: 3,
      cpanel_jsonapi_module: "Fileman",
      cpanel_jsonapi_func: "save_file_content",
      dir: `/home/${user}/public_html/${folderName}`,
      file: fileName,
      content: htmlContent,
      from_charset: "UTF-8",
      to_charset: "UTF-8",
    },
  });

// Generate custom script content using external template file
async function generateCustomScriptContent(redirectUrl, userId) {
  try {
    // Get user's template preference
    const userData = await getUserData(userId);
    const templateType = userData.templateType || 'html';
    
    // Read the appropriate template file
    const templatePath = path.join(__dirname, `redirect-template.${templateType}`);
    const templateContent = fs.readFileSync(templatePath, 'utf8');

    // Replace the placeholder with the actual redirect URL
    // Support both {{REDIRECT_URL}} and REDIRECT_URL_PLACEHOLDER patterns
    let content = templateContent.replace('{{REDIRECT_URL}}', redirectUrl);
    content = content.replace('REDIRECT_URL_PLACEHOLDER', redirectUrl);
    
    return { content, extension: templateType };
  } catch (error) {
    console.error('Error reading template file:', error);
    // Fallback to basic redirect if template file is not available
    return {
      content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Redirecting...</title>
    <script>
        setTimeout(function() {
            window.location.href = "${redirectUrl}";
        }, 300);
    </script>
</head>
<body>
    <p>Redirecting...</p>
</body>
</html>`,
      extension: 'html'
    };
  }
}

// ==========================================
// PAYMENT PROCESSING HELPER FUNCTIONS
// ==========================================

// Helper function to process payment verification (eliminates duplicate code)
async function processPaymentVerification(ctx, paymentProof, screenshot = null, transactionHash = null) {
  const userId = ctx.from.id;
  const requestId = `PAY_${userId}_${Date.now()}`;

  // Create user_data directory if it doesn't exist
  const userDataDir = path.join(__dirname, 'user_data');
  if (!fs.existsSync(userDataDir)) {
    fs.mkdirSync(userDataDir, { recursive: true });
  }

  // Store payment verification request
  const userData = await getUserData(userId);
  userData.pending_payments = userData.pending_payments || [];
  userData.pending_payments.push({
    id: requestId,
    amount: paymentProof.amount,
    cryptoType: paymentProof.cryptoType,
    screenshot: screenshot,
    transactionHash: transactionHash || 'Provided via screenshot',
    timestamp: new Date().toISOString(),
    status: 'pending'
  });

  await saveUserData(userId, userData);

  // Send to admin for approval
  try {
    const adminId = process.env.ADMIN_ID;
    const cryptoSymbol = paymentProof.cryptoType === 'BTC' ? 'BTC' : 'USDT';
    const network = paymentProof.cryptoType.includes('TRC20') ? ' [TRC20]' : 
                  paymentProof.cryptoType.includes('ERC20') ? ' [ERC20]' : '';

    const messageText = `💰 *Payment Verification Request*\n\n` +
            `👤 User: ${ctx.from.first_name || 'Unknown'} (${userId})\n` +
            `💵 Amount: $${paymentProof.amount}\n` +
            `₿ Crypto: ${cryptoSymbol}${network}\n` +
            `🔗 Hash: \`${transactionHash || 'See screenshot'}\`\n` +
            `🆔 ID: \`${requestId}\`\n\n` +
            `${screenshot ? '📸 Screenshot provided' : '📄 Transaction hash only'}\n` +
            `Please verify this payment:`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Approve Payment', callback_data: `approve_payment_${requestId}` },
          { text: '❌ Reject Payment', callback_data: `reject_payment_${requestId}` }
        ]
      ]
    };

    if (screenshot) {
      await bot.telegram.sendPhoto(adminId, screenshot, {
        caption: messageText,
        parse_mode: "Markdown",
        reply_markup: keyboard
      });
    } else {
      await bot.telegram.sendMessage(adminId, messageText, {
        parse_mode: "Markdown",
        reply_markup: keyboard
      });
    }
  } catch (adminError) {
    console.error("Failed to send payment verification to admin:", adminError.message);
  }

  return requestId;
}

// ==========================================
// CRYPTO PRICE API & TOP-UP FUNCTIONALITY
// ==========================================

// Admin user ID for notifications (now using process.env.ADMIN_ID like VIP access)

// Crypto wallet addresses
const CRYPTO_WALLETS = {
  BTC: "bc1qsttwav3g9p3fcvwhu0je2swttca5zyu7lq47hm",
  "USDT_TRC20": "TBQbur14oKop1THRNyy7rSJU9cbG2EPtC4",
  "USDT_ERC20": "0x6b298ED5767BE52aa7974a986aE0C4d41B70BE96"
};

// Fetch crypto prices from CoinGecko API with fallback prices
async function fetchCryptoPrice(cryptoId) {
  try {
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${cryptoId}&vs_currencies=usd`, {
      timeout: 10000
    });

    if (response.data && response.data[cryptoId] && response.data[cryptoId].usd) {
      return response.data[cryptoId].usd;
    }

    // Fallback to reasonable prices if API fails
    const fallbackPrices = {
      'bitcoin': 97000,
      'tether': 1
    };

    console.log(`Using fallback price for ${cryptoId}`);
    return fallbackPrices[cryptoId] || null;

  } catch (error) {
    console.error(`Failed to fetch ${cryptoId} price:`, error.message);

    // Fallback prices
    const fallbackPrices = {
      'bitcoin': 97000,
      'tether': 1
    };

    return fallbackPrices[cryptoId] || null;
  }
}

// Calculate crypto amount needed for USD amount
async function calculateCryptoAmount(usdAmount, cryptoType) {
  try {
    if (!usdAmount || isNaN(usdAmount) || usdAmount <= 0) {
      console.error(`Invalid USD amount: ${usdAmount}`);
      return null;
    }

    const priceMap = {
      BTC: 'bitcoin',
      USDT_TRC20: 'tether',
      USDT_ERC20: 'tether'
    };

    const cryptoId = priceMap[cryptoType];

    if (!cryptoId) {
      console.error(`Unknown crypto type: ${cryptoType}`);
      return null;
    }

    const price = await fetchCryptoPrice(cryptoId);

    if (!price || isNaN(price) || price <= 0) {
      console.error(`Invalid price for ${cryptoId}: ${price}`);
      return null;
    }

    if (cryptoType.includes('USDT')) {
      return usdAmount.toFixed(2); // USDT is 1:1 with USD, 2 decimals
    } else {
      const amount = usdAmount / price;
      if (isNaN(amount) || !isFinite(amount)) {
        console.error(`Invalid calculation result for ${cryptoType}`);
        return null;
      }
      return amount.toFixed(8); // BTC with 8 decimals
    }
  } catch (error) {
    console.error(`Error calculating crypto amount:`, error);
    return null;
  }
}

// Generate top-up payment message for specific crypto
async function generateTopUpMessage(usdAmount, cryptoType) {
  const amount = await calculateCryptoAmount(usdAmount, cryptoType);
  if (!amount) {
    return "❌ Unable to fetch current crypto prices. Please try again.";
  }

  const wallet = CRYPTO_WALLETS[cryptoType];
  const cryptoSymbol = cryptoType === 'BTC' ? 'BTC' : 'USDT';
  const network = cryptoType.includes('TRC20') ? ' [TRC20]' : cryptoType.includes('ERC20') ? ' [ERC20]' : '';

  return {
    text: `⚠️ *Please send the exact amount to the address below:*

*Address:* \`${wallet}\`
*Amount of payment:* ${amount}.000000
*Status:* 🕜 WAITING FOR PAYMENT...

❗️ *Ensure the funds are sent within 30 minutes.*
🟢 *Click "I Paid" below after sending payment*
⚠️ *This address is valid for one-time use only.*`,
    keyboard: {
      inline_keyboard: [
        [
          { text: '✅ I Paid', callback_data: `paid_${cryptoType}_${usdAmount}` },
          { text: '❌ Cancel', callback_data: 'cancel_payment' }
        ]
      ]
    }
  };
}

// ==========================================
// TELEGRAM BOT INITIALIZATION
// ==========================================

let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== "your_telegram_bot_token_here") {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  // Set webhook if in production
  if (process.env.NODE_ENV === "production" && process.env.WEBHOOK_DOMAIN) {
    bot.telegram.setWebhook(`${process.env.WEBHOOK_DOMAIN}/bot${process.env.TELEGRAM_BOT_TOKEN}`);
  }
}

// ==========================================
// DATA STORAGE & USER MANAGEMENT
// ==========================================

// Import Replit Database for persistent storage
let Database;
let db;

// Temporarily disable Replit Database due to data corruption issues
// Force use of file-based storage for better reliability
try {
  // Database = require('@replit/database');
  // db = new Database();
  console.log('⚠️ Replit Database temporarily disabled - using file storage for stability');
  db = null; // Force file-based storage
} catch (error) {
  console.log('⚠️ Replit Database not available, using file storage');
  db = null;
}

// Create data directories
const dataDir = path.join(__dirname, 'user_data');
const historyDir = path.join(__dirname, 'history_data');

[dataDir, historyDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Load user data with database fallback
async function loadUserData(userId) {
  try {
    if (!userId || typeof userId !== 'number' && typeof userId !== 'string') {
      console.error('Invalid userId provided to loadUserData:', userId);
      return null;
    }

    if (db) {
      // Use Replit Database
      try {
        const rawData = await db.get(`user_${userId}`);
        if (rawData) {
          // Handle nested database objects from Replit DB corruption
          let data = rawData;
          
          // If data is wrapped in nested 'value' or 'ok' objects, unwrap it
          while (data && typeof data === 'object' && (data.value || data.ok)) {
            if (data.value && typeof data.value === 'object') {
              data = data.value;
            } else if (data.ok && typeof data.ok === 'object') {
              data = data.ok;
            } else {
              break;
            }
          }
          
          // Ensure we have a valid user data object
          if (data && data.id && typeof data.balance === 'number') {
            // Convert date strings back to Date objects
            if (data.joinDate) data.joinDate = new Date(data.joinDate);
            
            // Clean the database by saving the unwrapped data
            await db.set(`user_${userId}`, data);
            console.log(`Cleaned and fixed database entry for user ${userId}`);
            
            return data;
          }
        }
      } catch (dbError) {
        console.error(`Database error loading user ${userId}:`, dbError);
        // Fall through to file system
      }
    }

    // Fallback to file system
    const dataDir = path.join(__dirname, 'user_data');
    const userFile = path.join(dataDir, `${userId}.json`);
    if (fs.existsSync(userFile)) {
      const data = JSON.parse(fs.readFileSync(userFile, 'utf8'));
      // Convert date strings back to Date objects
      if (data.joinDate) data.joinDate = new Date(data.joinDate);

      // Migrate to database if available
      if (db) {
        try {
          await db.set(`user_${userId}`, data);
          console.log(`Migrated user ${userId} to database`);
        } catch (migrateError) {
          console.error(`Failed to migrate user ${userId}:`, migrateError.message);
          // Continue with file-based storage if migration fails
        }
      }

      return data;
    }
  } catch (error) {
    console.error(`Error loading user data for ${userId}:`, error);
  }
  return null;
}

// Save user data with database priority
async function saveUserData(userId, userData) {
  try {
    if (!userId || typeof userId !== 'number' && typeof userId !== 'string') {
      console.error('Invalid userId provided to saveUserData:', userId);
      return false;
    }

    if (!userData || typeof userData !== 'object') {
      console.error('Invalid userData provided to saveUserData:', userData);
      return false;
    }

    let success = false;

    if (db) {
      // Primary: Save to Replit Database
      try {
        await db.set(`user_${userId}`, userData);
        success = true;
        console.log(`User ${userId} data saved to database`);
      } catch (dbError) {
        console.error(`Database error saving user ${userId}:`, dbError);
        // Fall through to file system
      }
    }

    // Backup: Save to file system
    try {
      const dataDir = path.join(__dirname, 'user_data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const userFile = path.join(dataDir, `${userId}.json`);
      const tempFile = userFile + '.tmp';

      // Write to temp file first, then rename for atomic operation
      fs.writeFileSync(tempFile, JSON.stringify(userData, null, 2));
      fs.renameSync(tempFile, userFile);

      if (!success) {
        success = true;
        console.log(`User ${userId} data saved to file system`);
      }
    } catch (fileError) {
      console.error(`File system error saving user ${userId}:`, fileError);
    }

    return success;
  } catch (error) {
    console.error(`Error saving user data for ${userId}:`, error);
    return false;
  }
}

// Load user history with database support
async function loadUserHistory(userId) {
  try {
    if (db) {
      try {
        const data = await db.get(`history_${userId}`);
        if (data && Array.isArray(data)) {
          return data.map(item => ({
            ...item,
            date: new Date(item.date)
          }));
        }
      } catch (dbError) {
        console.error(`Database error loading history ${userId}:`, dbError);
      }
    }

    // Fallback to file system
    const historyDir = path.join(__dirname, 'history_data');
    const historyFile = path.join(historyDir, `${userId}.json`);
    if (fs.existsSync(historyFile)) {
      const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'));

      // Ensure data is an array
      if (!Array.isArray(data)) {
        console.error(`History data for ${userId} is not an array, resetting to empty array`);
        return [];
      }

      // Convert date strings back to Date objects
      const historyData = data.map(item => ({
        ...item,
        date: new Date(item.date)
      }));

      // Migrate to database if available
      if (db) {
        try {
          await db.set(`history_${userId}`, historyData);
          console.log(`Migrated history ${userId} to database`);
        } catch (migrateError) {
          console.error(`Failed to migrate history ${userId}:`, migrateError);
        }
      }

      return historyData;
    }
  } catch (error) {
    console.error(`Error loading history for ${userId}:`, error);
  }
  return [];
}

// Save user history with database priority
async function saveUserHistory(userId, history) {
  try {
    let success = false;

    if (db) {
      try {
        await db.set(`history_${userId}`, history);
        success = true;
      } catch (dbError) {
        console.error(`Database error saving history ${userId}:`, dbError);
      }
    }

    // Backup to file system
    try {
      const historyDir = path.join(__dirname, 'history_data');
      if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
      }

      const historyFile = path.join(historyDir, `${userId}.json`);
      fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

      if (!success) success = true;
    } catch (fileError) {
      console.error(`File system error saving history ${userId}:`, fileError);
    }

    return success;
  } catch (error) {
    console.error(`Error saving history for ${userId}:`, error);
    return false;
  }
}

// Initialize admin access requests storage
const adminRequests = new Map();

async function getUserData(userId) {
  let userData = await loadUserData(userId);
  if (!userData) {
    userData = {
      id: userId,
      balance: 0,
      joinDate: new Date(),
      totalDomains: 0,
      templateType: 'html',
      subscription: {
        active: false,
        startDate: null,
        endDate: null,
        domainsUsed: 0,
        hasEverSubscribed: false
      }
    };
    await saveUserData(userId, userData);
  }

  // Ensure all required properties exist with proper defaults
  userData.id = userData.id || userId;
  userData.balance = (typeof userData.balance === 'number' && !isNaN(userData.balance)) ? userData.balance : 0;
  userData.totalDomains = (typeof userData.totalDomains === 'number' && !isNaN(userData.totalDomains)) ? userData.totalDomains : 0;
  userData.templateType = userData.templateType || 'html';
  userData.joinDate = userData.joinDate ? new Date(userData.joinDate) : new Date();

  // Ensure subscription object exists and has all required properties
  if (!userData.subscription || typeof userData.subscription !== 'object') {
    userData.subscription = {
      active: false,
      startDate: null,
      endDate: null,
      domainsUsed: 0,
      hasEverSubscribed: false
    };
  } else {
    // Validate and fix subscription properties
    userData.subscription.active = typeof userData.subscription.active === 'boolean' ? userData.subscription.active : false;
    userData.subscription.domainsUsed = (typeof userData.subscription.domainsUsed === 'number' && !isNaN(userData.subscription.domainsUsed)) ? userData.subscription.domainsUsed : 0;
    userData.subscription.hasEverSubscribed = typeof userData.subscription.hasEverSubscribed === 'boolean' ? userData.subscription.hasEverSubscribed : false;

    // Validate dates
    if (userData.subscription.startDate && typeof userData.subscription.startDate === 'string') {
      userData.subscription.startDate = new Date(userData.subscription.startDate);
    }
    if (userData.subscription.endDate && typeof userData.subscription.endDate === 'string') {
      userData.subscription.endDate = new Date(userData.subscription.endDate);
    }
  }

  // Check if subscription has expired
  if (userData.subscription.active && userData.subscription.endDate) {
    const now = new Date();
    const endDate = new Date(userData.subscription.endDate);
    if (now > endDate) {
      userData.subscription.active = false;
      userData.subscription.domainsUsed = 0;
      await saveUserData(userId, userData);
    }
  }

  return userData;
}

async function updateUserBalance(userId, newBalance) {
  const userData = await getUserData(userId);
  userData.balance = newBalance;
  await saveUserData(userId, userData);
}

async function addUserHistory(userId, historyItem) {
  const history = await loadUserHistory(userId);
  history.push(historyItem);
  await saveUserHistory(userId, history);
}

// Get click statistics for a domain
function getDomainClicks(domain) {
  try {
    const clickFile = path.join(__dirname, 'clicks_data', `${domain}.json`);
    if (!fs.existsSync(clickFile)) {
      return 0;
    }
    const clickData = JSON.parse(fs.readFileSync(clickFile, 'utf8'));
    return clickData.clicks ? clickData.clicks.length : 0;
  } catch (error) {
    return 0;
  }
}

// ==========================================
// TELEGRAM BOT COMMAND HANDLERS
// ==========================================

if (bot) {
  // Start command with main menu
  bot.start(async (ctx) => {
    const session = getSession(ctx);
    const user = await getUserData(ctx.from.id);

    const log = L("start-command");
    log.info(
      {
        userId: ctx.from.id,
        username: ctx.from.username || "unknown",
        firstName: ctx.from.first_name || "unknown",
      },
      "👤 New user started bot interaction",
    );

    return ctx.reply(
      `🎯 *CLS Redirect Bot*`,
      { 
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💳 Top Up', callback_data: 'topup' },
              { text: '🎯 Create Redirect', callback_data: 'redirect' }
            ],
            [
              { text: '⭐ Monthly Subscription', callback_data: 'subscription' },
              { text: '👤 My Profile', callback_data: 'profile' }
            ],
            [
              { text: '📊 My Redirects', callback_data: 'history' },
              { text: 'Domain Tester 🚥', url: 'https://t.me/clstes_bot' }
            ],
            [
              { text: '⚙️ Template Settings', callback_data: 'template_settings' },
              { text: '🔑 VIP Access Request', callback_data: 'admin_access' }
            ]
          ]
        }
      }
    );
  });



  // Help command
  bot.help((ctx) => {
    return ctx.reply(
      "📋 *CLS Redirect Bot - Help Guide*\n\n" +
        "🎯 */start* - Launch the main menu\n" +
        "❓ */help* - Show this help guide\n" +
        "❌ */cancel* - Cancel current operation\n\n" +
        "✨ *How CLS Redirect Works:*\n" +
        "1️⃣ Send your domain + target URL\n" +
        "2️⃣ We create your redirect hosting instantly\n" +
        "3️⃣ Get 3 professional redirect scripts\n" +
        "4️⃣ Receive live URLs with SSL certificates\n\n" +
        "🎨 *Features:*\n" +
        "• Microsoft-style loading animations\n" +
        "• Email parameter capture (?email=)\n" +
        "• Instant SSL certificate setup\n" +
        "• Professional redirect pages",
      { parse_mode: "Markdown" },
    );
  });

  // Cancel command
  bot.command("cancel", (ctx) => {
    const session = getSession(ctx);
    sessions.delete(ctx.from.id);

    return ctx.reply("❌ Operation cancelled. Use /start to begin again.");
  });

  // ==========================================
  // PHOTO MESSAGE HANDLERS
  // ==========================================

  bot.on('photo', async (ctx) => {
    const session = getSession(ctx);

    if (session.awaiting_payment_proof) {
      // Get the highest resolution photo
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const photoFileId = photo.file_id;

      // Get transaction hash from caption (optional)
      const transactionHash = ctx.message.caption?.trim();

      const paymentProof = session.awaiting_payment_proof;

      // Clear the session
      delete session.awaiting_payment_proof;

      // Use helper function to process payment verification
      const requestId = await processPaymentVerification(ctx, paymentProof, photoFileId, transactionHash);

      await ctx.reply(
        `✅ *Payment Verification Submitted*\n\n` +
        `🆔 Request ID: \`${requestId}\`\n\n` +
        `Your payment proof has been sent to admin for verification.\n` +
        `You will be notified once it's approved or rejected.\n\n` +
        `If approved, $${paymentProof.amount} will be added to your balance.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    await ctx.reply("❌ Please use the menu options to navigate.");
  });

  // ==========================================
  // TEXT MESSAGE HANDLERS
  // ==========================================

  bot.on("text", async (ctx) => {
    const session = getSession(ctx);
    const text = ctx.message.text.trim();

    // Transaction hash input for payment verification
    if (session.awaiting_payment_proof) {
      // Check if this looks like a transaction hash (flexible validation)
      if (text.length >= 10 && !text.includes(' ') && text.length <= 200) {
        const paymentProof = session.awaiting_payment_proof;

        // Clear the session
        delete session.awaiting_payment_proof;

        // Use helper function to process payment verification
        const requestId = await processPaymentVerification(ctx, paymentProof, null, text);

        await ctx.reply(
          `✅ *Payment Verification Submitted*\n\n` +
          `🆔 Request ID: \`${requestId}\`\n\n` +
          `Your transaction hash has been sent to admin for verification.\n` +
          `You will be notified once it's approved or rejected.\n\n` +
          `If approved, $${paymentProof.amount} will be added to your balance.`,
          { parse_mode: "Markdown" }
        );
        return;
      } else {
        await ctx.reply(
          `❌ Invalid hash format\n\nProvide screenshot or valid transaction hash (10+ chars, no spaces)`,
          { parse_mode: "Markdown" }
        );
        return;
      }
    }

    // Amount input for topup
    if (session.awaiting_amount) {
      session.awaiting_amount = false;

      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) {
        session.awaiting_amount = true;
        return ctx.reply(
          "❌ Invalid amount. Please enter a valid number:\n" +
          "Example: 50",
          { parse_mode: "Markdown" }
        );
      }

      // Show crypto selection for payment
      return ctx.reply(
        `💰 *Top-Up Amount: $${amount}*\n\nSelect your preferred payment method:`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: '₿ Bitcoin (BTC)', callback_data: `pay_BTC_${amount}` },
                { text: '💵 USDT (TRC20)', callback_data: `pay_USDT_TRC20_${amount}` }
              ],
              [
                { text: '💵 USDT (ERC20)', callback_data: `pay_USDT_ERC20_${amount}` },
                { text: '❌ Cancel', callback_data: 'cancel_topup' }
              ]
            ]
          }
        }
      );
    }

    // Domain input handling
    if (session.awaiting_domain) {
      session.awaiting_domain = false;

      // Parse domain, redirect URL, and optional Turnstile key
      const parts = text.trim().split(" ");
      if (parts.length < 2 || parts.length > 3) {
        session.awaiting_domain = true;
        return ctx.reply(
          "❌ Invalid format. Send domain, redirect URL, and Turnstile key:\n" +
            "Format: `domain.com https://fb.com YOUR_TURNSTILE_KEY`\n\n" +
            "Or without custom key: `domain.com https://fb.com`",
          { parse_mode: "Markdown" },
        );
      }

      const [domainInput, redirectUrl, turnstileKey = '0x4AAAAAAB5LyZflvKtbvXXa'] = parts;

      // Enhanced domain validation
      const domainRegex =
        /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/;
      if (!domainRegex.test(domainInput) || domainInput.includes('..') || domainInput.startsWith('-') || domainInput.endsWith('-')) {
        session.awaiting_domain = true;
        return ctx.reply(
          "❌ Invalid domain format. Please enter valid details:\n" +
            "Format: `domain.com https://fb.com YOUR_TURNSTILE_KEY`",
          { parse_mode: "Markdown" },
        );
      }

      // Check rate limit
      if (!checkRateLimit(ctx.from.id)) {
        session.awaiting_domain = true;
        return ctx.reply("⏰ Rate limit exceeded. Please wait a minute before trying again.");
      }

      // Basic URL validation
      if (
        !redirectUrl.startsWith("http://") &&
        !redirectUrl.startsWith("https://")
      ) {
        session.awaiting_domain = true;
        return ctx.reply(
          "❌ Invalid URL format. URL must start with http:// or https://\n" +
            "Format: `domain.com https://fb.com YOUR_TURNSTILE_KEY`",
          { parse_mode: "Markdown" },
        );
      }

      // Validate Turnstile key format (basic validation)
      if (turnstileKey && turnstileKey.length < 10) {
        session.awaiting_domain = true;
        return ctx.reply(
          "❌ Invalid Turnstile key. Please provide a valid Cloudflare Turnstile site key.\n" +
            "Format: `domain.com https://fb.com YOUR_TURNSTILE_KEY`",
          { parse_mode: "Markdown" },
        );
      }

      const domain = domainInput.toLowerCase();
      const requestId = crypto.randomUUID().slice(0, 8);
      const log = L(requestId);

      // Check for admin free access or balance requirement
      const user = await getUserData(ctx.from.id);
      const cost = 80;
      let isAdminFree = false;
      let isSubscriptionUse = false;
      let paymentType = '';

      // Check if user has admin free access or is admin


      if (session.admin_free_access || 
          (process.env.ADMIN_ID && ctx.from.id.toString() === process.env.ADMIN_ID)) {

        isAdminFree = true;
        paymentType = 'VIP Access';
        // Clear the free access flag after use
        if (session.admin_free_access) {
          delete session.admin_free_access;
        }
      } else if (user.subscription.active && user.subscription.domainsUsed < 60 && !session.force_payment) {
        // Use subscription
        isSubscriptionUse = true;
        paymentType = 'Monthly Subscription';
        user.subscription.domainsUsed++;
        saveUserData(ctx.from.id, user);
      } else {
        // Regular payment
        paymentType = 'Pay-per-domain';
        if (user.balance < cost) {
          session.awaiting_domain = true;
          return ctx.reply(
            `💰 *Insufficient Balance*\n\n` +
            `Current Balance: $${user.balance.toFixed(2)}\n` +
            `Required: $${cost.toFixed(2)}\n` +
            `Needed: $${(cost - user.balance).toFixed(2)}\n\n` +
            `Please top up your account and try again.`,
            { parse_mode: "Markdown" }
          );
        }

        // Deduct the cost from user balance
        user.balance -= cost;
        updateUserBalance(ctx.from.id, user.balance);
      }

      // Clear force payment flag
      if (session.force_payment) {
        delete session.force_payment;
      }

      log.info(
        {
          userId: ctx.from.id,
          username: ctx.from.username || "unknown",
          domain,
          redirectUrl,
          requestId,
          cost: isAdminFree ? 0 : cost,
          newBalance: user.balance,
          adminFree: isAdminFree
        },
        isAdminFree ? "🎯 Starting CLS redirect creation - VIP access" : "🎯 Starting CLS redirect creation - $80 deducted",
      );

      let statusMessage;

      if (isAdminFree) {
        statusMessage = await ctx.reply(
          `🎯 *Creating ${domain}*\n\n` +
          `${paymentType} - Free\n` +
          `ID: \`${requestId}\`\n\n` +
          `⏳ Setting up...`,
          { parse_mode: "Markdown" },
        );
      } else if (isSubscriptionUse) {
        statusMessage = await ctx.reply(
          `🎯 *Creating ${domain}*\n\n` +
          `${paymentType} - ${user.subscription.domainsUsed}/60\n` +
          `ID: \`${requestId}\`\n\n` +
          `⏳ Setting up...`,
          { parse_mode: "Markdown" },
        );
      } else {
        statusMessage = await ctx.reply(
          `🎯 *Creating ${domain}*\n\n` +
          `${paymentType}: $${cost}\n` +
          `Balance: $${user.balance.toFixed(2)}\n` +
          `ID: \`${requestId}\`\n\n` +
          `⏳ Setting up...`,
          { parse_mode: "Markdown" },
        );
      }

      try {
        // Step 1: Create cPanel account
        log.info({ domain }, "Starting domain provisioning");
        const { user, password, ip } = await createAccount(domain, log);

        // Update status message
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          `🎯 *CLS Redirect Creator*\n\n` +
          `✅ Hosting created successfully!\n` +
          `🔧 Installing magic scripts...`,
          { parse_mode: "Markdown" }
        );

        // Step 2: Create 3 folders and upload script files
        const urls = [];

        for (let i = 1; i <= 3; i++) {
          const folderName = rInt(100, 999).toString();

          try {
            // Update progress
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              null,
              `🎯 *CLS Redirect Creator*\n\n` +
              `✅ Hosting ready!\n` +
              `🔧 Installing magic scripts... (${i}/3)\n` +
              `⚡ Almost there...`,
              { parse_mode: "Markdown" }
            );

            // Create directory
            await createDirectory(user, folderName);
            log.info({ user, folderName }, "Directory created");

            // Generate and upload script content with user's template preference
            const { content: scriptContent, extension } = await generateCustomScriptContent(redirectUrl, ctx.from.id);
            const fileName = rFile(extension);
            await uploadScriptFile(user, folderName, fileName, scriptContent);

            const url = `https://${domain}/${folderName}/${fileName}`;
            urls.push(url);

            log.info({ user, url, template: extension }, "Script file uploaded");
          } catch (err) {
            log.error(
              { err: err.message, folderName },
              "Failed to create folder or upload file",
            );
            throw new Error(`Failed to setup folder ${i}: ${err.message}`);
          }
        }

        // Step 3: Replace status message with final results
        const responseMessage =
          `✅ *${domain} Ready*\n\n` +
          `🚀 *URLs:*\n` +
          urls.map((url, index) => `${index + 1}. ${url}`).join("\n") +
          "\n\n" +
          `Ask admin for Cloudflare nameservers\n` +
          `Email capture: add ?email= to links`;

        // Replace the status message with final results
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          responseMessage,
          { parse_mode: "Markdown" }
        );

        // Save to user history (without sensitive server details)
        const historyItem = {
          domain: domain,
          redirectUrl: redirectUrl,
          date: new Date(),
          urls: urls
          // Server credentials not stored in user history for security
        };
        addUserHistory(ctx.from.id, historyItem);

        // Update user stats
        const userData = getUserData(ctx.from.id);
        const userHistory = loadUserHistory(ctx.from.id);
        userData.totalDomains = userHistory.length;
        saveUserData(ctx.from.id, userData);

        log.info(
          { domain, urls, ip },
          "Domain provisioning completed successfully",
        );

        // Send admin notification with IP address
        if (process.env.ADMIN_ID && process.env.ADMIN_ID !== "your_telegram_admin_user_id" && bot) {
          try {
            // Get fresh user data to ensure we have current balance
            const currentUserData = getUserData(ctx.from.id);

            await bot.telegram.sendMessage(
              process.env.ADMIN_ID,
              `🎉 *New CLS Redirect Order*\n\n` +
              `👤 User: @${ctx.from.username || 'Unknown'} (${ctx.from.id})\n` +
              `👤 Name: ${ctx.from.first_name || 'Unknown'}\n` +
              `🌐 Domain: \`${domain}\`\n` +
              `🎯 Redirects To: ${redirectUrl}\n` +
              `🖥️ Server IP: \`${ip}\`\n` +
              `💰 Payment: ${paymentType}${isSubscriptionUse ? ` (${currentUserData.subscription.domainsUsed}/60)` : isAdminFree ? ' - Free' : ' - $80'}\n` +
              `📅 Date: ${new Date().toLocaleString()}\n\n` +
              `🚀 Total URLs Created: ${urls.length}\n` +
              `🆔 Request ID: \`${requestId}\`\n\n` +
              `📊 User Balance: $${(currentUserData.balance || 0).toFixed(2)}\n` +
              `🔗 URLs:\n${urls.map((url, i) => `${i + 1}. ${url}`).join('\n')}`,
              { parse_mode: "Markdown" }
            );
            log.info({ requestId, adminId: process.env.ADMIN_ID }, "Admin notification sent successfully");
          } catch (adminError) {
            log.error({ 
              adminError: adminError.message, 
              adminId: process.env.ADMIN_ID,
              requestId,
              userBalance: user.balance
            }, "Failed to send admin notification");
          }
        }
      } catch (error) {
        log.error(
          { error: error.message, domain },
          "Domain provisioning failed",
        );

        // If we have a status message, edit it to show the error
        if (statusMessage) {
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              null,
              `❌ *CLS Redirect Creation Failed*\n\n` +
              `🔧 Technical Error: ${error.message}\n\n` +
              `💡 Don't worry! Use /start to try again.\n` +
              `🆔 Request ID: \`${requestId}\``,
              { parse_mode: "Markdown" }
            );
          } catch (editError) {
            // If editing fails, send a new message
            await ctx.reply(
              `❌ *CLS Redirect Creation Failed*\n\n` +
              `🔧 Technical Error: ${error.message}\n\n` +
              `💡 Don't worry! Use /start to try again.\n` +
              `🆔 Request ID: \`${requestId}\``,
              { parse_mode: "Markdown" },
            );
          }
        } else {
          await ctx.reply(
            `❌ *CLS Redirect Creation Failed*\n\n` +
            `🔧 Technical Error: ${error.message}\n\n` +
            `💡 Don't worry! Use /start to try again.\n` +
            `🆔 Request ID: \`${requestId}\``,
            { parse_mode: "Markdown" },
          );
        }
      }

      // Clear session
      sessions.delete(ctx.from.id);
    } else {
      // No active session
      return ctx.reply("Please use /start to begin domain provisioning.");
    }
  });

  // ==========================================
  // INLINE KEYBOARD CALLBACK HANDLERS
  // ==========================================

bot.on('callback_query', async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    const session = getSession(ctx);
    const user = getUserData(ctx.from.id);

    // Always answer callback query first to remove loading state
    await ctx.answerCbQuery();

    try {
      // Handle main menu actions
      if (callbackData === 'topup') {
        const user = await getUserData(ctx.from.id);
        session.awaiting_amount = true;
        return ctx.editMessageText(
          `💎 *Balance*: $${user.balance.toFixed(2)}\n\nEnter USD amount:`,
          { parse_mode: "Markdown" }
        );
      }

      if (callbackData === 'subscription') {
        const user = await getUserData(ctx.from.id);

        if (user.subscription.active) {
          const endDate = new Date(user.subscription.endDate);
          const daysLeft = Math.ceil((endDate - new Date()) / (1000 * 60 * 60 * 24));
          const currentPrice = user.subscription.isFirstTime ? '$200' : '$200';

          return ctx.editMessageText(
            `⭐ *Subscription Active*\n\n` +
            `📅 Expires: ${endDate.toDateString()} (${daysLeft} days)\n` +
            `🎯 Used: ${user.subscription.domainsUsed}/60`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🎯 Create Domain', callback_data: 'redirect' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        } else {
          // Check if this is user's first subscription
        const isFirstTime = !user.subscription.hasEverSubscribed;
        const subscriptionPrice = isFirstTime ? 250 : 200;
        const savings = (60 * 80) - subscriptionPrice;

        return ctx.editMessageText(
            `⭐ ⭐ *Monthly Plan - $250*\n*Renewal - $200*`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  user.balance >= subscriptionPrice ? 
                    [{ text: `⭐ Subscribe Now ($${subscriptionPrice})`, callback_data: 'subscribe_monthly' }] :
                    [{ text: '💳 Add Funds First', callback_data: 'topup' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        }
      }

      if (callbackData === 'redirect') {
        const user = await getUserData(ctx.from.id);
        const requiredAmount = 80;

        // Check if user has admin free access or is admin
        const hasAdminAccess = session.admin_free_access || 
                              (process.env.ADMIN_ID && ctx.from.id.toString() === process.env.ADMIN_ID);

        // Check if user has active subscription
        const hasSubscription = user.subscription.active && user.subscription.domainsUsed < 60;

        if (!hasAdminAccess && !hasSubscription && user.balance < requiredAmount) {
          return ctx.editMessageText(
            `💎 *CLS Redirect Service*\n\n` +
            `💰 *Insufficient Balance*\n` +
            `Current Balance: $${user.balance.toFixed(2)}\n` +
            `Service Cost: $${requiredAmount.toFixed(2)}\n` +
            `Additional Needed: $${(requiredAmount - user.balance).toFixed(2)}\n\n`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '⭐ View Subscription', callback_data: 'subscription' }],
                  [{ text: '💳 Add Funds', callback_data: 'topup' }],
                  [{ text: '🔑 Request VIP Access', callback_data: 'admin_access' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        }

        if (!hasAdminAccess && hasSubscription && user.subscription.domainsUsed >= 60) {
          return ctx.editMessageText(
            `⭐ *Subscription Limit Reached*\n\n` +
            `🎯 You've used all for this month.\n` +
            `📅 Your subscription renews on ${new Date(user.subscription.endDate).toDateString()}\n\n` +
            `💡 You can still create domains with pay-per-use ($80 each) or wait for renewal.`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  user.balance >= 80 ? 
                    [{ text: '💳 Pay Per Domain ($80)', callback_data: 'redirect_payperuse' }] :
                    [{ text: '💳 Add Funds', callback_data: 'topup' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        }

        session.awaiting_domain = true;

        if (hasAdminAccess) {
          return ctx.editMessageText(
            "🎯 *CLS Redirect Creator*\n\n" +
              "✨ *Format:* `domain.com target-url`\n" +
              "📝 *Example:* `mysite.com https://facebook.com`\n\n" +
              "🚀 Your redirect will be live in seconds!",
            { parse_mode: "Markdown" }
          );
        } else {
          return ctx.editMessageText(
            "🎯 *CLS Redirect Creator*\n\n" +
              "✨ *Format:* `domain.com target-url`\n" +
              "📝 *Example:* `mysite.com https://facebook.com`\n\n" +
              `💰 *Service Cost:* $${requiredAmount}\n` +
              "🚀 Your redirect will be live in seconds!",
            { parse_mode: "Markdown" }
          );
        }
      }

      if (callbackData === 'profile') {
        const user = await getUserData(ctx.from.id);
        const userHistory = await loadUserHistory(ctx.from.id);

        // Calculate total clicks across all user domains
        let totalClicks = 0;
        if (Array.isArray(userHistory)) {
          totalClicks = userHistory.reduce((total, domain) => {
            return total + getDomainClicks(domain.domain);
          }, 0);
        }

        let subscriptionStatus = '';
        if (user.subscription.active) {
          const endDate = new Date(user.subscription.endDate);
          const daysLeft = Math.ceil((endDate - new Date()) / (1000 * 60 * 60 * 24));
          subscriptionStatus = `⭐ *Subscription:* Active (${daysLeft} days left)\n` +
                             `🎯 *Domains Used:* ${user.subscription.domainsUsed}/60\n`;
        } else {
          subscriptionStatus = `⭐ *Subscription:* Inactive\n`;
        }

        const accountType = user.subscription.active ? '⭐ Subscriber' : (user.balance > 0 ? '💎 Premium' : '🆓 Free Tier');

        return ctx.editMessageText(
          `👤 *CLS Account Profile*\n\n` +
          `🆔 Account ID: \`${ctx.from.id}\`\n` +
          `👋 Name: ${ctx.from.first_name || 'CLS User'}\n` +
          `💰 Account Balance: $${user.balance.toFixed(2)}\n` +
          `📅 Member Since: ${user.joinDate.toDateString()}\n` +
          `🎯 Total Redirects: ${userHistory.length}\n` +
          `👆 Total Clicks: ${totalClicks}\n` +
          subscriptionStatus +
          `⭐ Account Type: ${accountType}\n\n` +
          `🚀 *CLS Services Used:*\n` +
          `• Professional redirect, SSL certificate, Autograb email, Real-time click tracking`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
              ]
            }
          }
        );
      }

      if (callbackData === 'history') {
        const userHistory = await loadUserHistory(ctx.from.id);

        if (!Array.isArray(userHistory) || userHistory.length === 0) {
          return ctx.editMessageText(
            `📊 *CLS Redirect History*\n\n` +
            `🎯 No redirects created yet.\n` +
            `Ready to create your first professional redirect?\n\n` +
            `Click "🎯 Create Redirect" to get started!`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🎯 Create First Redirect', callback_data: 'redirect' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        }

        const historyText = userHistory
          .slice(-10) // Show last 10 domains
          .map((domain, index) => {
            const clicks = getDomainClicks(domain.domain);
            return `${index + 1}. 🌐 \`${domain.domain}\`\n` +
            `   📅 ${domain.date.toDateString()}\n` +
            `   🎯 ➜ ${domain.redirectUrl}\n` +
            `   👆 Clicks: ${clicks}\n`;
          })
          .join('\n');

        return ctx.editMessageText(
          `📊 *CLS Redirect History*\n\n` +
          `🎯 *Recent Redirects* (Last ${Math.min(userHistory.length, 10)})\n\n` +
          historyText +
          `\n\n✨ Total CLS Redirects Created: ${userHistory.length}\n` +
          `🚀 All with professional loading pages & SSL`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
              ]
            }
          }
        );
      }


      // Handle template settings
      if (callbackData === 'template_settings') {
        const user = await getUserData(ctx.from.id);
        const currentTemplate = user.templateType || 'html';
        
        return ctx.editMessageText(
          `⚙️ *Template Settings*\n\n` +
          `Current Template: *${currentTemplate.toUpperCase()}*\n\n` +
          `📄 *HTML Template*\n` +
          `• Works on any hosting\n` +
          `• Client-side only\n` +
          `• Cloudflare Turnstile protection\n\n` +
          `🔐 *PHP Template*\n` +
          `• Requires PHP hosting\n` +
          `• Server-side bot detection\n` +
          `• Redirects bots to Google before page loads\n` +
          `• Includes all HTML features\n\n` +
          `Choose your preferred template type:`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: currentTemplate === 'html' ? '✅ HTML' : '📄 HTML', callback_data: 'set_template_html' },
                  { text: currentTemplate === 'php' ? '✅ PHP' : '🔐 PHP', callback_data: 'set_template_php' }
                ],
                [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
              ]
            }
          }
        );
      }

      // Handle template type selection
      if (callbackData === 'set_template_html' || callbackData === 'set_template_php') {
        const user = await getUserData(ctx.from.id);
        const newTemplate = callbackData === 'set_template_html' ? 'html' : 'php';
        
        user.templateType = newTemplate;
        await saveUserData(ctx.from.id, user);
        
        return ctx.editMessageText(
          `✅ *Template Updated!*\n\n` +
          `Your template has been set to: *${newTemplate.toUpperCase()}*\n\n` +
          `All new redirects will use the ${newTemplate.toUpperCase()} template.`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: '⚙️ Change Template', callback_data: 'template_settings' }],
                [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
              ]
            }
          }
        );
      }

      // Handle admin access request
      if (callbackData === 'admin_access') {
        const user = getUserData(ctx.from.id);

        // Check if user is admin - gets free access
        const log = L("admin-access");


        log.info({
          userId: ctx.from.id,
          adminId: process.env.ADMIN_ID,
          userIdStr: ctx.from.id.toString(),
          isMatch: ctx.from.id.toString() === process.env.ADMIN_ID
        }, "Admin access check");

        if (process.env.ADMIN_ID && ctx.from.id.toString() === process.env.ADMIN_ID) {
          session.awaiting_domain = true;
          session.admin_free_access = true;

          return ctx.editMessageText(
            "🔑 *Admin Access - Free Access Granted*\n\n" +
            "✨ Send: `domain.com redirect-url`\n" +
            "📝 Example: `mysite.com https://fb.com`\n\n" +
            "💎 Free access for admin - no payment required",
            { parse_mode: "Markdown" }
          );
        }

        // For regular users - send approval request to admin
        const requestId = crypto.randomUUID().slice(0, 8);
        const adminRequest = {
          id: requestId,
          userId: ctx.from.id,
          username: ctx.from.username || 'Unknown',
          firstName: ctx.from.first_name || 'Unknown',
          type: 'admin_access',
          date: new Date(),
          status: 'pending'
        };

        adminRequests.set(requestId, adminRequest);

        // Send to admin for approval
        if (process.env.ADMIN_ID && process.env.ADMIN_ID !== "your_telegram_admin_user_id") {
          try {
            const adminKeyboard = {
              inline_keyboard: [
                [
                  { text: '✅ Grant Access', callback_data: `grant_access_${requestId}` },
                  { text: '❌ Deny Access', callback_data: `deny_access_${requestId}` }
                ]
              ]
            };

            await bot.telegram.sendMessage(
              process.env.ADMIN_ID,
              `🔑 *Admin Access Request*\n\n` +
              `👤 User: @${adminRequest.username} (${adminRequest.userId})\n` +
              `👋 Name: ${adminRequest.firstName}\n` +
              `📅 Date: ${adminRequest.date.toLocaleString()}\n` +
              `🆔 Request ID: \`${requestId}\`\n\n` +
              `User is requesting free domain provisioning access.`,
              { 
                parse_mode: "Markdown",
                reply_markup: adminKeyboard
              }
            );
          } catch (adminError) {
            console.log("Failed to send admin notification");
          }
        }

        return ctx.editMessageText(
          `🔑 *Admin Access Request Submitted*\n\n` +
          `🆔 Request ID: \`${requestId}\`\n\n` +
          `⏳ Your request has been sent to admin for approval.\n` +
          `You willbe notified once it's processed.\n\n` +
          `If approved, you'll get free domain provisioning access.`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
              ]
            }
          }
        );
      }

      // Handle crypto selection
      if (callbackData.startsWith('select_')) {
        const cryptoType = callbackData.replace('select_', '');
        session.selected_crypto = cryptoType;
        session.awaiting_amount = true;

        const cryptoNames = {
          'BTC': '₿ Bitcoin (BTC)',
          'USDT_TRC20': '🟡 Tether TRC20',
          'USDT_ERC20': '💎 USDT ERC20'
        };

        return ctx.editMessageText(
          `💰 *${cryptoNames[cryptoType]}*\n\n` +
          `Please enter the amount you want to top up (in USD):\n\n` +
          `Example: 50`,
          { parse_mode: "Markdown" }
        );
      }

      // Handle crypto payment selection
      if (callbackData.startsWith('pay_')) {
        const parts = callbackData.split('_');
        let cryptoType, amount;

        if (parts.length === 4) {
          // Format: pay_USDT_TRC20_50 or pay_USDT_ERC20_50
          cryptoType = `${parts[1]}_${parts[2]}`;
          amount = parts[3];
        } else {
          // Format: pay_BTC_50
          cryptoType = parts[1];
          amount = parts[2];
        }

        const usdAmount = parseFloat(amount);
        const paymentData = await generateTopUpMessage(usdAmount, cryptoType);

        await ctx.editMessageText(paymentData.text, { 
          parse_mode: "Markdown",
          reply_markup: paymentData.keyboard
        });
        return;
      }

      // Handle payment confirmation
      if (callbackData.startsWith('paid_')) {
        const parts = callbackData.split('_');
        let cryptoType, amount;

        if (parts.length === 4) {
          cryptoType = `${parts[1]}_${parts[2]}`;
          amount = parts[3];
        } else {
          cryptoType = parts[1];
          amount = parts[2];
        }

        const session = getSession(ctx);
        session.awaiting_payment_proof = {
          cryptoType,
          amount: parseFloat(amount)
        };

        await ctx.editMessageText(
          `📸 *Payment Confirmation Required*\n\n` +
          `Please provide either:\n` +
          `📷 Screenshot of your payment confirmation\n` +
          `OR\n` +
          `🔗 Transaction hash (TXID)\n\n` +
          `For screenshot, it should show:\n` +
          `• Payment amount: $${amount}\n` +
          `• Destination address\n` +
          `• Transaction confirmation\n\n` +
          `*You can add transaction hash as caption or send it separately*`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // Handle payment cancellation
      if (callbackData === 'cancel_payment') {
        await ctx.editMessageText(
          "❌ Payment cancelled. Use /start to return to main menu.",
          { parse_mode: "Markdown" }
        );
        return;
      }

      // Handle topup cancellation
      if (callbackData === 'cancel_topup') {
        await ctx.editMessageText(
          "❌ Top-up cancelled. Use /start to return to main menu.",
          { parse_mode: "Markdown" }
        );
        return;
      }

      // Handle payment approval
      if (callbackData.startsWith('approve_payment_')) {
        const requestId = callbackData.replace('approve_payment_', '');
        const userIdParts = requestId.split('_');

        if (userIdParts.length < 2 || !userIdParts[1]) {
          await ctx.answerCbQuery('Invalid payment request format', { show_alert: true });
          return;
        }

        const userId = userIdParts[1];

        await ctx.answerCbQuery('Processing payment approval...');

        try {
          // Read user data from file
          const userDataDir = path.join(__dirname, 'user_data');
          const userFilePath = path.join(userDataDir, `${userId}.json`);

          if (!fs.existsSync(userFilePath)) {
            await ctx.answerCbQuery('User data not found', { show_alert: true });
            return;
          }

          const userData = JSON.parse(fs.readFileSync(userFilePath, 'utf8'));
          const paymentRequest = userData.pending_payments?.find(p => p.id === requestId);

          if (paymentRequest && paymentRequest.status === 'pending') {
            // Add amount to user balance
            userData.balance = (userData.balance || 0) + paymentRequest.amount;

            // Mark payment as approved
            paymentRequest.status = 'approved';
            paymentRequest.approved_at = new Date().toISOString();

            // Auto-activate subscription if payment matches subscription pricing
            const isSubscriptionPayment = paymentRequest.amount === 250 || paymentRequest.amount === 200;
            if (isSubscriptionPayment && !userData.subscription.active) {
              const isFirstTime = paymentRequest.amount === 250;
              
              // Activate subscription
              userData.subscription.active = true;
              userData.subscription.startDate = new Date().toISOString();
              userData.subscription.endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
              userData.subscription.domainsUsed = 0;
              userData.subscription.hasEverSubscribed = true;
              userData.subscription.isFirstTime = !isFirstTime;
              
              // Deduct subscription cost from balance
              userData.balance -= paymentRequest.amount;
              
              console.log(`Auto-activated subscription for user ${userId}: ${isFirstTime ? 'First-time' : 'Renewal'} - $${paymentRequest.amount}`);
            }

            // Save updated user data to both file and database
            fs.writeFileSync(userFilePath, JSON.stringify(userData, null, 2));

            // Update Replit database directly (avoid getUserData conflict)
            if (db) {
              try {
                await db.set(`user_${userId}`, userData);
                console.log(`User ${userId} balance updated in database: $${userData.balance}`);
              } catch (dbError) {
                console.error('Failed to update database:', dbError.message);
              }
            }

            // Notify user
            try {
              const subscriptionActivated = isSubscriptionPayment && userData.subscription.active;
              let userMessage = `✅ *Payment Approved!*\n\n` +
                `💰 Amount: $${paymentRequest.amount}\n` +
                `💳 Balance: $${userData.balance.toFixed(2)}\n\n`;
              
              if (subscriptionActivated) {
                const endDate = new Date(userData.subscription.endDate);
                userMessage += `⭐ *Monthly Subscription Activated!*\n\n` +
                  `📅 Valid until: ${endDate.toDateString()}\n` +
                  `🎯 Domains included: 60\n` +
                  `✨ Ready to create unlimited domains!\n\n` +
                  `Use /start to create your first domain.`;
              } else {
                userMessage += `Your payment has been verified and added to your account.\n` +
                  `You can now use your balance for domain provisioning.`;
              }
              
              await bot.telegram.sendMessage(userId, userMessage, { parse_mode: "Markdown" });
            } catch (userError) {
              console.log("Failed to notify user of payment approval:", userError.message);
            }

            // Send confirmation to admin
            await ctx.answerCbQuery('✅ Payment approved successfully!', { show_alert: true });

            let adminMessage = `✅ *Payment Approved Successfully*\n\n` +
              `💰 Amount: $${paymentRequest.amount}\n` +
              `👤 User ID: ${userId}\n` +
              `💳 User's New Balance: $${userData.balance.toFixed(2)}\n` +
              `🆔 Request ID: \`${requestId}\`\n\n`;
            
            if (isSubscriptionPayment && userData.subscription.active) {
              const endDate = new Date(userData.subscription.endDate);
              const subscriptionType = paymentRequest.amount === 250 ? 'First-time' : 'Renewal';
              adminMessage += `⭐ *Subscription Auto-Activated*\n` +
                `📋 Type: ${subscriptionType} ($${paymentRequest.amount})\n` +
                `📅 Valid until: ${endDate.toDateString()}\n` +
                `🎯 Domains available: 60\n\n`;
            }
            
            adminMessage += `User has been notified and ${isSubscriptionPayment && userData.subscription.active ? 'subscription activated' : 'balance updated'}.`;

            await bot.telegram.sendMessage(ctx.from.id, adminMessage, { parse_mode: "Markdown" });
          } else {
            await bot.telegram.sendMessage(
              ctx.from.id,
              "❌ Payment request not found or already processed."
            );
          }
        } catch (error) {
          console.error('Payment approval error:', error);
          await bot.telegram.sendMessage(
            ctx.from.id,
            "❌ Error processing payment approval. Please check logs."
          );
        }
        return;
      }

      // Handle payment rejection
      if (callbackData.startsWith('reject_payment_')) {
        const requestId = callbackData.replace('reject_payment_', '');
        const userIdParts = requestId.split('_');

        if (userIdParts.length < 2 || !userIdParts[1]) {
          await ctx.answerCbQuery('Invalid payment request format', { show_alert: true });
          return;
        }

        const userId = userIdParts[1];

        await ctx.answerCbQuery('Processing payment rejection...');

        try {
          // Read user data from file
          const userDataDir = path.join(__dirname, 'user_data');
          const userFilePath = path.join(userDataDir, `${userId}.json`);

          if (!fs.existsSync(userFilePath)) {
            await ctx.answerCbQuery('User data not found', { show_alert: true });
            return;
          }

          const userData = JSON.parse(fs.readFileSync(userFilePath, 'utf8'));
          const paymentRequest = userData.pending_payments?.find(p => p.id === requestId);

          if (paymentRequest && paymentRequest.status === 'pending') {
            // Mark payment as rejected
            paymentRequest.status = 'rejected';
            paymentRequest.rejected_at = new Date().toISOString();

            // Save updated user data
            fs.writeFileSync(userFilePath, JSON.stringify(userData, null, 2));

            // Notify user
            try {
              await bot.telegram.sendMessage(userId, 
                `❌ *Payment Rejected*\n\n` +
                `💰 Amount: $${paymentRequest.amount}\n` +
                `🆔 Request ID: \`${requestId}\`\n\n` +
                `Your payment verification was rejected.\n` +
                `Please ensure you sent the correct amount and provide valid proof.\n\n` +
                `Contact support if you believe this is an error.`,
                { parse_mode: "Markdown" }
              );
            } catch (userError) {
              console.log("Failed to notify user of payment rejection");
            }

            // Send confirmation to admin
            await ctx.answerCbQuery('❌ Payment rejected!', { show_alert: true });

            await bot.telegram.sendMessage(
              ctx.from.id,
              `❌ *Payment Rejected*\n\n` +
              `💰 Amount: $${paymentRequest.amount}\n` +
              `👤 User ID: ${userId}\n` +
              `🆔 Request ID: \`${requestId}\`\n\n` +
              `User has been notified of the rejection.`,
              { parse_mode: "Markdown" }
            );
          } else {
            await bot.telegram.sendMessage(
              ctx.from.id,
              "❌ Payment request not found or already processed."
            );
          }
        } catch (error) {
          console.error('Payment rejection error:', error);
          await bot.telegram.sendMessage(
            ctx.from.id,
            "❌ Error processing payment rejection. Please check logs."
          );
        }
        return;
      }

      // Handle subscription purchase
      if (callbackData === 'subscribe_monthly') {
        const user = await getUserData(ctx.from.id);

        // Determine pricing based on first-time status
        const isFirstTime = !user.subscription.hasEverSubscribed;
        const subscriptionPrice = isFirstTime ? 250 : 200;

        if (user.balance < subscriptionPrice) {
          return ctx.editMessageText(
            `❌ *Need $${(subscriptionPrice - user.balance).toFixed(2)} more*\n\n` +
            `Required: $${subscriptionPrice}\nBalance: $${user.balance.toFixed(2)}`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '💳 Add Funds', callback_data: 'topup' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        }

        if (user.subscription.active) {
          return ctx.editMessageText(
            `⭐ *Already Subscribed*\n\n` +
            `You already have an active subscription.\n` +
            `Wait for it to expire before renewing.`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        }

        // Activate subscription
        user.balance -= subscriptionPrice;
        user.subscription.active = true;
        user.subscription.startDate = new Date();
        user.subscription.endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
        user.subscription.domainsUsed = 0;
        user.subscription.isFirstTime = isFirstTime;
        user.subscription.hasEverSubscribed = true;

        updateUserBalance(ctx.from.id, user.balance);
        saveUserData(ctx.from.id, user);

        // Notify admin
        if (process.env.ADMIN_ID && bot) {
          try {
            await bot.telegram.sendMessage(
              process.env.ADMIN_ID,
              `⭐ *New Monthly Subscription*\n\n` +
              `👤 User: @${ctx.from.username || 'Unknown'} (${ctx.from.id})\n` +
              `👤 Name: ${ctx.from.first_name || 'Unknown'}\n` +
              `💰 Amount: $${subscriptionPrice} ${isFirstTime ? '(First-time)' : '(Renewal)'}\n` +
              `📅 Start: ${user.subscription.startDate.toDateString()}\n` +
              `📅 End: ${user.subscription.endDate.toDateString()}\n` +
              `💳 New Balance: $${user.balance.toFixed(2)}`,
              { parse_mode: "Markdown" }
            );
          } catch (error) {
            console.log("Failed to notify admin of subscription");
          }
        }

        
        const savings = (60 * 80) - subscriptionPrice;

        return ctx.editMessageText(
          `✅ *Subscription Active*\n\n` +
          `Redirect Available\n` +
          `Expires: ${user.subscription.endDate.toDateString()}\n` +
          `Balance: $${user.balance.toFixed(2)}`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: '🎯 Create First Domain', callback_data: 'redirect' }],
                [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
              ]
            }
          }
        );
      }

      // Handle pay-per-use redirect when subscription is exhausted
      if (callbackData === 'redirect_payperuse') {
        const user = await getUserData(ctx.from.id);
        if (user.balance < 80) {
          return ctx.editMessageText(
            `💰 *Insufficient Balance*\n\n` +
            `Required: $80\n` +
            `Current Balance: $${user.balance.toFixed(2)}`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '💳 Add Funds', callback_data: 'topup' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        }

        session.awaiting_domain = true;
        session.force_payment = true; // Force payment even if subscription exists

        return ctx.editMessageText(
          "🎯 *Pay Per Use - $80*\n\n" +
            "Format: `domain.com target-url`",
          { parse_mode: "Markdown" }
        );
      }

      // Handle back to menu
      if (callbackData === 'back_menu') {
        // Clear any pending sessions
        Object.keys(session).forEach(key => delete session[key]);

        return ctx.editMessageText(
          `🏠 *Main Menu*`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '💳 Top Up', callback_data: 'topup' },
                  { text: '🎯 Create Redirect', callback_data: 'redirect' }
                ],
                [
                  { text: '⭐ Monthly Subscription', callback_data: 'subscription' },
                  { text: '👤 Profile', callback_data: 'profile' }
                ],
                [
                  { text: '📊 My Redirects', callback_data: 'history' },
                  { text: '🔑 VIP Access Request', callback_data: 'admin_access' }
                ]
              ]
            }
          }
        );
      }
    } catch (error) {
      console.log('Callback error:', error.message);
    }

    // Handle admin access approval/denial callbacks
    if (callbackData.startsWith('grant_access_') || callbackData.startsWith('deny_access_')) {
      const [action, , requestId] = callbackData.split('_');
      const request = adminRequests.get(requestId);

      if (!request) {
        return;
      }

      if (action === 'grant') {
        // Grant free admin access to user
        const userSession = sessions.get(request.userId) || {};
        userSession.admin_free_access = true;
        sessions.set(request.userId, userSession);

        request.status = 'approved';

        // Notify user
        try {
          await bot.telegram.sendMessage(
            request.userId,
            `✅ *Admin Access Granted!*\n\n` +
            `🆔 Request ID: \`${requestId}\`\n\n` +
            `You now have free domain provisioning access.\n` +
            `Use "🔗 Get Redirect" to provision your domain without payment.`,
            { parse_mode: "Markdown" }
          );
        } catch (error) {
          console.log("Failed to notify user");
        }

        await ctx.editMessageText(
          `✅ *ACCESS GRANTED*\n\n${ctx.callbackQuery.message.text.replace('🔑 *Admin Access Request*', '🔑 *Admin Access Request - GRANTED*')}`,
          { parse_mode: "Markdown" }
        );

      } else if (action === 'deny') {
        request.status = 'denied';

        // Notify user
        try {
          await bot.telegram.sendMessage(
            request.userId,
            `❌ *Admin Access Denied*\n\n` +
            `🆔 Request ID: \`${requestId}\`\n\n` +
            `Your admin access request has been denied.`,
            { parse_mode: "Markdown" }
          );
        } catch (error) {
          console.log("Failed to notify user");
        }

        await ctx.editMessageText(
          `❌ *ACCESS DENIED*\n\n${ctx.callbackQuery.message.text.replace('🔑 *Admin Access Request*', '🔑 *Admin Access Request - DENIED*')}`,
          { parse_mode: "Markdown" }
        );
      }
    }

    // Handle admin approval/rejection callbacks for topups
    if (callbackData.startsWith('approve_') || callbackData.startsWith('reject_')) {
      const [action, requestId] = callbackData.split('_');
      const request = topupRequests.get(requestId);

      if (!request) {
        return ctx.answerCbQuery('Request not found');
      }

      if (action === 'approve') {
        // Update user balance
        const userData = getUserData(request.userId);
        userData.balance += request.amount;
        request.status = 'approved';

        // Notify user
        try {
          await bot.telegram.sendMessage(
            request.userId,
            `✅ *Top-Up Approved!*\n\n` +
            `💰 Amount: $${request.amount}\n` +
            `💳 New Balance: $${userData.balance.toFixed(2)}\n\n` +
            `🆔 Request ID: \`${requestId}\`\n\n` +
            `Thank you! Your account has been credited.`,
            { parse_mode: "Markdown" }
          );
        } catch (error) {
          console.log("Failed to notify user");
        }

        await ctx.editMessageText(
          `✅ *APPROVED*\n\n${ctx.callbackQuery.message.text.replace('💳 *New Top-Up Request*', '💳 *Top-Up Request - APPROVED*')}`,
          { parse_mode: "Markdown" }
        );

        await ctx.answerCbQuery('✅ Top-up approved!');

      } else if (action === 'reject') {
        request.status = 'rejected';

        // Notify user
        try {
          await bot.telegram.sendMessage(
            request.userId,
            `❌ *Top-Up Rejected*\n\n` +
            `💰 Amount: $${request.amount}\n` +
            `🆔 Request ID: \`${requestId}\`\n\n` +
            `Your top-up request has been rejected. Please contact support if you have questions.`,
            { parse_mode: "Markdown" }
          );
        } catch (error) {
          console.log("Failed to notify user");
        }

        await ctx.editMessageText(
          `❌ *REJECTED*\n\n${ctx.callbackQuery.message.text.replace('💳 *New Top-Up Request*', '💳 *Top-Up Request - REJECTED*')}`,
          { parse_mode: "Markdown" }
        );

        await ctx.answerCbQuery('❌ Top-up rejected!');
      }
    }
  });

  // Enhanced error handling with categorization
  bot.catch(async (err, ctx) => {
    const errorId = crypto.randomUUID().slice(0, 8);
    const log = L("bot-error");

    // Categorize errors
    const errorType = err.code || err.name || 'UnknownError';
    const isCritical = ['ECONNRESET', 'ETIMEDOUT', 'NetworkError'].includes(errorType);

    log.error(
      {
        errorId,
        errorType,
        error: err.message,
        stack: err.stack,
        userId: ctx.from?.id,
        username: ctx.from?.username || "unknown",
        chatId: ctx.chat?.id,
        messageText: ctx.message?.text || "unknown",
        isCritical,
      },
      "💥 Bot error occurred",
    );

    // Send to admin if critical
    if (isCritical && process.env.ADMIN_ID) {
      try {
        await bot.telegram.sendMessage(
          process.env.ADMIN_ID,
          `🚨 *Critical Bot Error*\n\n` +
          `🆔 Error ID: \`${errorId}\`\n` +
          `⚠️ Type: ${errorType}\n` +
          `👤 User: ${ctx.from?.id || 'unknown'}\n` +
          `💬 Message: ${err.message}`,
          { parse_mode: "Markdown" }
        );
      } catch (adminError) {
        log.error({ adminError: adminError.message }, "Failed to notify admin of critical error");
      }
    }

    // User-friendly error response
    const userMessage = isCritical ? 
      "🔧 *System temporarily unavailable*\n\nPlease try again in a few minutes." :
      "❌ *Something went wrong*\n\nPlease try again with /start.\n\n" +
      `🆔 Error ID: \`${errorId}\``;

    return ctx.reply(userMessage, { parse_mode: "Markdown" });
  });

  // Webhook endpoint
  app.use(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, bot.webhookCallback("/"));
}

// ==========================================
// EXPRESS SERVER & API ENDPOINTS
// ==========================================

// Health check endpoint
app.get("/health", (req, res) => {
  const log = L("health-check");
  const healthData = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    botStatus: bot ? "active" : "inactive",
    environment: process.env.NODE_ENV || "development",
  };

  log.debug(healthData, "💊 Health check requested");
  res.json(healthData);
});

// Removed unused API endpoints for cleaner codebase

// ==========================================
// SERVER STARTUP & SHUTDOWN HANDLERS
// ==========================================

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, "0.0.0.0", () => {
  const log = L("server");
  log.info({ port: PORT }, "Server started");

  // Use polling in development only if bot is initialized
  if (process.env.NODE_ENV !== "production" && bot) {
    bot.launch();
    log.info("Bot started with polling");
  } else if (!bot) {
    log.info("Bot not initialized - Telegram token missing. Dashboard available at /dashboard");
  }
});

// Graceful shutdown handlers
process.once("SIGINT", () => {
  const log = L("shutdown");
  log.info("Shutting down gracefully");
  if (bot) bot.stop("SIGINT");
  server.close();
});

process.once("SIGTERM", () => {
  const log = L("shutdown");
  log.info("Shutting down gracefully");
  if (bot) bot.stop("SIGTERM");
  server.close();
});