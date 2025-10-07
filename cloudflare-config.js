
const axios = require('axios');

class CloudflareConfig {
  constructor(email, globalKey) {
    this.email = email;
    this.globalKey = globalKey;
    this.baseURL = 'https://api.cloudflare.com/client/v4';
    
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        'X-Auth-Email': email,
        'X-Auth-Key': globalKey,
        'Content-Type': 'application/json'
      }
    });
  }

  // List all domains in Cloudflare account
  async listDomains() {
    try {
      const response = await this.client.get('/zones');
      if (response.data.success) {
        return response.data.result.map(zone => ({
          id: zone.id,
          name: zone.name,
          status: zone.status
        }));
      }
      throw new Error('Failed to fetch domains');
    } catch (error) {
      throw new Error(`Cloudflare API Error: ${error.message}`);
    }
  }

  // Configure all security settings for a domain
  async configureSecuritySettings(zoneId) {
    const results = {
      alwaysUseHttps: false,
      autoHttpsRewrites: false,
      botFightMode: false,
      browserIntegrityCheck: false,
      securityLevel: false
    };

    try {
      // 1. Always Use HTTPS
      await this.client.patch(`/zones/${zoneId}/settings/always_use_https`, {
        value: 'on'
      });
      results.alwaysUseHttps = true;

      // 2. Automatic HTTPS Rewrites
      await this.client.patch(`/zones/${zoneId}/settings/automatic_https_rewrites`, {
        value: 'on'
      });
      results.autoHttpsRewrites = true;

      // 3. Bot Fight Mode
      await this.client.patch(`/zones/${zoneId}/settings/bot_fight_mode`, {
        value: 'on'
      });
      results.botFightMode = true;

      // 4. Browser Integrity Check
      await this.client.patch(`/zones/${zoneId}/settings/browser_check`, {
        value: 'on'
      });
      results.browserIntegrityCheck = true;

      // 5. Security Level - set to High
      await this.client.patch(`/zones/${zoneId}/settings/security_level`, {
        value: 'high'
      });
      results.securityLevel = true;

      return results;
    } catch (error) {
      console.error('Error configuring security settings:', error.message);
      throw error;
    }
  }

  // Get current security settings
  async getSecuritySettings(zoneId) {
    try {
      const settings = await this.client.get(`/zones/${zoneId}/settings`);
      
      const settingsMap = {};
      settings.data.result.forEach(setting => {
        settingsMap[setting.id] = setting.value;
      });

      return {
        alwaysUseHttps: settingsMap.always_use_https,
        autoHttpsRewrites: settingsMap.automatic_https_rewrites,
        botFightMode: settingsMap.bot_fight_mode,
        browserIntegrityCheck: settingsMap.browser_check,
        securityLevel: settingsMap.security_level
      };
    } catch (error) {
      throw new Error(`Failed to get settings: ${error.message}`);
    }
  }
}

module.exports = CloudflareConfig;
