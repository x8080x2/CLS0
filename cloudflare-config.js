
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
      securityLevel: false,
      sslEnabled: false,
      universalSSL: false
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

      // 6-7. Activate SSL/TLS
      const sslResult = await this.activateSSL(zoneId);
      results.sslEnabled = sslResult.success;
      results.universalSSL = sslResult.success;

      return results;
    } catch (error) {
      console.error('Error configuring security settings:', error.message);
      throw error;
    }
  }

  // Activate SSL certificate for a domain
  async activateSSL(zoneId) {
    try {
      // Enable Universal SSL
      await this.client.patch(`/zones/${zoneId}/settings/universal_ssl`, {
        enabled: true
      });

      // Set SSL mode to Full (strict) for best security
      await this.client.patch(`/zones/${zoneId}/settings/ssl`, {
        value: 'full'
      });

      // Enable TLS 1.3
      await this.client.patch(`/zones/${zoneId}/settings/tls_1_3`, {
        value: 'on'
      });

      // Enable Opportunistic Encryption
      await this.client.patch(`/zones/${zoneId}/settings/opportunistic_encryption`, {
        value: 'on'
      });

      return {
        success: true,
        message: 'SSL/TLS certificates activated successfully'
      };
    } catch (error) {
      throw new Error(`Failed to activate SSL: ${error.message}`);
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

  // Add DNS A record pointing to IP address
  async addDNSRecord(zoneId, domainName, ipAddress) {
    try {
      // First, check if A record already exists
      const existingRecords = await this.client.get(`/zones/${zoneId}/dns_records`, {
        params: {
          type: 'A',
          name: domainName
        }
      });

      // Delete existing A records for the domain
      if (existingRecords.data.result && existingRecords.data.result.length > 0) {
        for (const record of existingRecords.data.result) {
          await this.client.delete(`/zones/${zoneId}/dns_records/${record.id}`);
        }
      }

      // Create new A record
      const response = await this.client.post(`/zones/${zoneId}/dns_records`, {
        type: 'A',
        name: domainName,
        content: ipAddress,
        ttl: 1, // Auto TTL
        proxied: true // Enable Cloudflare proxy
      });

      if (response.data.success) {
        return {
          success: true,
          record: response.data.result
        };
      }
      throw new Error('Failed to create DNS record');
    } catch (error) {
      throw new Error(`DNS record creation failed: ${error.message}`);
    }
  }
}

module.exports = CloudflareConfig;
